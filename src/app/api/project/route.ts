import { NextResponse } from "next/server";
import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse } from "@/lib/http";
import { availableProviders, defaultProvider } from "@/lib/ai/providers";

export async function GET() {
  try {
    const project = await getActiveProject();
    const { data: characters, error } = await db()
      .from("characters")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({
      project,
      characters,
      providers: availableProviders(),
      defaultProvider: defaultProvider(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const update: Record<string, string> = {};
    for (const key of ["title", "synopsis", "style_notes", "content"]) {
      if (typeof body[key] === "string") update[key] = body[key] as string;
    }
    const project = await getActiveProject();
    const { data, error } = await db().from("projects").update(update).eq("id", project.id).select("updated_at").single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
