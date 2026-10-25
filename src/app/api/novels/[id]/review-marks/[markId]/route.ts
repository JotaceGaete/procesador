import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; markId: string }> };
async function markIds(params: Ctx["params"]) {
  const p = await params;
  return { novelId: assertId(p.id, "Novela"), markId: assertId(p.markId, "Marca") };
}

export const PATCH = handler<Ctx>(async (request, { params }) => {
  const { novelId, markId } = await markIds(params);
  const body = await readJson(request);
  if (typeof body.status !== "string" || !["pending", "resolved"].includes(body.status)) throw new HttpError(400, "Estado inválido");
  const { data, error } = await db().from("review_marks").update({
    status: body.status, resolved_at: body.status === "resolved" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("novel_id", novelId).eq("id", markId).select("id,status,resolved_at").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Marca no encontrada");
  return NextResponse.json(data);
});

export const DELETE = handler<Ctx>(async (_request, { params }) => {
  const { novelId, markId } = await markIds(params);
  const { data, error } = await db().from("review_marks").delete().eq("novel_id", novelId).eq("id", markId).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Marca no encontrada");
  return NextResponse.json({ ok: true });
});
