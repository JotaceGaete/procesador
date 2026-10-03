import { NextResponse } from "next/server";
import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse, pickCharacterFields } from "@/lib/http";
import { MAX_CHARACTERS } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const fields = pickCharacterFields(await request.json());
    if (!fields.name?.trim()) return errorResponse(new Error("El personaje necesita un nombre."), 400);

    const project = await getActiveProject();
    const { count, error: countError } = await db()
      .from("characters")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id);
    if (countError) throw countError;
    if ((count ?? 0) >= MAX_CHARACTERS) {
      return errorResponse(new Error(`Máximo ${MAX_CHARACTERS} personajes por proyecto.`), 400);
    }

    const { data, error } = await db()
      .from("characters")
      .insert({ ...fields, project_id: project.id })
      .select("*")
      .single();
    if (error) throw error;
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
