import "server-only";
import { assertId, db } from "./supabase";
import { HttpError } from "./http";
import { getCharacterImages } from "./assets-server";
import type { CharacterImage } from "./types";

/**
 * Uses of a file (docs/archivos.md). Today: a character's gallery. The image of
 * the manuscript (Prioridad 2b) and Lugares/Investigación add their own kinds.
 */
export interface CharacterUse {
  kind: "character";
  character_id: string;
  caption: string;
  stage_label: string;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

/** Reads the `use` of an upload or of a reused file. */
export function readUse(value: unknown): CharacterUse {
  let use: Record<string, unknown>;
  try {
    use = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>);
  } catch {
    throw new HttpError(400, "Uso inválido");
  }
  if (!use || typeof use !== "object" || use.kind !== "character") throw new HttpError(400, "Indica dónde se usa la imagen.");
  return {
    kind: "character",
    character_id: assertId(use.character_id, "Personaje"),
    caption: text(use.caption),
    stage_label: text(use.stage_label),
  };
}

/**
 * Adds a file to a character's gallery and returns the gallery. The composite
 * foreign keys reject a character or a file from another novel; the database
 * places it last, makes the first one primary and enforces the limit.
 */
export async function addCharacterImage(use: CharacterUse, assetId: string): Promise<CharacterImage[]> {
  const { data: character, error } = await db()
    .from("characters")
    .select("id, novel_id")
    .eq("id", use.character_id)
    .maybeSingle();
  if (error) throw error;
  if (!character) throw new HttpError(404, "Personaje no encontrado");
  const { error: insertError } = await db().from("character_images").insert({
    novel_id: character.novel_id,
    character_id: character.id,
    asset_id: assetId,
    caption: use.caption,
    stage_label: use.stage_label,
  });
  if (insertError) throw insertError;
  return getCharacterImages(character.id);
}
