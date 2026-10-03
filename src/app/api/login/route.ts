import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DAYS, createSessionToken, safeEqual } from "@/lib/auth";

const FAILED_LOGIN_DELAY_MS = 1000;

export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "Falta configurar APP_PASSWORD en el servidor." }, { status: 503 });
  }
  const { password: attempt } = (await request.json().catch(() => ({}))) as { password?: unknown };
  if (typeof attempt !== "string" || !safeEqual(attempt, password)) {
    // Slows down guessing. Serverless instances don't share memory, so this is not a real rate limit.
    await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(password), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return res;
}
