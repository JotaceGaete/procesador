import "server-only";
import { NextResponse } from "next/server";
import { DEV_SESSION_ID, checkSession, readCookie } from "./auth";
import { db } from "./supabase";
import { HttpError, errorResponse } from "./http";

/**
 * Who is asking (docs/privacidad.md). Today: one author, many sessions. With Supabase Auth,
 * `userId` is the account and `authorizeNovel` checks ownership before the novel's lock.
 */
export interface Principal {
  sessionId: string;
  userId: string | null;
  /** Without APP_PASSWORD (development) there is nothing to unlock Procesador with: never locks. */
  appLockEnabled: boolean;
  app: AppStatus;
}

export interface AppStatus {
  locked: boolean;
  idleMinutes: number;
  /** Until Procesador locks for inactivity (server's count; the browser locks at its own). */
  remainingMs: number | null;
}

/** What a novel route receives: the novel the request touches, already authorized. */
export interface NovelAccess {
  principal: Principal;
  /** null: the element named in the request doesn't exist (the route answers its own 404). */
  novelId: string | null;
  protected: boolean;
  lock: NovelLockState;
}

type Params = Record<string, string | undefined>;
type Ctx = { params?: Promise<Params> } | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);

let devSessionReady = false;
async function ensureDevSession() {
  if (devSessionReady) return;
  const { error } = await db()
    .from("app_sessions")
    .upsert({ id: DEV_SESSION_ID, expires_at: "2999-01-01T00:00:00Z", revoked_at: null, app_locked_at: null });
  if (error) throw error;
  devSessionReady = true;
}

interface TouchResult {
  state: "ok" | "locked" | "revoked";
  idle_minutes?: number;
  remaining_ms?: number;
}

export async function touchSession(sessionId: string, touch: boolean): Promise<TouchResult> {
  const { data, error } = await db().rpc("session_touch", { p_session: sessionId, p_touch: touch });
  if (error) throw error;
  return data as TouchResult;
}

const appLocked = () => new HttpError(423, "Procesador está bloqueado.", { code: "app_locked" });

/**
 * The session behind a request: signed cookie, then its row (closed? Procesador locked?).
 * `touch` counts the request as the author's activity.
 */
export async function authenticate(request: Request, opts: { touch: boolean; allowAppLocked?: boolean }): Promise<Principal> {
  const check = await checkSession(readCookie(request));
  if (check.state === "misconfigured") throw new HttpError(503, "Falta configurar APP_PASSWORD en el servidor.");
  if (check.state === "denied") throw new HttpError(401, "No autorizado");
  const appLockEnabled = Boolean(process.env.APP_PASSWORD);
  if (!appLockEnabled) await ensureDevSession();

  let t = await touchSession(check.sessionId, opts.touch);
  if (t.state === "revoked") throw new HttpError(401, "No autorizado");
  if (t.state === "locked" && !appLockEnabled) {
    await db().rpc("session_set_locked", { p_session: check.sessionId, p_locked: false });
    t = await touchSession(check.sessionId, opts.touch);
  }
  const locked = t.state === "locked";
  if (locked && !opts.allowAppLocked) throw appLocked();
  return {
    sessionId: check.sessionId,
    userId: null,
    appLockEnabled,
    app: {
      locked,
      idleMinutes: t.idle_minutes ?? 15,
      remainingMs: appLockEnabled && !locked ? (t.remaining_ms ?? null) : null,
    },
  };
}

type Handler<C> = (request: Request, ctx: C) => Promise<Response>;

/**
 * Routes that touch no novel (the library, settings, the session itself). Session first,
 * then errors turned into JSON. With `allowAppLocked`, it also answers while Procesador is
 * locked: only the session's own routes (status, unlock).
 */
export function handler<C>(
  fn: (request: Request, ctx: C, principal: Principal) => Promise<Response>,
  opts: { allowAppLocked?: boolean; touch?: boolean } = {},
): Handler<C> {
  return async (request, ctx) => {
    try {
      const principal = await authenticate(request, { touch: opts.touch ?? true, allowAppLocked: opts.allowAppLocked });
      return await fn(request, ctx, principal);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// ---------------------------------------------------------------------------
// Novels: every route that reads or changes anything of a novel goes through novelHandler.
// tests/unit/routes.test.ts fails if one doesn't.
// ---------------------------------------------------------------------------

/** How a route finds the novel it touches. null: nothing by that id (the route then answers 404). */
export type NovelResolver = (request: Request, params: Params) => Promise<string | null>;

/** The novel's id is in the path: /api/novels/[id]/… */
export const byParam =
  (name = "id"): NovelResolver =>
  async (_request, params) =>
    validId(params[name]);

/** An element of a novel is in the path: its row says which novel (read before anything else). */
export const byChild =
  (table: string | ((params: Params) => string | undefined), name = "id"): NovelResolver =>
  async (_request, params) => {
    const id = validId(params[name]);
    const from = typeof table === "function" ? table(params) : table;
    if (!id || !from) return null;
    const { data, error } = await db().from(from).select("novel_id").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data?.novel_id as string | undefined) ?? null;
  };

/** The novel's id is in the JSON body (the route still reads the body itself). */
export const byBody =
  (field = "novelId"): NovelResolver =>
  async (request) => {
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    return validId(body && typeof body === "object" ? (body as Record<string, unknown>)[field] : null);
  };

export interface NovelLockState {
  state: "open" | "unlocked" | "locked";
  kind?: "pin" | "password";
  hide_title?: boolean;
  /** Only while locked, and only if not hidden: what the unlock screen shows. */
  title?: string | null;
  idle_minutes?: number;
  lock_on_hide?: boolean;
  remaining_ms?: number;
}

/** The novel's state in this session, as the browser sees it (no title, no secret). */
export function novelStatus(id: string, lock: NovelLockState) {
  return {
    id,
    protected: lock.state !== "open",
    locked: lock.state === "locked",
    kind: lock.kind ?? null,
    hideTitle: lock.hide_title ?? false,
    title: lock.state === "locked" ? (lock.title ?? null) : undefined,
    idleMinutes: lock.idle_minutes ?? null,
    lockOnHide: lock.lock_on_hide ?? false,
    remainingMs: lock.state === "unlocked" ? (lock.remaining_ms ?? null) : null,
  };
}

/** 423 for a locked novel: only what its unlock screen shows. */
export function novelLocked(id: string, lock: NovelLockState) {
  return new HttpError(423, "Esta novela está protegida y bloqueada.", {
    code: "novel_locked",
    novel: { id, title: lock.hide_title ? null : (lock.title ?? null), kind: lock.kind ?? "pin" },
  });
}

/**
 * The one authorization check for a novel's data (docs/privacidad.md). Today: the session
 * may use it unless the novel is protected and not unlocked in this session. With Supabase
 * Auth, ownership is checked here first (404 for someone else's novel).
 */
export async function authorizeNovel(principal: Principal, novelId: string, opts: { touch: boolean }): Promise<NovelLockState> {
  const { data, error } = await db().rpc("novel_access", { p_session: principal.sessionId, p_novel: novelId, p_touch: opts.touch });
  if (error) throw error;
  return data as NovelLockState;
}

/**
 * Every novel route: session (Procesador not locked), the novel the request touches, and
 * `authorizeNovel` before the route runs: a locked novel answers 423 and the route never
 * runs. `allowLocked` only for the routes that unlock, lock or recover the novel itself.
 */
export function novelHandler<C>(
  resolve: NovelResolver,
  fn: (request: Request, ctx: C, access: NovelAccess) => Promise<Response>,
  opts: { allowLocked?: boolean } = {},
): Handler<C> {
  return handler<C>(async (request, ctx, principal) => {
    const params = ((await (ctx as Ctx)?.params) ?? {}) as Params;
    const novelId = await resolve(request, params);
    let lock: NovelLockState = { state: "open" };
    if (novelId) {
      lock = await authorizeNovel(principal, novelId, { touch: true });
      if (lock.state === "locked" && !opts.allowLocked) throw novelLocked(novelId, lock);
    }
    return fn(request, ctx, { principal, novelId, protected: lock.state !== "open", lock });
  });
}

/** The session's state for the browser (GET /api/session and the ping). */
export function appStatus(principal: Principal) {
  return { enabled: principal.appLockEnabled, ...principal.app };
}

export const noStore = { "Cache-Control": "no-store" };

/** Lock answers also drop the browser's cache of private images (as logout does). */
export function lockedResponse(body: unknown) {
  return NextResponse.json(body, { headers: { ...noStore, "Clear-Site-Data": '"cache"' } });
}
