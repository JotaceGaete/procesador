import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { recheckObservation } from "@/lib/advisor/conversations";

type Ctx = { params: Promise<{ id: string }> };

/** Looks for the observation's quotes again in the current text. No AI. */
export const POST = novelHandler<Ctx>(byChild("advisor_observations"), async (_request, { params }) => NextResponse.json(await recheckObservation((await params).id)));
