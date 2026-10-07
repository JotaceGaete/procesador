import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { readJson } from "@/lib/http";
import { deleteThread, updateThread } from "@/lib/advisor/threads";

type Ctx = { params: Promise<{ id: string }> };

/** Confirm, rename, describe, change kind or status (status: null hands it back to the reading). */
export const PATCH = novelHandler<Ctx>(byChild("story_threads"), async (request, { params }) =>
  NextResponse.json(await updateThread((await params).id, await readJson(request))),
);

export const DELETE = novelHandler<Ctx>(byChild("story_threads"), async (_request, { params }) => {
  await deleteThread((await params).id);
  return new NextResponse(null, { status: 204 });
});
