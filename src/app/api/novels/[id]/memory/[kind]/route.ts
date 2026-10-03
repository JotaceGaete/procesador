import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getNovel } from "@/lib/supabase";
import { HttpError, pickFields, readJson } from "@/lib/http";
import { isMemoryKind, MAX_CHARACTERS, MEMORY_KINDS } from "@/lib/memory";
import { readCharacterIds, setFactCharacters } from "@/lib/memory-server";

type Ctx = { params: Promise<{ id: string; kind: string }> };

/** Adds a character, relationship, place or fact to one novel. */
export const POST = handler<Ctx>(async (request, { params }) => {
  const { id, kind } = await params;
  if (!isMemoryKind(kind)) throw new HttpError(404, "Tipo de memoria desconocido");
  const config = MEMORY_KINDS[kind];
  const novel = await getNovel(id);
  const body = await readJson(request);
  const fields = pickFields(body, config.fields, config.nullable);
  if (!fields[config.required]?.trim()) throw new HttpError(400, config.label);
  if ("status" in fields && !["approved", "suggested"].includes(String(fields.status))) throw new HttpError(400, "Estado de hecho desconocido.");

  if (kind === "characters") {
    const { count, error } = await db().from("characters").select("id", { count: "exact", head: true }).eq("novel_id", novel.id);
    if (error) throw error;
    if ((count ?? 0) >= MAX_CHARACTERS) throw new HttpError(400, `Máximo ${MAX_CHARACTERS} personajes por novela.`);
  }
  const characterIds = kind === "facts" ? (readCharacterIds(body.character_ids) ?? []) : undefined;

  const { data, error } = await db()
    .from(config.table)
    .insert({ ...fields, novel_id: novel.id })
    .select("*")
    .single();
  if (error) throw error;

  if (characterIds) {
    try {
      await setFactCharacters(data.id, novel.id, characterIds);
    } catch (e) {
      await db().from("facts").delete().eq("id", data.id);
      throw e;
    }
    return NextResponse.json({ ...data, character_ids: characterIds }, { status: 201 });
  }
  return NextResponse.json(data, { status: 201 });
});
