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
} from "@/lib/images";
import { bucket, deleteUnusedAssets, inspectStored, removeFiles } from "@/lib/assets-server";
import { applyUse, readUse } from "@/lib/asset-uses";

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

/**
 * Step 2 of an upload. The original is already in Storage (signed URL); this
 * checks it from its own bytes and hashes it. If the novel already has that exact
 * file, the new copy is discarded and the existing file is used: a file is never
 * stored twice in a novel. Otherwise it stores the display version and thumbnail
 * the browser generated and marks the asset ready. Then it applies the use (a new
 * gallery image, or a replacement). If anything fails, nothing is left half-made.
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

  /** Removes this upload entirely: row first, then its files. */
  const discard = async (files: string[] = []) => {
    await db().from("assets").delete().eq("id", id);
    await removeFiles([asset.original_path, ...files]);
  };
  const stored = await inspectStored(asset.original_path);
  if (!stored) throw new HttpError(400, "El archivo original no se ha recibido. Vuelve a intentarlo.");
  if (stored.total > MAX_ORIGINAL_BYTES) {
    await discard();
    throw new HttpError(413, "El archivo supera los 50 MB.");
  }
  const info = imageInfo(stored.head);
  if (!info) {
    await discard();
    throw new HttpError(400, "El archivo no es una imagen JPEG, PNG, WebP o AVIF.");
  }

  // Already in the novel? Reuse it before storing anything else.
  const { data: same, error: sameError } = await db()
    .from("assets")
    .select("id")
    .eq("novel_id", asset.novel_id)
    .eq("status", "ready")
    .eq("sha256", stored.sha256)
    .eq("original_bytes", stored.total)
    .limit(1)
    .maybeSingle();
  if (sameError) throw sameError;

  let fileId: string;
  if (same) {
    await discard();
    fileId = same.id;
  } else {
    const paths = assetPaths(asset.novel_id, id, asset.version, info.type, display.type);
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
      // Under a per-novel lock: if an identical upload finished meanwhile, that one wins.
      const { data: finalId, error: readyError } = await db().rpc("finalize_asset", {
        p_asset: id,
        p_sha256: stored.sha256,
        p_type: info.type,
        p_bytes: stored.total,
        p_width: info.width,
        p_height: info.height,
        p_orientation: info.orientation,
        p_display: paths.display_path,
        p_thumb: paths.thumb_path,
        p_derived: display.type,
      });
      if (readyError) throw readyError;
      fileId = finalId as string;
      if (fileId !== id) await discard(uploaded);
    } catch (e) {
      await removeFiles(uploaded);
      throw e;
    }
  }

  try {
    const result = await applyUse(use, fileId, asset.novel_id);
    return NextResponse.json({ asset_id: fileId, reused: fileId !== id, ...result }, { status: 201 });
  } catch (e) {
    // The use failed (unknown character, another novel, gallery full): a new file is left without use.
    if (fileId === id) await deleteUnusedAssets([id]);
    throw e;
  }
});
