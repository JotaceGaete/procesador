import type { CharacterImage } from "./types";

/** Character images: limits, format detection and URLs (shared by client and server). */

export const MAX_IMAGES_PER_CHARACTER = 40;
/** Image plus thumbnail, already downscaled in the browser. Below Vercel's ~4.5 MB request limit. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Longest side the browser downscales to, and what the server accepts. */
export const IMAGE_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 480;

export type ImageType = "image/webp" | "image/jpeg" | "image/png";

export const EXTENSIONS: Record<ImageType, string> = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
}

/**
 * Type and size read from the bytes themselves (never from the file name or the
 * declared type). Returns null for anything that isn't a WebP, JPEG or PNG.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  const valid = (info: ImageInfo) => (info.width > 0 && info.height > 0 ? info : null);

  // PNG: signature, then the IHDR chunk with width and height.
  if (b.length >= 24 && u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a && ascii(12, "IHDR")) {
    return valid({ type: "image/png", width: u32be(16), height: u32be(20) });
  }

  // WebP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return valid({ type: "image/webp", width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff });
    }
    if (ascii(12, "VP8L") && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return valid({ type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    if (ascii(12, "VP8X")) return valid({ type: "image/webp", width: u24le(24) + 1, height: u24le(27) + 1 });
    return null;
  }

  // JPEG: walk the segments until a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return valid({ type: "image/jpeg", width: u16be(i + 7), height: u16be(i + 5) });
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

/** Bucket paths. Each version is a different file, so a version's bytes never change. */
export function imagePaths(novelId: string, characterId: string, imageId: string, version: number, type: ImageType) {
  const base = `${novelId}/${characterId}/${imageId}-v${version}`;
  const ext = EXTENSIONS[type];
  return { storage_path: `${base}.${ext}`, thumb_path: `${base}.thumb.${ext}` };
}

/** The version is part of the URL: a replaced image gets a new URL, and the server rejects old ones. */
export function imageUrl(image: Pick<CharacterImage, "id" | "version">, size: "thumb" | "full") {
  return `/api/images/${image.id}?size=${size}&v=${image.version}`;
}

/** Gallery order: sort_order, then creation as a tiebreak. */
export function sortImages<T extends Pick<CharacterImage, "sort_order" | "created_at">>(images: T[]): T[] {
  return [...images].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}
