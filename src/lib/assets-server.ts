import "server-only";
import { db } from "./supabase";
import type { CharacterImage } from "./types";

/**
 * Novel files on the server (see docs/archivos.md). One private bucket for every
 * novel; no policies on storage.objects, so only the service_role can use it.
 */
export const BUCKET = "novel-files";

export const bucket = () => db().storage.from(BUCKET);

/** Asset columns the browser may see (no storage paths). */
export const ASSET_INFO = "id, version, file_name, original_type, original_bytes, width, height, derived_type";

const CHARACTER_IMAGE = `id, novel_id, character_id, asset_id, caption, stage_label, is_primary, sort_order, created_at, asset:assets(${ASSET_INFO})`;

const gallery = (column: "novel_id" | "character_id", value: string) =>
  db().from("character_images").select(CHARACTER_IMAGE).eq(column, value).order("sort_order").order("created_at");

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

/**
 * The first bytes of a stored file and its total size, without downloading it
 * (originals can be 50 MB). Null when the file doesn't exist.
 */
export async function readHead(path: string, length: number): Promise<{ bytes: Uint8Array; total: number } | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${encoded}`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, range: `bytes=0-${length - 1}` },
    cache: "no-store",
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {}); // small error body; read it so the connection is released
    return null;
  }
  // Read at most `length` bytes, even if the server ignored the range.
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  while (read < length) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
  const total = range ? Number(range[1]) : Number(res.headers.get("content-length") ?? read);
  return { bytes: bytes.subarray(0, length), total };
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
