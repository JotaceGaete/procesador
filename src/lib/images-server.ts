import "server-only";
import { db } from "./supabase";
import type { CharacterImage } from "./types";

/** Private bucket: no policies on storage.objects, so only the service_role (this server) can use it. */
export const BUCKET = "character-images";

/** Columns sent to the browser (storage paths stay on the server). */
export const IMAGE_COLUMNS =
  "id, novel_id, character_id, content_type, version, caption, stage_label, is_primary, sort_order, width, height, bytes, created_at";

export const bucket = () => db().storage.from(BUCKET);

export async function getNovelImages(novelId: string): Promise<CharacterImage[]> {
  const { data, error } = await db()
    .from("character_images")
    .select(IMAGE_COLUMNS)
    .eq("novel_id", novelId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data as unknown as CharacterImage[];
}

export async function getCharacterImages(characterId: string): Promise<CharacterImage[]> {
  const { data, error } = await db()
    .from("character_images")
    .select(IMAGE_COLUMNS)
    .eq("character_id", characterId)
    .order("sort_order")
    .order("created_at");
  if (error) throw error;
  return data as unknown as CharacterImage[];
}

/** Storage paths of the images matching a filter, read before their rows are deleted. */
export async function imageFiles(column: "id" | "character_id" | "novel_id", value: string): Promise<string[]> {
  const { data, error } = await db().from("character_images").select("storage_path, thumb_path").eq(column, value);
  if (error) throw error;
  return data.flatMap((r) => [r.storage_path, r.thumb_path]);
}

/**
 * Removes files whose rows are already gone. A failure here only leaves an
 * unreachable file (no row serves it), so it is logged and the request succeeds.
 */
export async function removeFiles(paths: string[]) {
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await bucket().remove(paths.slice(i, i + 500));
    if (error) console.error("[storage]", error.message);
  }
}
