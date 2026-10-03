import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import {
  IMAGE_MAX_SIDE,
  MAX_IMAGES_PER_CHARACTER,
  MAX_UPLOAD_BYTES,
  THUMB_MAX_SIDE,
  imageInfo,
  imagePaths,
  type ImageInfo,
} from "@/lib/images";
import { IMAGE_COLUMNS, bucket, getCharacterImages, removeFiles } from "@/lib/images-server";

type Ctx = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getCharacter(id: string) {
  const { data, error } = await db()
    .from("characters")
    .select("id, novel_id")
    .eq("id", assertId(id, "Personaje"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Personaje no encontrado");
  return data as { id: string; novel_id: string };
}

async function readImage(form: FormData, field: string, maxSide: number): Promise<{ bytes: Uint8Array; info: ImageInfo }> {
  const file = form.get(field);
  if (!(file instanceof Blob) || !file.size) throw new HttpError(400, "Falta la imagen.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info) throw new HttpError(400, "El archivo no es una imagen WebP, JPEG o PNG.");
  if (Math.max(info.width, info.height) > maxSide) throw new HttpError(400, "La imagen es demasiado grande.");
  return { bytes, info };
}

/**
 * Adds an image to the gallery. The browser sends the downscaled image and its
 * thumbnail; the server checks both from their bytes, stores them in the private
 * bucket and records the metadata. Returns the character's gallery.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const character = await getCharacter((await params).id);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) {
    throw new HttpError(413, "La imagen pesa demasiado.");
  }

  const { count, error: countError } = await db()
    .from("character_images")
    .select("id", { count: "exact", head: true })
    .eq("character_id", character.id);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_IMAGES_PER_CHARACTER) {
    throw new HttpError(400, `Máximo ${MAX_IMAGES_PER_CHARACTER} imágenes por personaje.`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Envío inválido");
  }
  const image = await readImage(form, "image", IMAGE_MAX_SIDE);
  const thumb = await readImage(form, "thumb", THUMB_MAX_SIDE);
  if (image.bytes.length + thumb.bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "La imagen pesa demasiado.");
  if (thumb.info.type !== image.info.type) throw new HttpError(400, "La miniatura no coincide con la imagen.");

  const id = crypto.randomUUID();
  const type = image.info.type;
  const paths = imagePaths(character.novel_id, character.id, id, 1, type);
  const text = (key: string) => (typeof form.get(key) === "string" ? String(form.get(key)).trim().slice(0, 500) : "");

  const uploaded: string[] = [];
  try {
    for (const [path, bytes] of [
      [paths.storage_path, image.bytes],
      [paths.thumb_path, thumb.bytes],
    ] as const) {
      const { error } = await bucket().upload(path, bytes, { contentType: type, upsert: false });
      if (error) throw error;
      uploaded.push(path);
    }
    // sort_order and is_primary are set by the database (character_image_insert).
    const { error } = await db()
      .from("character_images")
      .insert({
        id,
        novel_id: character.novel_id,
        character_id: character.id,
        ...paths,
        content_type: type,
        version: 1,
        caption: text("caption"),
        stage_label: text("stage_label"),
        width: image.info.width,
        height: image.info.height,
        bytes: image.bytes.length,
      })
      .select(IMAGE_COLUMNS)
      .single();
    if (error) throw error;
  } catch (e) {
    await removeFiles(uploaded);
    throw e;
  }
  return NextResponse.json(await getCharacterImages(character.id), { status: 201 });
});

/** New gallery order: the complete list of the character's image ids. */
export const PUT = handler<Ctx>(async (request, { params }) => {
  const character = await getCharacter((await params).id);
  const { ids } = await readJson(request);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "Orden inválido");
  if (!ids.every((x) => UUID.test(x))) throw new HttpError(400, "Orden inválido");
  const { error } = await db().rpc("reorder_character_images", { p_character: character.id, p_ids: ids });
  if (error) throw error;
  return NextResponse.json(await getCharacterImages(character.id));
});
