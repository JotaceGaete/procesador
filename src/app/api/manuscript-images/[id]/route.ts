import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { deleteUnusedAssets, getManuscriptImage } from "@/lib/assets-server";
import { readManuscriptFields } from "@/lib/asset-uses";
import { assertImageChapterUnlocked } from "@/lib/chapter-lock-server";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => new HttpError(404, "Imagen no encontrada");

/** Alternative text, decorative, caption, credit, layout, alignment and width. Never touches the chapter text. */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const fields = readManuscriptFields(await readJson(request));
  if (!Object.keys(fields).length) throw new HttpError(400, "Nada que guardar");
  await assertImageChapterUnlocked(id);
  const { data, error } = await db().from("manuscript_images").update(fields).eq("id", id).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  return NextResponse.json(await getManuscriptImage(id));
});

/**
 * Deletes the image for good (removing its marker from the text is the editor's
 * job, with undo). Its file is deleted only if nothing else uses it.
 */
export const DELETE = handler<Ctx>(async (_request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  await assertImageChapterUnlocked(id);
  const { data, error } = await db().from("manuscript_images").delete().eq("id", id).select("asset_id").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  await deleteUnusedAssets([data.asset_id]);
  return new NextResponse(null, { status: 204 });
});
