import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import {
  DERIVED_TYPES,
  DISPLAY_MAX_SIDE,
  MAX_DERIVED_BYTES,
  MAX_ORIGINAL_BYTES,
  THUMB_MAX_SIDE,
  assetPaths,
  imageInfo,
  type DerivedType,
  type ImageInfo,
} from "@/lib/images";
import { bucket, deleteUnusedAssets, readHead, removeFiles } from "@/lib/assets-server";
import { addCharacterImage, readUse } from "@/lib/asset-uses";

type Ctx = { params: Promise<{ id: string }> };

async function readDerived(form: FormData, field: string, maxSide: number) {
  const file = form.get(field);
  if (!(file instanceof Blob) || !file.size) throw new HttpError(400, "Falta la versión reducida de la imagen.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info || !DERIVED_TYPES.includes(info.type as DerivedType)) throw new HttpError(400, "Versión reducida inválida.");
  if (Math.max(info.width, info.height) > maxSide) throw new HttpError(400, "La versión reducida es demasiado grande.");
  return { bytes, type: info.type as DerivedType };
}

/** Type and size of the stored original, read from its first bytes (a big EXIF block can push a JPEG header further). */
async function inspectOriginal(path: string): Promise<{ info: ImageInfo | null; total: number } | null> {
  let head = await readHead(path, 256 * 1024);
  if (!head) return null;
  let info = imageInfo(head.bytes);
  if (!info && head.total > head.bytes.length) {
    head = (await readHead(path, 4 * 1024 * 1024)) ?? head;
    info = imageInfo(head.bytes);
  }
  return { info, total: head.total };
}

/**
 * Step 2 of an upload. The original is already in Storage (signed URL); this
 * checks it from its own bytes, stores the display version and thumbnail the
 * browser generated, marks the asset ready and creates its use. If anything
 * fails, the asset and its files are removed: nothing is left half-made.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const id = assertId((await params).id, "Archivo");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_DERIVED_BYTES + 64 * 1024) {
    throw new HttpError(413, "Las versiones reducidas pesan demasiado.");
  }
  const { data: asset, error } = await db()
    .from("assets")
    .select("id, novel_id, status, version, original_path")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new HttpError(404, "Archivo no encontrado");
  if (asset.status !== "pending") throw new HttpError(409, "Este archivo ya está completo.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Envío inválido");
  }
  const use = readUse(form.get("use"));
  const display = await readDerived(form, "display", DISPLAY_MAX_SIDE);
  const thumb = await readDerived(form, "thumb", THUMB_MAX_SIDE);
  if (display.type !== thumb.type) throw new HttpError(400, "La miniatura no coincide con la versión reducida.");
  if (display.bytes.length + thumb.bytes.length > MAX_DERIVED_BYTES) throw new HttpError(413, "Las versiones reducidas pesan demasiado.");

  const discard = async (status: number, message: string) => {
    await db().from("assets").delete().eq("id", id);
    await removeFiles([asset.original_path]);
    return new HttpError(status, message);
  };
  const original = await inspectOriginal(asset.original_path);
  if (!original) throw new HttpError(400, "El archivo original no se ha recibido. Vuelve a intentarlo.");
  if (original.total > MAX_ORIGINAL_BYTES) throw await discard(413, "El archivo supera los 50 MB.");
  if (!original.info) throw await discard(400, "El archivo no es una imagen JPEG, PNG, WebP o AVIF.");

  const paths = assetPaths(asset.novel_id, id, asset.version, original.info.type, display.type);
  const uploaded: string[] = [];
  try {
    for (const [path, part] of [
      [paths.display_path!, display],
      [paths.thumb_path!, thumb],
    ] as const) {
      const { error: upError } = await bucket().upload(path, part.bytes, { contentType: part.type, upsert: false });
      if (upError) throw upError;
      uploaded.push(path);
    }
    const sha = form.get("sha256");
    const { error: readyError } = await db()
      .from("assets")
      .update({
        status: "ready",
        original_type: original.info.type,
        original_bytes: original.total,
        width: original.info.width,
        height: original.info.height,
        display_path: paths.display_path,
        thumb_path: paths.thumb_path,
        derived_type: display.type,
        sha256: typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      })
      .eq("id", id)
      .eq("status", "pending");
    if (readyError) throw readyError;
  } catch (e) {
    await removeFiles(uploaded);
    throw e;
  }

  try {
    const images = await addCharacterImage(use, id);
    return NextResponse.json({ asset_id: id, images }, { status: 201 });
  } catch (e) {
    // The use failed (unknown character, another novel, gallery full): the new file has no use left.
    await deleteUnusedAssets([id]);
    throw e;
  }
});
