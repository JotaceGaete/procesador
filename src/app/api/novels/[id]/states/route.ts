import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import type { StateRow } from "@/lib/narrative-state";

type Ctx = { params: Promise<{ id: string }> };

const COLUMNS = "id, character_id, chapter_id, alive, location, knows, physical, objects, status";
const LIMITS = { location: 300, knows: 1000, physical: 500, objects: 500 } as const;

/** Los estados narrativos de la novela (docs/estado-narrativo.md). */
export const GET = handler<Ctx>(async (_request, { params }) => {
  const novel = await getNovel(assertId((await params).id, "Novela"));
  const { data, error } = await db().from("character_states").select(COLUMNS).eq("novel_id", novel.id);
  if (error) throw error;
  return NextResponse.json(data ?? []);
});

/**
 * Guarda el estado de un personaje al terminar un capítulo. El autor lo escribe, así que se
 * guarda como aprobado: sólo los aprobados cuentan como memoria. Un estado ya existente se
 * reemplaza. La clave compuesta impide mezclar personajes o capítulos de otra novela.
 */
export const PUT = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel(assertId((await params).id, "Novela"));
  const body = await readJson(request);
  const character_id = assertId(body.character_id, "Personaje");
  const chapter_id = assertId(body.chapter_id, "Capítulo");
  const status = body.status === "suggested" ? "suggested" : "approved";
  const text = {} as Record<keyof typeof LIMITS, string>;
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (value.length > max) throw new HttpError(400, `El campo ${key} admite hasta ${max} caracteres.`);
    text[key as keyof typeof LIMITS] = value;
  }
  const row = {
    novel_id: novel.id,
    character_id,
    chapter_id,
    alive: body.alive !== false,
    ...text,
    status,
  };
  const { data, error } = await db()
    .from("character_states")
    .upsert(row, { onConflict: "novel_id,character_id,chapter_id" })
    .select(COLUMNS)
    .single();
  if (error) {
    // 23503: el personaje o el capítulo no pertenecen a esta novela.
    if (error.code === "23503") throw new HttpError(400, "El personaje o el capítulo no pertenecen a esta novela.");
    throw error;
  }
  return NextResponse.json(data as StateRow);
});

/** Borra el estado de un personaje en un capítulo. */
export const DELETE = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel(assertId((await params).id, "Novela"));
  const body = await readJson(request);
  const character_id = assertId(body.character_id, "Personaje");
  const chapter_id = assertId(body.chapter_id, "Capítulo");
  const { error } = await db()
    .from("character_states")
    .delete()
    .eq("novel_id", novel.id)
    .eq("character_id", character_id)
    .eq("chapter_id", chapter_id);
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
