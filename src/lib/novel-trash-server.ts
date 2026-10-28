import "server-only";
import { db } from "./supabase";
import { novelFiles, removeFiles } from "./assets-server";
import { trashCutoff } from "./novel-trash";

/**
 * Borra de verdad las novelas eliminadas hace más de 30 días: su fila (con capítulos, versiones y
 * memoria, por cascada) y después sus archivos en Storage. Devuelve cuántas borró.
 */
export async function purgeExpiredNovels(now?: number): Promise<number> {
  const { data, error } = await db()
    .from("novels")
    .select("id")
    .not("deleted_at", "is", null)
    .lt("deleted_at", trashCutoff(now));
  if (error) throw error;
  const expired = data ?? [];
  for (const { id } of expired) {
    const files = await novelFiles(id);
    const { error: deleteError } = await db().from("novels").delete().eq("id", id);
    if (deleteError) throw deleteError;
    await removeFiles(files);
  }
  return expired.length;
}
