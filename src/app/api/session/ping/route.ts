import { NextResponse } from "next/server";
import { appStatus, authorizeNovel, handler, noStore, novelStatus } from "@/lib/access";
import { readJson } from "@/lib/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The author is here (keys, pointer, scroll, touch; at most once a minute): counts as
 * activity for Procesador and, with { novelId }, for that protected novel, so neither locks
 * while someone reads without saving anything. A locked novel stays locked.
 */
export const POST = handler(async (request, _ctx, principal) => {
  const { novelId } = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  const novel =
    typeof novelId === "string" && UUID.test(novelId)
      ? novelStatus(novelId, await authorizeNovel(principal, novelId, { touch: true }))
      : undefined;
  return NextResponse.json({ app: appStatus(principal), novel }, { headers: noStore });
});
