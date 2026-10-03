import "server-only";
import { createHash } from "node:crypto";
import { db } from "./supabase";
import type { AssetUse, CharacterImage, ManuscriptImage } from "./types";

/**
 * Novel files on the server (see docs/archivos.md). One private bucket for every
 * novel; no policies on storage.objects, so only the service_role can use it.
 */
export const BUCKET = "novel-files";

export const bucket = () => db().storage.from(BUCKET);

/** Asset columns the browser may see (no storage paths). */
export const ASSET_INFO = "id, version, file_name, original_type, original_bytes, width, height, orientation, derived_type";

const CHARACTER_IMAGE = `id, novel_id, character_id, asset_id, caption, stage_label, is_primary, sort_order, created_at, asset:assets(${ASSET_INFO})`;

const gallery = (column: "novel_id" | "character_id", value: string) =>
  db().from("character_images").select(CHARACTER_IMAGE).eq(column, value).order("sort_order").order("created_at");

const MANUSCRIPT_IMAGE = `id, novel_id, asset_id, chapter_id, alt, decorative, caption, credit, layout, align, width_pct, created_at, asset:assets(${ASSET_INFO})`;

export async function getManuscriptImages(novelId: string): Promise<ManuscriptImage[]> {
  const { data, error } = await db()
    .from("manuscript_images")
    .select(MANUSCRIPT_IMAGE)
    .eq("novel_id", novelId)
    .order("created_at");
  if (error) throw error;
  return data as unknown as ManuscriptImage[];
}

export async function getManuscriptImage(id: string): Promise<ManuscriptImage | null> {
  const { data, error } = await db().from("manuscript_images").select(MANUSCRIPT_IMAGE).eq("id", id).maybeSingle();
  if (error) throw error;
  return data as unknown as ManuscriptImage | null;
}

export async function getNovelImages(novelId: string): Promise<CharacterImage[]> {
  const { data, error } = await gallery("novel_id", novelId);
  if (error) throw error;
  return data as unknown as CharacterImage[];
}

export async function getCharacterImages(characterId: string): Promise<CharacterImage[]> {
  const { data, error } = await gallery("character_id", characterId);
  if (error) throw error;
  return data as unknown as CharacterImage[];
}

/** First bytes kept for format detection (a big EXIF block can push a JPEG header far). */
const HEAD_BYTES = 4 * 1024 * 1024;

/**
 * Reads a stored original once, as a stream: its first bytes (for the format),
 * its real size and its SHA-256. Only the head is kept in memory, so a 50 MB
 * original never is. Null when the file doesn't exist.
 */
export async function inspectStored(path: string): Promise<{ head: Uint8Array; total: number; sha256: string } | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${encoded}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok || !res.body) {
    await res.arrayBuffer().catch(() => {}); // small error body; read it so the connection is released
    return null;
  }
  const hash = createHash("sha256");
  const head = new Uint8Array(HEAD_BYTES);
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    if (total < HEAD_BYTES) head.set(value.subarray(0, HEAD_BYTES - total), total);
    total += value.length;
  }
  return { head: head.subarray(0, Math.min(total, HEAD_BYTES)), total, sha256: hash.digest("hex") };
}

/** Where a file is used (shown when an upload turns out to be a file the novel already has). */
export async function assetUses(assetId: string): Promise<AssetUse[]> {
  const [gallery, manuscript] = await Promise.all([
    db().from("character_images").select("id, character_id").eq("asset_id", assetId),
    db().from("manuscript_images").select("id, chapter_id").eq("asset_id", assetId),
  ]);
  if (gallery.error) throw gallery.error;
  if (manuscript.error) throw manuscript.error;
  return [
    ...gallery.data.map((u): AssetUse => ({ kind: "character", character_id: u.character_id, character_image_id: u.id })),
    ...manuscript.data.map((u): AssetUse => ({ kind: "manuscript", manuscript_image_id: u.id, chapter_id: u.chapter_id })),
  ];
}

/**
 * Removes files whose rows are already gone. A failure only leaves an
 * unreachable file (no row serves it): logged, and the request still succeeds.
 */
export async function removeFiles(paths: string[]) {
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await bucket().remove(paths.slice(i, i + 500));
    if (error) console.error("[storage]", error.message);
  }
}

/** Deletes the given assets that no longer have any use, rows first, then files. Assets still in use are kept. */
export async function deleteUnusedAssets(ids: string[]) {
  if (!ids.length) return;
  const { data, error } = await db().rpc("delete_unused_assets", { p_ids: [...new Set(ids)] });
  if (error) throw error;
  await removeFiles((data as { path: string }[]).map((r) => r.path));
}

/** Clears abandoned uploads and unused files of a novel (see sweep_assets). Never fails the request. */
export async function sweepAssets(novelId: string) {
  const { data, error } = await db().rpc("sweep_assets", { p_novel: novelId });
  if (error) return console.error("[storage]", error.message);
  await removeFiles((data as { path: string }[]).map((r) => r.path));
}

/** Every file of a novel, read before deleting the novel (the rows go by cascade). */
export async function novelFiles(novelId: string): Promise<string[]> {
  const { data, error } = await db().from("assets").select("original_path, display_path, thumb_path").eq("novel_id", novelId);
  if (error) throw error;
  return data.flatMap((r) => [r.original_path, r.display_path, r.thumb_path]).filter(Boolean);
}
