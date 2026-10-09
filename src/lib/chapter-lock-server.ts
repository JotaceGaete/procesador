import "server-only";
import { db } from "./supabase";
import { HttpError } from "./http";
import { LOCKED_MESSAGE } from "./chapter-lock";

/** 423 Locked: the chapter is revisado y bloqueado (docs/bloqueo-capitulos.md). */
export const lockedError = (message = LOCKED_MESSAGE) => new HttpError(423, message);

/** Refuses (423) when the chapter is locked. A missing chapter is not this check's business. */
export async function assertChapterUnlocked(chapterId: string | null | undefined, message = LOCKED_MESSAGE) {
  if (!chapterId) return;
  const { data, error } = await db().from("chapters").select("locked").eq("id", chapterId).maybeSingle();
  if (error) throw error;
  if (data?.locked) throw lockedError(message);
}

/** Refuses (423) changing an image of the book placed in a locked chapter (its caption, its file, deleting it). */
export async function assertImageChapterUnlocked(imageId: string) {
  const { data, error } = await db().from("manuscript_images").select("chapter_id").eq("id", imageId).maybeSingle();
  if (error) throw error;
  await assertChapterUnlocked(data?.chapter_id, "Esta imagen está en un capítulo bloqueado. Desbloquéalo para cambiarla.");
}
