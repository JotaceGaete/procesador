// The session token. Used by the proxy and by route handlers, so it only relies on Web Crypto.
// What a session may do (Procesador or a novel locked) is decided in lib/access.ts.

export const SESSION_COOKIE = "procesador_session";
export const SESSION_DAYS = 30;

/**
 * Without APP_PASSWORD (local development only) there is no login: every request is this
 * one session, so novel protection still has a session to unlock in.
 */
export const DEV_SESSION_ID = "00000000-0000-4000-8000-000000000001";

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Token `<session id>.<expiry>.<hmac>`, signed with the password: changing APP_PASSWORD
 * revokes every session. The id names the row in app_sessions, which logout revokes.
 */
export async function createSessionToken(password: string, sessionId: string, expires: number): Promise<string> {
  return `${sessionId}.${expires}.${await hmac(password, `session:${sessionId}:${expires}`)}`;
}

export type SessionCheck = { state: "ok"; sessionId: string } | { state: "denied" } | { state: "misconfigured" };

/** The signature and expiry only (no database): enough for the proxy. */
export async function checkSession(token: string | undefined): Promise<SessionCheck> {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    // Open only for local development. A deploy without a password fails closed.
    return process.env.NODE_ENV === "production" ? { state: "misconfigured" } : { state: "ok", sessionId: DEV_SESSION_ID };
  }
  const [sessionId, expires, sig, extra] = token?.split(".") ?? [];
  if (extra !== undefined || !sessionId || !UUID.test(sessionId) || !expires || !sig || !(Number(expires) > Date.now())) {
    return { state: "denied" };
  }
  return safeEqual(sig, await hmac(password, `session:${sessionId}:${expires}`)) ? { state: "ok", sessionId } : { state: "denied" };
}

export function readCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return match?.slice(SESSION_COOKIE.length + 1);
}
