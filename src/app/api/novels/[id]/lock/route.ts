import { authorizeNovel, byParam, lockedResponse, novelHandler, novelStatus } from "@/lib/access";
import { db } from "@/lib/supabase";
import { HttpError } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** «Bloquear novela» (or the idle time, or leaving the tab if the author chose so): this session's unlock is gone. */
export const POST = novelHandler<Ctx>(
  byParam(),
  async (_request, _ctx, { principal, novelId }) => {
    if (!novelId) throw new HttpError(404, "Novela no encontrada");
    const { error } = await db().from("novel_unlocks").delete().eq("session_id", principal.sessionId).eq("novel_id", novelId);
    if (error) throw error;
    // The state now (locked, with what its lock screen shows), from the same check as every route.
    return lockedResponse({ novel: novelStatus(novelId, await authorizeNovel(principal, novelId, { touch: false })) });
  },
  { allowLocked: true },
);
