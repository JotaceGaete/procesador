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
  width: number;
  height: number;
}

/**
 * Type and pixel size read from the first bytes of the file (never from its name
 * or declared type). Returns null for anything that isn't a JPEG, PNG, WebP or
 * AVIF, or when the header doesn't fit in the bytes given.
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
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return valid({ type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    if (ascii(12, "VP8X")) return valid({ type: "image/webp", width: u24le(24) + 1, height: u24le(27) + 1 });
    return null;
  }

  // AVIF: ISO-BMFF with an avif/avis brand; the size is in the first 'ispe' box.
  if (b.length >= 16 && ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) {
    for (let i = 12; i + 16 <= b.length; i++) {
      if (ascii(i, "ispe")) return valid({ type: "image/avif", width: u32be(i + 8), height: u32be(i + 12) });
    }
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
