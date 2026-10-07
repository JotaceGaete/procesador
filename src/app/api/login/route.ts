import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DAYS, createSessionToken, safeEqual } from "@/lib/auth";
import { APP_KEY, assertNotBlocked, failedAttempt, succeededAttempt } from "@/lib/attempts";
import { db } from "@/lib/supabase";
import { errorResponse } from "@/lib/http";

/** Opens a session: a row in app_sessions, and its id signed in the cookie. */
export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "Falta configurar APP_PASSWORD en el servidor." }, { status: 503 });
  }
  try {
    const { password: attempt } = (await request.json().catch(() => ({}))) as { password?: unknown };
    await assertNotBlocked(APP_KEY);
    if (typeof attempt !== "string" || !safeEqual(attempt, password)) await failedAttempt(APP_KEY, "Contraseña incorrecta");
    await succeededAttempt(APP_KEY);

    const purge = await db().rpc("purge_sessions");
    if (purge.error) throw purge.error;
    const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    const { data, error } = await db()
      .from("app_sessions")
      .insert({ expires_at: new Date(expires).toISOString() })
      .select("id")
      .single();
    if (error) throw error;

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, await createSessionToken(password, data.id, expires), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
