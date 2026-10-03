import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { mergeThreads } from "@/lib/advisor/threads";

type Ctx = { params: Promise<{ id: string }> };

/** Merges this thread into `into`. */
export const POST = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  return NextResponse.json(await mergeThreads((await params).id, String(body.into ?? "")));
});
