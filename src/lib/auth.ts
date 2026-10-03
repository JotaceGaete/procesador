// Used by the proxy and by route handlers, so it only relies on Web Crypto.
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "procesador_session";
export const SESSION_DAYS = 30;

const encoder = new TextEncoder();

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

/** Token `<expiry>.<hmac>`, signed with the password: changing APP_PASSWORD revokes every session. */
export async function createSessionToken(password: string): Promise<string> {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${expires}.${await hmac(password, `session:${expires}`)}`;
}

type AuthState = "ok" | "denied" | "misconfigured";

export async function checkSession(token: string | undefined): Promise<AuthState> {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    // Open only for local development. A deploy without a password fails closed.
    return process.env.NODE_ENV === "production" ? "misconfigured" : "ok";
  }
  const [expires, sig] = token?.split(".") ?? [];
  if (!expires || !sig || Number(expires) < Date.now()) return "denied";
  return safeEqual(sig, await hmac(password, `session:${expires}`)) ? "ok" : "denied";
}

function readCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return match?.slice(SESSION_COOKIE.length + 1);
}

/** Defense in depth for API routes: returns an error response, or null when authorized. */
export async function requireAuth(request: Request): Promise<NextResponse | null> {
  const state = await checkSession(readCookie(request));
  if (state === "ok") return null;
  if (state === "misconfigured") {
    return NextResponse.json({ error: "Falta configurar APP_PASSWORD en el servidor." }, { status: 503 });
  }
  return NextResponse.json({ error: "No autorizado" }, { status: 401 });
}

type Handler<C> = (request: Request, ctx: C) => Promise<Response>;

/** Every API route goes through this: session check first, then errors turned into JSON. */
export function handler<C>(fn: Handler<C>): Handler<C> {
  return async (request, ctx) => {
    const denied = await requireAuth(request);
    if (denied) return denied;
    try {
      return await fn(request, ctx);
    } catch (e) {
      const { errorResponse } = await import("./http");
      return errorResponse(e);
    }
  };
}
