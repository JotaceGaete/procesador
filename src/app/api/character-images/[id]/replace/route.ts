import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { applyUse, readUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Replaces a gallery image's file with one the novel already has (found by the
 * upload's duplicate check), without uploading anything. New files go through
 * the upload with `use: { kind: "replace", … }`. Body: { asset_id, scope: "use" | "all" }.
 * Returns the whole novel's gallery and manuscript images ({ images, manuscriptImages }):
 * with scope "all", images of the book that shared the file change too.
 */
export const POST = novelHandler<Ctx>(byChild("character_images"), async (request, { params }, { novelId }) => {
  const imageId = assertId((await params).id, "Imagen");
  const body = await readJson(request);
  const assetId = assertId(body.asset_id, "Archivo");
  const { data: asset, error } = await db().from("assets").select("status, novel_id").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Archivo no encontrado");
  // Only a file of the novel that was authorized, never one of another (perhaps locked) novel:
  // the same answer as the database's composite foreign keys.
  if (novelId && asset.novel_id !== novelId) throw new HttpError(400, "Referencia a un elemento que no pertenece a esta novela.");
  const use = readUse({ kind: "replace", character_image_id: imageId, scope: body.scope });
  return NextResponse.json(await applyUse(use, assetId, asset.novel_id));
});
