import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { readingState } from "@/lib/advisor/reading";

type Ctx = { params: Promise<{ id: string }> };

/** The Consejero's reading: each chapter's digest and freshness, threads and global summary. No AI. */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) =>
  NextResponse.json(await readingState((await params).id), { headers: { "Cache-Control": "no-store" } }),
);
