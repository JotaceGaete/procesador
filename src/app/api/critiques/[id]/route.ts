import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { deleteCritique, respondToCritique } from "@/lib/critic/evaluate";

type Ctx = { params: Promise<{ id: string }> };

/** The author's answer to a report (de acuerdo / en desacuerdo, a note). Never the scores or the verdict. */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  await respondToCritique((await params).id, { response: body.response, note: body.note });
  return new NextResponse(null, { status: 204 });
});

export const DELETE = handler<Ctx>(async (_request, { params }) => {
  await deleteCritique((await params).id);
  return new NextResponse(null, { status: 204 });
});
