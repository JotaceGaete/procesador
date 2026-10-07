"use client";

/** fetch wrapper for our API: JSON in/out, and back to /login if the session expired. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Sin conexión con el servidor.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  // A wrong PIN or password is a 401 too, but the session is still there.
  if (res.status === 401 && data?.code !== "wrong_credential") {
    window.location.href = "/login";
    throw new ApiError(401, "Sesión expirada");
  }
  if (res.status === 423) announceLock(data);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Error ${res.status}`);
  return data as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Locks (docs/privacidad.md): a 423 from any request means Procesador or a novel is locked
// on the server. The LockProvider listens, unmounts what was open and shows the lock screen.
// ---------------------------------------------------------------------------

export const LOCK_EVENT = "procesador:locked";

export interface LockDetail {
  scope: "app" | "novel";
  novel?: { id: string; title: string | null; kind?: "pin" | "password" };
}

function announceLock(data: unknown) {
  const body = (data ?? {}) as { code?: string; novel?: LockDetail["novel"] };
  const detail: LockDetail = body.code === "novel_locked" ? { scope: "novel", novel: body.novel } : { scope: "app" };
  window.dispatchEvent(new CustomEvent<LockDetail>(LOCK_EVENT, { detail }));
}

/** For the requests that use fetch directly (streams, keepalive): a 423 still locks. */
export async function noticeLock(res: Response) {
  if (res.status === 423) announceLock(await res.clone().json().catch(() => null));
}

const tracked = new Set<AbortController>();

/** A request that must stop when something locks (the components' own abort on unmount covers the rest). */
export function trackRequest(controller = new AbortController()) {
  tracked.add(controller);
  controller.signal.addEventListener("abort", () => tracked.delete(controller), { once: true });
  return controller;
}

export function abortTrackedRequests() {
  for (const c of [...tracked]) c.abort();
}

// ---------------------------------------------------------------------------
// Preferences (localStorage). Nothing written by a protected novel's author stays here: its
// scene argument and its open conversation are neither read nor written (docs/privacidad.md).
// ---------------------------------------------------------------------------

/** Keys that hold what the author wrote (or point to it) for one novel. */
const DRAFT_KEYS = ["argument:", "conversation:"];
const protectedNovels = new Set<string>();

const isProtectedDraft = (key: string) => DRAFT_KEYS.some((p) => key.startsWith(p) && protectedNovels.has(key.slice(p.length)));

/** A protected novel: its drafts are forgotten now and never stored again in this tab. */
export function markProtected(novelId: string, isProtected: boolean) {
  if (isProtected) {
    protectedNovels.add(novelId);
    forgetNovelDrafts(novelId);
  } else protectedNovels.delete(novelId);
}

export function forgetNovelDrafts(novelId: string) {
  try {
    for (const p of DRAFT_KEYS) localStorage.removeItem(`${p}${novelId}`);
  } catch {}
}

export function readPref(key: string): string | null {
  if (isProtectedDraft(key)) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  if (isProtectedDraft(key)) return;
  try {
    localStorage.setItem(key, value);
  } catch {}
}
