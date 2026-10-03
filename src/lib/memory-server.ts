import "server-only";
import { db } from "./supabase";
import { HttpError } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCharacterIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && UUID.test(v))) {
    throw new HttpError(400, "Personajes inválidos");
  }
  return [...new Set(value as string[])];
}

/**
 * Replaces the characters linked to a fact. The composite foreign key rejects
 * any character that belongs to another novel.
 */
export async function setFactCharacters(factId: string, novelId: string, ids: string[]) {
  const del = await db().from("fact_characters").delete().eq("fact_id", factId);
  if (del.error) throw del.error;
  if (!ids.length) return;
  const ins = await db()
    .from("fact_characters")
    .insert(ids.map((character_id) => ({ fact_id: factId, character_id, novel_id: novelId })));
  if (ins.error) throw ins.error;
}
