import "server-only";
import { db } from "./supabase";
import { toCharacterStates, type CharacterState, type StateRow } from "./narrative-state";

const COLUMNS = "id, character_id, chapter_id, alive, location, knows, physical, objects, status";

/**
 * Los estados de la novela, con la posición de cada capítulo. `chapterIds` va en el orden de
 * la novela. Sólo se usan en la continuidad; la posición se calcula aquí, no se guarda.
 */
export async function loadCharacterStates(novelId: string, chapterIds: string[]): Promise<CharacterState[]> {
  if (!chapterIds.length) return [];
  const { data, error } = await db().from("character_states").select(COLUMNS).eq("novel_id", novelId);
  if (error) throw error;
  return toCharacterStates((data ?? []) as StateRow[], chapterIds);
}
