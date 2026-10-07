import { NextResponse } from "next/server";
import { appStatus, handler, noStore } from "@/lib/access";

/**
 * The session's state, without counting as activity: whether Procesador is locked and how
 * long until it locks. Answers while locked too (that is how the browser learns it).
 */
export const GET = handler(async (_request, _ctx, principal) => NextResponse.json({ app: appStatus(principal) }, { headers: noStore }), {
  allowAppLocked: true,
  touch: false,
});
