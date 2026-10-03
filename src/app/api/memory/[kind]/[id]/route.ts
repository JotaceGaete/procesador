import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, pickFields, readJson } from "@/lib/http";
import { isMemoryKind, MEMORY_KINDS } from "@/lib/memory";
import { readCharacterIds, setFactCharacters } from "@/lib/memory-server";
import { deleteUnusedAssets } from "@/lib/assets-server";

type Ctx = { params: Promise<{ kind: string; id: string }> };

async function target(params: Ctx["params"]) {
  const { kind, id } = await params;
  if (!isMemoryKind(kind)) throw new HttpError(404, "Tipo de memoria desconocido");
  return { kind, id: assertId(id), config: MEMORY_KINDS[kind] };
}

/** novel_id is never accepted from the client, so an item can't move to another novel. */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const { kind, id, config } = await target(params);
  const body = await readJson(request);
  const fields = pickFields(body, config.fields, config.nullable);
  if (config.required in fields && !fields[config.required]?.trim()) throw new HttpError(400, config.label);
  const characterIds = kind === "facts" ? readCharacterIds(body.character_ids) : undefined;
  if (!Object.keys(fields).length && !characterIds) throw new HttpError(400, "Nada que guardar");

  const query = Object.keys(fields).length
    ? db().from(config.table).update(fields).eq("id", id).select("*").maybeSingle()
    : db().from(config.table).select("*").eq("id", id).maybeSingle();
  const { data, error } = await query;
  if (error) throw error;
  if (!data) throw new HttpError(404, "Elemento no encontrado");

  if (kind === "facts") {
    if (characterIds) await setFactCharacters(id, data.novel_id, characterIds);
    const { data: links, error: linkError } = await db().from("fact_characters").select("character_id").eq("fact_id", id);
    if (linkError) throw linkError;
    return NextResponse.json({ ...data, character_ids: links.map((l) => l.character_id) });
  }
  return NextResponse.json(data);
});

export const DELETE = handler<Ctx>(async (request, { params }) => {
  const { kind, id, config } = await target(params);
  // A character's gallery goes with it (cascade). Its files are deleted afterwards
  // only if nothing else uses them.
  let assetIds: string[] = [];
  if (kind === "characters") {
    const { data, error } = await db().from("character_images").select("asset_id").eq("character_id", id);
    if (error) throw error;
    assetIds = data.map((r) => r.asset_id);
  }
  const { error } = await db().from(config.table).delete().eq("id", id);
  if (error) throw error;
  await deleteUnusedAssets(assetIds);
  return new NextResponse(null, { status: 204 });
});
