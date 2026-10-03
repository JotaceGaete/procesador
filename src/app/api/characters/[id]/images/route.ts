import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { getCharacterImages } from "@/lib/assets-server";
import { applyUse, readUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Adds a file the novel already has to this gallery, without uploading or copying
 * it again (new uploads go through /api/novels/{id}/assets). Body: { asset_id, caption?, stage_label? }.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const characterId = assertId((await params).id, "Personaje");
  const body = await readJson(request);
  const assetId = typeof body.asset_id === "string" && UUID.test(body.asset_id) ? body.asset_id : null;
  if (!assetId) throw new HttpError(400, "Archivo inválido");
  const { data: asset, error } = await db().from("assets").select("status").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Archivo no encontrado");
  const use = readUse({ ...body, kind: "character", character_id: characterId });
  return NextResponse.json(await applyUse(use, assetId), { status: 201 });
});

/** New gallery order: the complete list of the character's image ids. */
export const PUT = handler<Ctx>(async (request, { params }) => {
  const characterId = assertId((await params).id, "Personaje");
  const { ids } = await readJson(request);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && UUID.test(x))) throw new HttpError(400, "Orden inválido");
  const { error } = await db().rpc("reorder_character_images", { p_character: characterId, p_ids: ids });
  if (error) throw error;
  return NextResponse.json(await getCharacterImages(characterId));
});
