import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { applyUse, readUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Replaces an image of the book's file with one the novel already has, without
 * uploading anything (new files go through the upload with `use: { kind: "replace",
 * manuscript_image_id, scope }`). The marker, texts and position don't change, so
 * the chapter's revision doesn't either. Body: { asset_id, scope: "use" | "all" }.
 * Returns the novel's gallery and manuscript images.
 */
export const POST = novelHandler<Ctx>(byChild("manuscript_images"), async (request, { params }) => {
  const imageId = assertId((await params).id, "Imagen");
  const body = await readJson(request);
  const assetId = assertId(body.asset_id, "Archivo");
  const { data: asset, error } = await db().from("assets").select("status, novel_id").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Archivo no encontrado");
  const use = readUse({ kind: "replace", manuscript_image_id: imageId, scope: body.scope });
  return NextResponse.json(await applyUse(use, assetId, asset.novel_id));
});
