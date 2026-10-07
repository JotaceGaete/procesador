import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { deleteUnusedAssets, getCharacterImages } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => new HttpError(404, "Imagen no encontrada");

/** Caption and descriptive stage label of one gallery image. */
export const PATCH = novelHandler<Ctx>(byChild("character_images"), async (request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const body = await readJson(request);
  const update: Record<string, string> = {};
  for (const key of ["caption", "stage_label"]) {
    if (typeof body[key] === "string") update[key] = (body[key] as string).trim().slice(0, 500);
  }
  if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");
  const { data, error } = await db().from("character_images").update(update).eq("id", id).select("character_id").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  return NextResponse.json(await getCharacterImages(data.character_id));
});

/**
 * Removes the image from the gallery (if it was the main one, the next takes
 * over). The file itself is deleted only if nothing else uses it.
 */
export const DELETE = novelHandler<Ctx>(byChild("character_images"), async (_request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const { data, error } = await db()
    .from("character_images")
    .delete()
    .eq("id", id)
    .select("character_id, asset_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  await deleteUnusedAssets([data.asset_id]);
  return NextResponse.json(await getCharacterImages(data.character_id));
});
