import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { readJson } from "@/lib/http";
import { mergeThreads } from "@/lib/advisor/threads";

type Ctx = { params: Promise<{ id: string }> };

/** Merges this thread into `into`. */
export const POST = novelHandler<Ctx>(byChild("story_threads"), async (request, { params }) => {
  const body = await readJson(request);
  return NextResponse.json(await mergeThreads((await params).id, String(body.into ?? "")));
});
