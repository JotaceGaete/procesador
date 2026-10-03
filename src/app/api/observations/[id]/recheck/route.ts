import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { recheckObservation } from "@/lib/advisor/conversations";

type Ctx = { params: Promise<{ id: string }> };

/** Looks for the observation's quotes again in the current text. No AI. */
export const POST = handler<Ctx>(async (_request, { params }) => NextResponse.json(await recheckObservation((await params).id)));
