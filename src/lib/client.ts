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
  if (res.status === 401) {
    window.location.href = "/login";
    throw new ApiError(401, "Sesión expirada");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
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
  novel?: { id: string; title: string | null };
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

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
