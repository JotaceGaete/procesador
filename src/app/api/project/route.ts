import { NextResponse } from "next/server";
import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse, HttpError, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/auth";
import { availableProviders, defaultProvider } from "@/lib/ai/providers";

export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const project = await getActiveProject();
    const { data: characters, error } = await db()
      .from("characters")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json(
      { project, characters, providers: availableProviders(), defaultProvider: defaultProvider() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Saves the text or the metadata. Text saves carry the revision the client last
 * saw: if the text changed elsewhere (another tab or device), nothing is written
 * and the response is 409, so newer text is never silently overwritten.
 */
export async function PATCH(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;
  try {
    const body = await readJson(request);
    const update: Record<string, string> = {};
    for (const key of ["title", "synopsis", "style_notes", "content"]) {
      if (typeof body[key] === "string") update[key] = body[key] as string;
    }
    if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");

    let query = db().from("projects").update(update).eq("singleton", true);
    if ("content" in update) {
      if (typeof body.revision !== "number") throw new HttpError(400, "Falta la revisión");
      query = query.eq("revision", body.revision);
    }
    const { data, error } = await query.select("revision, updated_at").maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "El texto se modificó en otra pestaña o dispositivo." }, { status: 409 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
