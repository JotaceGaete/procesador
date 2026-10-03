import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { errorResponse, pickCharacterFields } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const fields = pickCharacterFields(await request.json());
    if ("name" in fields && !fields.name.trim()) {
      return errorResponse(new Error("El personaje necesita un nombre."), 400);
    }
    const { data, error } = await db().from("characters").update(fields).eq("id", id).select("*").single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { error } = await db().from("characters").delete().eq("id", id);
    if (error) throw error;
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
