import { NextResponse } from "next/server";
import { appStatus, handler, noStore } from "@/lib/access";

/**
 * The author is here (keys, pointer, scroll, touch; at most once a minute): counts as
 * activity, so Procesador doesn't lock while someone reads without saving anything.
 */
export const POST = handler(async (_request, _ctx, principal) => NextResponse.json({ app: appStatus(principal) }, { headers: noStore }));
