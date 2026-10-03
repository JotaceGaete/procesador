import { NextResponse } from "next/server";
import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse, HttpError, pickCharacterFields, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/auth";
import { MAX_CHARACTERS } from "@/lib/types";

export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const fields = pickCharacterFields(await readJson(request));
    if (!fields.name?.trim()) throw new HttpError(400, "El personaje necesita un nombre.");

    const project = await getActiveProject("id");
    const { count, error: countError } = await db()
      .from("characters")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id);
    if (countError) throw countError;
    if ((count ?? 0) >= MAX_CHARACTERS) throw new HttpError(400, `Máximo ${MAX_CHARACTERS} personajes por proyecto.`);

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
