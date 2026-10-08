import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { assertId, db, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { getManuscriptImages } from "@/lib/assets-server";
import { applyUse, readManuscriptFields } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

/** The novel's images of the book, placed or not. */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  return NextResponse.json(await getManuscriptImages(novel.id), { headers: { "Cache-Control": "no-store" } });
});

/**
 * A new image of the book with a file the novel already has (from a character's
 * gallery, or found by the duplicate check): the file is reused, never copied.
 * Body: { asset_id, id?, alt?, decorative?, caption?, credit?, layout?, align?, width_pct? }.
 */
export const POST = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const assetId = assertId(body.asset_id, "Archivo");
  const { data: asset, error } = await db().from("assets").select("status").eq("id", assetId).maybeSingle();
  if (error) throw error;
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Archivo no encontrado");
  const id = body.id === undefined ? undefined : assertId(body.id, "Imagen");
  const { manuscriptImage } = await applyUse({ kind: "manuscript", id, ...readManuscriptFields(body) }, assetId, novel.id);
  return NextResponse.json(manuscriptImage, { status: 201 });
});
