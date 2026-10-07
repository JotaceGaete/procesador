import { NextResponse } from "next/server";
import { authorizeNovel, byParam, noStore, novelHandler, novelStatus } from "@/lib/access";
import { assertNotBlocked, failedAttempt, novelKey, succeededAttempt } from "@/lib/attempts";
import { getProtection } from "@/lib/protection";
import { verifySecret } from "@/lib/secret";
import { db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** Unlocks a protected novel in this session with its PIN or password (checked here, never stored). */
export const POST = novelHandler<Ctx>(
  byParam(),
  async (request, _ctx, { principal, novelId, lock }) => {
    if (!novelId) throw new HttpError(404, "Novela no encontrada");
    if (lock.state === "open" || lock.state === "unlocked") return NextResponse.json({ novel: novelStatus(novelId, lock) }, { headers: noStore });
    const { secret } = await readJson(request);
    const key = novelKey(novelId);
    await assertNotBlocked(key);
    const stored = await getProtection(novelId);
    if (!stored || !(await verifySecret(secret, stored.secret_hash))) {
      await failedAttempt(key, stored?.secret_kind === "password" ? "Contraseña incorrecta" : "PIN incorrecto");
    }
    await succeededAttempt(key);
    const { error } = await db().rpc("novel_unlock", { p_session: principal.sessionId, p_novel: novelId });
    if (error) throw error;
    return NextResponse.json({ novel: novelStatus(novelId, await authorizeNovel(principal, novelId, { touch: false })) }, { headers: noStore });
  },
  { allowLocked: true },
);
