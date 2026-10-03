import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { errorResponse, HttpError, pickCharacterFields, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f-]{36}$/i;

async function characterId(params: Ctx["params"]) {
  const { id } = await params;
  if (!UUID.test(id)) throw new HttpError(404, "Personaje no encontrado");
  return id;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const id = await characterId(params);
    const fields = pickCharacterFields(await readJson(request));
    if ("name" in fields && !fields.name.trim()) throw new HttpError(400, "El personaje necesita un nombre.");
    const { data, error } = await db().from("characters").update(fields).eq("id", id).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "Personaje no encontrado");
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const id = await characterId(params);
    const { error } = await db().from("characters").delete().eq("id", id);
    if (error) throw error;
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
