import { NextResponse } from "next/server";
import { appStatus, handler, lockedResponse } from "@/lib/access";
import { db } from "@/lib/supabase";

/** «Bloquear Procesador», or the browser's own count reaching the end: from now on only APP_PASSWORD opens it. */
export const POST = handler(
  async (_request, _ctx, principal) => {
    if (!principal.appLockEnabled) {
      return NextResponse.json({ error: "Sin APP_PASSWORD no hay con qué desbloquear Procesador." }, { status: 400 });
    }
    const { error } = await db().rpc("session_set_locked", { p_session: principal.sessionId, p_locked: true });
    if (error) throw error;
    return lockedResponse({ app: { ...appStatus(principal), locked: true, remainingMs: null } });
  },
  { allowAppLocked: true, touch: false },
);
