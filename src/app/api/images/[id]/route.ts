import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { IMAGE_COLUMNS, bucket, getCharacterImages, imageFiles, removeFiles } from "@/lib/images-server";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => new HttpError(404, "Imagen no encontrada");

/**
 * Serves one image or its thumbnail from the private bucket.
 *
 * Cache: the URL carries the version, and every response is checked against the
 * current row first: a deleted image, or an old version, is a 404. Browsers keep
 * a copy for 10 minutes at most, then revalidate with the ETag (304 without
 * touching Storage while it is unchanged). See docs/personajes-galeria.md.
 */
export const GET = handler<Ctx>(async (request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const url = new URL(request.url);
  const size = url.searchParams.get("size") === "full" ? "full" : "thumb";
  const { data, error } = await db()
    .from("character_images")
    .select("storage_path, thumb_path, content_type, version")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || url.searchParams.get("v") !== String(data.version)) throw notFound();

  const etag = `"${id}-v${data.version}-${size}"`;
  const headers = { "Cache-Control": "private, max-age=600, must-revalidate", ETag: etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  const { data: file, error: fileError } = await bucket().download(size === "full" ? data.storage_path : data.thumb_path);
  if (fileError || !file) throw notFound();
  return new NextResponse(file.stream(), {
    headers: { ...headers, "Content-Type": data.content_type, "X-Content-Type-Options": "nosniff" },
  });
});

/** Caption and descriptive stage label. */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const body = await readJson(request);
  const update: Record<string, string> = {};
  for (const key of ["caption", "stage_label"]) {
    if (typeof body[key] === "string") update[key] = (body[key] as string).trim().slice(0, 500);
  }
  if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");
  const { data, error } = await db().from("character_images").update(update).eq("id", id).select(IMAGE_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  return NextResponse.json(data);
});

/** Deletes the row, then its files. If it was the main image, the next one takes over. Returns the gallery. */
export const DELETE = handler<Ctx>(async (_request, { params }) => {
  const id = assertId((await params).id, "Imagen");
  const files = await imageFiles("id", id);
  const { data, error } = await db().from("character_images").delete().eq("id", id).select("character_id").maybeSingle();
  if (error) throw error;
  if (!data) throw notFound();
  await removeFiles(files);
  return NextResponse.json(await getCharacterImages(data.character_id));
});
