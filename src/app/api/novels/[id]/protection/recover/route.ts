import { NextResponse } from "next/server";
import { authorizeNovel, byParam, noStore, novelHandler, novelStatus } from "@/lib/access";
import { safeEqual } from "@/lib/auth";
import { APP_KEY, assertNotBlocked, failedAttempt, novelKey, succeededAttempt } from "@/lib/attempts";
import { protect } from "@/lib/protection";
import { validateSecret } from "@/lib/secret";
import { db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * «Olvidé el PIN»: with Procesador's password (APP_PASSWORD), remove the protection or set a
 * new PIN. Someone who finds Procesador open has the session, not the password. With
 * Supabase Auth this becomes the account's re-authentication.
 * Body: { appPassword, action: "remove" | "reset", kind?, secret? }.
 */
export const POST = novelHandler<Ctx>(
  byParam(),
  async (request, _ctx, { principal, novelId, protected: isProtected }) => {
    if (!novelId) throw new HttpError(404, "Novela no encontrada");
    const expected = process.env.APP_PASSWORD;
    if (!expected) throw new HttpError(400, "Sin APP_PASSWORD no hay con qué recuperar la novela.");
    const body = await readJson(request);
    const action = body.action;
    if (action !== "remove" && action !== "reset") throw new HttpError(400, "Elige quitar la protección o un PIN nuevo.");
    const next = action === "reset" ? validateSecret(body.kind, body.secret) : null;
    await assertNotBlocked(APP_KEY);
    if (typeof body.appPassword !== "string" || !safeEqual(body.appPassword, expected)) {
      await failedAttempt(APP_KEY, "La contraseña de Procesador no es correcta.");
    }
    await succeededAttempt(APP_KEY);
    if (!isProtected) throw new HttpError(400, "Esta novela no está protegida.");
    await succeededAttempt(novelKey(novelId));
    if (next) await protect(principal.sessionId, novelId, next.kind, next.secret);
    else {
      const { error } = await db().rpc("novel_unprotect", { p_novel: novelId });
      if (error) throw error;
    }
    return NextResponse.json({ novel: novelStatus(novelId, await authorizeNovel(principal, novelId, { touch: false })) }, { headers: noStore });
  },
  { allowLocked: true },
);
