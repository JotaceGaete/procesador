import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { setObservationStatus } from "@/lib/advisor/conversations";

type Ctx = { params: Promise<{ id: string }> };

/** Guardar (saved), Descartar (dismissed), Resuelta (resolved) or back to new. */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  return NextResponse.json(await setObservationStatus((await params).id, body.status));
});
