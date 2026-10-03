import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { readingState } from "@/lib/advisor/reading";

type Ctx = { params: Promise<{ id: string }> };

/** The Consejero's reading: each chapter's digest and freshness, threads and global summary. No AI. */
export const GET = handler<Ctx>(async (_request, { params }) =>
  NextResponse.json(await readingState((await params).id), { headers: { "Cache-Control": "no-store" } }),
);
