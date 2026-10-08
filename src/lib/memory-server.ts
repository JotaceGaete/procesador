import "server-only";
import { db } from "./supabase";
import { HttpError } from "./http";
import { resolveRelation } from "./relations";

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

/**
 * Relaciones personalizadas (docs/relaciones.md): the kind to store, as the form does it, so no
 * path writes a trivial duplicate («Amante  de» when the novel already says «amante de»).
 */
export async function relationKind(novelId: string, typed: string, except?: string): Promise<string> {
  const { data, error } = await db().from("relationships").select("id, kind").eq("novel_id", novelId).order("created_at");
  if (error) throw error;
  return resolveRelation(typed, data, except).kind;
}
