/**
 * In the browser: each exported image's original file, as DOCX and EPUB can carry it
 * (docs/exportacion.md). A JPEG or PNG without rotation goes as uploaded, byte for byte;
 * anything else (WebP, AVIF, or a photo with an EXIF orientation, which Word ignores) is
 * drawn upright on a canvas: PNG stays PNG, the rest becomes a JPEG on white.
 */
import { safeName } from "../backup";
import type { PreparedImage } from "./docx";
import type { ExportFile } from "./model";

const JPEG_QUALITY = 0.92;

async function prepare(file: ExportFile, blob: Blob): Promise<PreparedImage> {
  const asIs = (file.original_type === "image/jpeg" || file.original_type === "image/png") && file.orientation <= 1;
  if (asIs)
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      ext: file.original_type === "image/png" ? "png" : "jpeg",
      width: file.width,
      height: file.height,
    };
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const png = file.original_type === "image/png";
  if (!png) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? "image/png" : "image/jpeg", JPEG_QUALITY));
  if (!out) throw new Error("toBlob");
  return { bytes: new Uint8Array(await out.arrayBuffer()), ext: png ? "png" : "jpeg", width: canvas.width, height: canvas.height };
}

/** The files, each fetched once; the ones that fail are listed by name and left out. */
export async function prepareImages(
  files: ExportFile[],
  progress: (done: number, total: number) => void = () => {},
): Promise<{ images: Map<string, PreparedImage>; missing: string[] }> {
  const images = new Map<string, PreparedImage>();
  const missing: string[] = [];
  for (const [i, file] of files.entries()) {
    progress(i, files.length);
    try {
      const res = await fetch(`/api/assets/${file.id}/original?v=${file.version}`);
      if (!res.ok) throw new Error(String(res.status));
      images.set(file.id, await prepare(file, await res.blob()));
    } catch {
      missing.push(file.file_name || file.id);
    }
  }
  return { images, missing };
}

/** "La casa del puerto - libro.docx": ASCII, because Chromium drops a download name with accents. */
export function exportName(title: string, suffix: string, ext: string): string {
  const ascii = safeName(title)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "-");
  return `${ascii} - ${suffix}.${ext}`;
}
