import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { getNovel } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import { listObservations } from "@/lib/advisor/conversations";
import type { ObservationStatus } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** Observations by status (saved by default), each with the chapters that changed since. */
export const GET = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const status = new URL(request.url).searchParams.get("status") ?? "saved";
  if (!["new", "saved", "dismissed", "resolved"].includes(status)) throw new HttpError(400, "Estado desconocido.");
  return NextResponse.json(await listObservations(novel.id, status as ObservationStatus), {
    headers: { "Cache-Control": "no-store" },
  });
});
