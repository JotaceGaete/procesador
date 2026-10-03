import type { AssetInfo } from "./types";

/**
 * Novel files (see docs/archivos.md): limits, format detection, storage paths
 * and URLs. Shared by client and server.
 */

/** Originals are kept as uploaded, for export and print. */
export const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
/** Display version plus thumbnail, generated in the browser. Below Vercel's ~4.5 MB request limit. */
export const MAX_DERIVED_BYTES = 4 * 1024 * 1024;
/** Longest side of the derivatives the interface uses. They never replace the original. */
export const DISPLAY_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 480;
export const MAX_IMAGES_PER_CHARACTER = 40;

export type OriginalType = "image/jpeg" | "image/png" | "image/webp" | "image/avif";
export type DerivedType = "image/webp" | "image/jpeg" | "image/png";

export const ORIGINAL_TYPES: readonly OriginalType[] = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const DERIVED_TYPES: readonly DerivedType[] = ["image/webp", "image/jpeg", "image/png"];

export const EXTENSIONS: Record<OriginalType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export type AssetVariant = "thumb" | "display" | "original";

export interface ImageInfo {
  type: OriginalType;
  /** Pixel size as the image is seen, with its orientation already applied. */
  width: number;
  height: number;
  /** EXIF orientation of the original (1 = as stored; 5–8 = rotated a quarter turn). */
  orientation: number;
}

/**
 * EXIF orientation from a TIFF block (the body of a JPEG APP1 "Exif", a PNG eXIf
 * chunk or a WebP EXIF chunk). 1 when missing or unreadable.
 */
export function exifOrientation(b: Uint8Array, start: number, end = b.length): number {
  if (start + 8 > end) return 1;
  const le = b[start] === 0x49 && b[start + 1] === 0x49; // "II"
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return 1; // "MM"
  const u16 = (i: number) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i: number) =>
    (le ? b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24) : (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (u16(start + 2) !== 42) return 1;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Type, pixel size and orientation read from the first bytes of the file (never
 * from its name or declared type). Returns null for anything that isn't a JPEG,
 * PNG, WebP or AVIF, or when the header doesn't fit in the bytes given.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u32le = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  /** Applies the orientation: a quarter turn (5–8) swaps width and height. */
  const oriented = (type: OriginalType, w: number, h: number, orientation = 1): ImageInfo | null => {
    if (w <= 0 || h <= 0) return null;
    return orientation >= 5 ? { type, width: h, height: w, orientation } : { type, width: w, height: h, orientation };
  };

  // PNG: signature, IHDR with the size, and an optional eXIf chunk before the image data.
  if (b.length >= 24 && u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a && ascii(12, "IHDR")) {
    let orientation = 1;
    for (let i = 8; i + 8 <= b.length; ) {
      const len = u32be(i);
      if (ascii(i + 4, "eXIf")) orientation = exifOrientation(b, i + 8, Math.min(b.length, i + 8 + len));
      if (ascii(i + 4, "IDAT") || ascii(i + 4, "IEND")) break;
      i += 12 + len;
    }
    return oriented("image/png", u32be(16), u32be(20), orientation);
  }

  // WebP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X (extended, may carry EXIF) chunk.
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return oriented("image/webp", u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (ascii(12, "VP8L") && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return oriented("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, "VP8X")) {
      let orientation = 1;
      for (let i = 12; i + 8 <= b.length; ) {
        const len = u32le(i + 4);
        if (ascii(i, "EXIF")) {
          // Some writers keep the JPEG-style "Exif\0\0" prefix.
          const body = ascii(i + 8, "Exif") ? i + 14 : i + 8;
          orientation = exifOrientation(b, body, Math.min(b.length, i + 8 + len));
          break;
        }
        i += 8 + len + (len % 2);
      }
      return oriented("image/webp", u24le(24) + 1, u24le(27) + 1, orientation);
    }
    return null;
  }

  // AVIF: ISO-BMFF with an avif/avis brand; size in the first 'ispe' box, rotation in 'irot'
  // (quarter turns counter-clockwise, which decoders always apply).
  if (b.length >= 16 && ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) {
    let size: [number, number] | null = null;
    let orientation = 1;
    for (let i = 12; i + 5 <= b.length; i++) {
      if (!size && i + 16 <= b.length && ascii(i, "ispe")) size = [u32be(i + 8), u32be(i + 12)];
      if (ascii(i, "irot")) orientation = [1, 8, 3, 6][b[i + 4] & 3];
    }
    return size ? oriented("image/avif", size[0], size[1], orientation) : null;
  }

  // JPEG: walk the segments until a start-of-frame marker; APP1 "Exif" carries the orientation.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let orientation = 1;
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
      const length = u16be(i + 2);
      if (marker === 0xe1 && ascii(i + 4, "Exif")) orientation = exifOrientation(b, i + 10, Math.min(b.length, i + 2 + length));
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return oriented("image/jpeg", u16be(i + 7), u16be(i + 5), orientation);
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + length;
    }
  }
  return null;
}

/**
 * Bucket paths of one version of an asset: {novel}/{asset}/v{n}/original|display|thumb.
 * Folders are per file, not per use, because a file can have several uses.
 */
export function assetPaths(novelId: string, assetId: string, version: number, original: OriginalType, derived?: DerivedType) {
  const base = `${novelId}/${assetId}/v${version}`;
  return {
    original_path: `${base}/original.${EXTENSIONS[original]}`,
    display_path: derived ? `${base}/display.${EXTENSIONS[derived]}` : null,
    thumb_path: derived ? `${base}/thumb.${EXTENSIONS[derived]}` : null,
  };
}

/** The version is part of the URL: a replaced file gets a new URL, and the server rejects old ones. */
export function assetUrl(asset: Pick<AssetInfo, "id" | "version">, variant: AssetVariant) {
  return `/api/assets/${asset.id}/${variant}?v=${asset.version}`;
}
