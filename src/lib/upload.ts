"use client";

import { api } from "./client";
import {
  DISPLAY_MAX_SIDE,
  MAX_ORIGINAL_BYTES,
  ORIGINAL_TYPES,
  THUMB_MAX_SIDE,
  type OriginalType,
} from "./images";
import type { AssetInfo, AssetUse, CharacterImage } from "./types";

/**
 * Browser side of an upload (docs/archivos.md):
 *   1. hash the file; if the novel already has it, reuse it (nothing is uploaded);
 *   2. otherwise ask for a signed, single-use URL and send the original there untouched;
 *   3. make the display version (≤ 2048 px) and the thumbnail (≤ 480 px) here;
 *   4. complete: the server checks and hashes the original, stores the derivatives and applies the use.
 */

export type UploadStage = "preparing" | "uploading" | "processing";

export interface CharacterUpload {
  novelId: string;
  characterId: string;
  file: File;
  onProgress(stage: UploadStage, fraction?: number): void;
}

/** Returns why a file can't be uploaded, or null when it can. */
export function rejectReason(file: File): string | null {
  if (!ORIGINAL_TYPES.includes(file.type as OriginalType)) return "Formato no admitido. Usa JPEG, PNG, WebP o AVIF.";
  if (file.size > MAX_ORIGINAL_BYTES) return "El archivo supera los 50 MB.";
  if (!file.size) return "El archivo está vacío.";
  return null;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    // Applies the EXIF orientation, so phone photos aren't sideways.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
}

/** A reduced copy for the interface. WebP where the browser can write it, JPEG otherwise. */
async function derive(source: ImageBitmap | HTMLImageElement, maxSide: number, preferred?: string): Promise<Blob> {
  const w = "naturalWidth" in source ? source.naturalWidth : source.width;
  const h = "naturalHeight" in source ? source.naturalHeight : source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const type of preferred ? [preferred] : ["image/webp", "image/jpeg"]) {
    const blob = await encode(canvas, type);
    if (blob && blob.type === type) return blob;
  }
  throw new Error("Este navegador no pudo preparar la imagen.");
}

async function sha256(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null; // only used to warn about repeated files
  }
}

/** PUT with progress (fetch can't report upload progress). */
function put(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("No se pudo subir el original.")));
    xhr.onerror = () => reject(new Error("Sin conexión con el almacenamiento."));
    xhr.send(file);
  });
}

type StoreResult =
  | { kind: "duplicate"; asset: AssetInfo; uses: AssetUse[] }
  | { kind: "stored"; assetId: string; reused: boolean; images: CharacterImage[] };

/**
 * Stores a file for a use. The hash goes first: if the novel already has this
 * exact file, nothing is processed or uploaded and the existing file comes back
 * (the server double-checks with its own hash when an upload completes).
 */
async function storeFile(novelId: string, file: File, use: object, onProgress: CharacterUpload["onProgress"]): Promise<StoreResult> {
  const reason = rejectReason(file);
  if (reason) throw new Error(reason);

  onProgress("preparing");
  const hash = await sha256(file);
  const start = await api<{ asset_id?: string; upload_url?: string; duplicate?: { asset: AssetInfo; uses: AssetUse[] } }>(
    `/api/novels/${novelId}/assets`,
    { method: "POST", json: { file_name: file.name, type: file.type, bytes: file.size, sha256: hash } },
  );
  if (start.duplicate) return { kind: "duplicate", ...start.duplicate };

  const source = await decode(file);
  const display = await derive(source, DISPLAY_MAX_SIDE);
  const thumb = await derive(source, THUMB_MAX_SIDE, display.type);
  if ("close" in source) source.close();

  onProgress("uploading", 0);
  await put(start.upload_url!, file, (f) => onProgress("uploading", f));

  onProgress("processing");
  const form = new FormData();
  form.append("display", display, "display");
  form.append("thumb", thumb, "thumb");
  form.append("use", JSON.stringify(use));
  const done = await api<{ asset_id: string; reused: boolean; images: CharacterImage[] }>(`/api/assets/${start.asset_id}/complete`, {
    method: "POST",
    body: form,
  });
  return { kind: "stored", assetId: done.asset_id, reused: done.reused, images: done.images };
}

export const REUSED = "Ya estaba en la novela: se usa el mismo archivo, sin guardar otra copia.";

/**
 * Adds an image to a character's gallery. Returns the updated gallery, or null
 * when that exact image is already in this gallery (nothing changes), plus a
 * notice when an existing file was reused.
 */
export async function addCharacterImage({
  novelId,
  characterId,
  file,
  onProgress,
}: CharacterUpload): Promise<{ images: CharacterImage[] | null; notice: string }> {
  const r = await storeFile(novelId, file, { kind: "character", character_id: characterId }, onProgress);
  if (r.kind === "stored") return { images: r.images, notice: r.reused ? REUSED : "" };
  if (r.uses.some((u) => u.character_id === characterId)) {
    return { images: null, notice: `«${file.name}» ya está en esta galería.` };
  }
  const images = await api<CharacterImage[]>(`/api/characters/${characterId}/images`, {
    method: "POST",
    json: { asset_id: r.asset.id },
  });
  return { images, notice: REUSED };
}

/**
 * Replaces the file of a gallery image, keeping its caption, stage label, order and
 * main-image status. `scope: "use"` changes this image only; `"all"` every use of
 * its current file. Returns the whole novel's gallery images.
 */
export async function replaceCharacterImage({
  novelId,
  imageId,
  scope,
  file,
  onProgress,
}: {
  novelId: string;
  imageId: string;
  scope: "use" | "all";
  file: File;
  onProgress: CharacterUpload["onProgress"];
}): Promise<{ images: CharacterImage[]; notice: string }> {
  const r = await storeFile(novelId, file, { kind: "replace", character_image_id: imageId, scope }, onProgress);
  if (r.kind === "stored") return { images: r.images, notice: r.reused ? REUSED : "" };
  const images = await api<CharacterImage[]>(`/api/character-images/${imageId}/replace`, {
    method: "POST",
    json: { asset_id: r.asset.id, scope },
  });
  return { images, notice: REUSED };
}
