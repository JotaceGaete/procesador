import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { applyUse, readUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Replaces a gallery image's file with one the novel already has (found by the
 * upload's duplicate check), without uploading anything. New files go through
 * the upload with `use: { kind: "replace", … }`. Body: { asset_id, scope: "use" | "all" }.
 * Returns the whole novel's gallery images.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const imageId = assertId((await params).id, "Imagen");
  const body = await readJson(request);
  const assetId = assertId(body.asset_id, "Archivo");
  const { data: asset, error } = await db().from("assets").select("status").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Archivo no encontrado");
  const use = readUse({ kind: "replace", character_image_id: imageId, scope: body.scope });
  return NextResponse.json(await applyUse(use, assetId));
});
