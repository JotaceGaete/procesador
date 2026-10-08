import { NextResponse } from "next/server";
import { appStatus, authorizeNovel, handler, noStore, novelStatus } from "@/lib/access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session's state, without counting as activity: whether Procesador is locked and how
 * long until it locks, and with ?novelId= that novel's (protected? locked here? how long?).
 * Answers while Procesador is locked too (that is how the browser learns it), but then says
 * nothing about any novel.
 */
export const GET = handler(
  async (request, _ctx, principal) => {
    const novelId = new URL(request.url).searchParams.get("novelId");
    const novel =
      novelId && UUID.test(novelId) && !principal.app.locked
        ? novelStatus(novelId, await authorizeNovel(principal, novelId, { touch: false }))
        : undefined;
    return NextResponse.json({ app: appStatus(principal), novel }, { headers: noStore });
  },
  { allowAppLocked: true, touch: false },
);
