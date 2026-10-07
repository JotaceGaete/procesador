import { NextResponse } from "next/server";
import { appStatus, handler, noStore, touchSession } from "@/lib/access";
import { safeEqual } from "@/lib/auth";
import { APP_KEY, assertNotBlocked, failedAttempt, succeededAttempt } from "@/lib/attempts";
import { db } from "@/lib/supabase";
import { readJson } from "@/lib/http";

/** Unlocks Procesador in this session with APP_PASSWORD (counted with the logins' attempts). */
export const POST = handler(
  async (request, _ctx, principal) => {
    const { password } = await readJson(request);
    const expected = process.env.APP_PASSWORD;
    if (!expected) return NextResponse.json({ app: appStatus(principal) }, { headers: noStore });
    await assertNotBlocked(APP_KEY);
    if (typeof password !== "string" || !safeEqual(password, expected)) await failedAttempt(APP_KEY, "Contraseña incorrecta");
    await succeededAttempt(APP_KEY);
    const { error } = await db().rpc("session_set_locked", { p_session: principal.sessionId, p_locked: false });
    if (error) throw error;
    const t = await touchSession(principal.sessionId, false);
    return NextResponse.json(
      { app: { ...appStatus(principal), locked: false, remainingMs: t.remaining_ms ?? null } },
      { headers: noStore },
    );
  },
  { allowAppLocked: true, touch: false },
);
