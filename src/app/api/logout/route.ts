import { NextResponse } from "next/server";
import { SESSION_COOKIE, checkSession, readCookie } from "@/lib/auth";
import { db } from "@/lib/supabase";

/**
 * Closes the session for good: its row is revoked (a copy of the cookie stops working) and,
 * with it, every novel unlocked in it. Works even while Procesador is locked.
 */
export async function POST(request: Request) {
  const check = await checkSession(readCookie(request));
  if (check.state === "ok" && process.env.APP_PASSWORD) {
    const { error } = await db().rpc("session_revoke", { p_session: check.sessionId });
    if (error) console.error("[logout]", error.message);
  }
  // Clear-Site-Data also drops cached private images.
  const res = NextResponse.json({ ok: true }, { headers: { "Clear-Site-Data": '"cache"' } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
