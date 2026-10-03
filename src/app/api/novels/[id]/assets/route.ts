import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { MAX_ORIGINAL_BYTES, ORIGINAL_TYPES, assetPaths, type OriginalType } from "@/lib/images";
import { bucket, sweepAssets } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Step 1 of an upload (docs/archivos.md). Creates a pending asset and returns a
 * signed, single-use URL that accepts the original for that one path only. The
 * browser uploads the original straight to Storage (it can exceed what a Vercel
 * function accepts), then calls /api/assets/{id}/complete.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const type = body.type as OriginalType;
  const bytes = Number(body.bytes);
  if (!ORIGINAL_TYPES.includes(type)) throw new HttpError(400, "Formato no admitido. Usa JPEG, PNG, WebP o AVIF.");
  if (!Number.isInteger(bytes) || bytes <= 0) throw new HttpError(400, "Tamaño inválido");
  if (bytes > MAX_ORIGINAL_BYTES) throw new HttpError(413, "El archivo supera los 50 MB.");
  const fileName = typeof body.file_name === "string" ? body.file_name.trim().slice(0, 200) : "";

  await sweepAssets(novel.id);

  const id = crypto.randomUUID();
  const { original_path } = assetPaths(novel.id, id, 1, type);
  const { error } = await db().from("assets").insert({
    id,
    novel_id: novel.id,
    file_name: fileName,
    original_path,
    original_type: type,
    original_bytes: bytes,
  });
  if (error) throw error;

  const { data, error: signError } = await bucket().createSignedUploadUrl(original_path);
  if (signError) {
    await db().from("assets").delete().eq("id", id);
    throw signError;
  }
  return NextResponse.json({ asset_id: id, upload_url: data.signedUrl }, { status: 201 });
});
