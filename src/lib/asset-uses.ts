import "server-only";
import { assertId, db } from "./supabase";
import { HttpError } from "./http";
import { deleteUnusedAssets, getCharacterImages, getNovelImages } from "./assets-server";
import type { CharacterImage } from "./types";

/**
 * Uses of a file (docs/archivos.md). Today: a character's gallery. The image of
 * the manuscript (Prioridad 2b) and Lugares/Investigación add their own kinds.
 */
export type Use =
  | { kind: "character"; character_id: string; caption: string; stage_label: string }
  /**
   * Replaces the file of a gallery image. `scope: "use"` changes only that image;
   * `scope: "all"` changes every use of its current file. The image keeps its id,
   * caption, stage label, order and main-image status either way.
   */
  | { kind: "replace"; character_image_id: string; scope: "use" | "all" };

const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

/** Reads the `use` of an upload, of a reused file or of a replacement. */
export function readUse(value: unknown): Use {
  let use: Record<string, unknown>;
  try {
    use = typeof value === "string" ? JSON.parse(value) : (value as Record<string, unknown>);
  } catch {
    throw new HttpError(400, "Uso inválido");
  }
  if (use?.kind === "character") {
    return {
      kind: "character",
      character_id: assertId(use.character_id, "Personaje"),
      caption: text(use.caption),
      stage_label: text(use.stage_label),
    };
  }
  if (use?.kind === "replace") {
    if (use.scope !== "use" && use.scope !== "all") throw new HttpError(400, "Indica si se reemplaza sólo aquí o en todos los usos.");
    return { kind: "replace", character_image_id: assertId(use.character_image_id, "Imagen"), scope: use.scope };
  }
  throw new HttpError(400, "Indica dónde se usa la imagen.");
}

/**
 * Applies a use of a ready file. A new gallery image returns that character's
 * gallery; a replacement returns the whole novel's (with `scope: "all"` other
 * characters may change too).
 */
export async function applyUse(use: Use, assetId: string): Promise<CharacterImage[]> {
  return use.kind === "character" ? addCharacterImage(use, assetId) : replaceFile(use, assetId);
}

/**
 * Adds a file to a character's gallery and returns the gallery. The composite
 * foreign keys reject a character or a file from another novel; the database
 * places it last, makes the first one primary and enforces the limit.
 */
async function addCharacterImage(use: Extract<Use, { kind: "character" }>, assetId: string) {
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

/**
 * Points a gallery image (or every use of its file) at another file, in one
 * transaction. The previous file is deleted only if nothing uses it any more:
 * a file shared with another character survives a "this image only" replacement.
 */
async function replaceFile(use: Extract<Use, { kind: "replace" }>, assetId: string) {
  const { data: image, error } = await db()
    .from("character_images")
    .select("novel_id")
    .eq("id", use.character_image_id)
    .maybeSingle();
  if (error) throw error;
  if (!image) throw new HttpError(404, "Imagen no encontrada");
  const { data: previous, error: rpcError } = await db().rpc("replace_asset_uses", {
    p_use: use.character_image_id,
    p_new: assetId,
    p_all: use.scope === "all",
  });
  if (rpcError) throw rpcError;
  if (previous !== assetId) await deleteUnusedAssets([previous as string]);
  return getNovelImages(image.novel_id);
}
