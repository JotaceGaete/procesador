import "server-only";
import { assertId, db } from "./supabase";
import { HttpError } from "./http";
import {
  deleteUnusedAssets,
  getCharacterImages,
  getManuscriptImage,
  getManuscriptImages,
  getNovelImages,
} from "./assets-server";
import type { CharacterImage, ManuscriptImage } from "./types";
import { imageIds, marker } from "./manuscript";
import { assertImageChapterUnlocked } from "./chapter-lock-server";

/**
 * Uses of a file (docs/archivos.md): a character's gallery and the manuscript.
 * Lugares/Investigación will add their own kinds.
 */
export type Use =
  | { kind: "character"; character_id: string; caption: string; stage_label: string }
  /** A new image of the book. `id` lets the editor place its marker before the upload ends. */
  | ({ kind: "manuscript"; id?: string } & Partial<ManuscriptFields>)
  /**
   * Replaces the file of a gallery or manuscript image. `scope: "use"` changes only
   * that image; `scope: "all"` every use of its current file, in any table. The
   * image keeps its id, texts, order, main status and position either way.
   */
  | { kind: "replace"; target: "character" | "manuscript"; id: string; scope: "use" | "all" };

export interface UseResult {
  /** A character's gallery (new gallery image) or the novel's (replacement). */
  images?: CharacterImage[];
  /** The novel's manuscript images (replacement). */
  manuscriptImages?: ManuscriptImage[];
  /** The new image of the book. */
  manuscriptImage?: ManuscriptImage;
}

export interface ManuscriptFields {
  alt: string;
  decorative: boolean;
  caption: string;
  credit: string;
  layout: "inline" | "page";
  align: "center" | "left" | "right";
  width_pct: 25 | 50 | 75 | 100;
}

const text = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The editorial fields present in a body, validated. Missing ones are left out. */
export function readManuscriptFields(body: Record<string, unknown>): Partial<ManuscriptFields> {
  const out: Partial<ManuscriptFields> = {};
  if (typeof body.alt === "string") out.alt = text(body.alt, 1000);
  if (typeof body.caption === "string") out.caption = text(body.caption, 2000);
  if (typeof body.credit === "string") out.credit = text(body.credit, 500);
  if ("decorative" in body) {
    if (typeof body.decorative !== "boolean") throw new HttpError(400, "Valor inválido para decorativa");
    out.decorative = body.decorative;
  }
  if ("layout" in body) {
    if (body.layout !== "inline" && body.layout !== "page") throw new HttpError(400, "Disposición inválida");
    out.layout = body.layout;
  }
  if ("align" in body) {
    if (!["center", "left", "right"].includes(body.align as string)) throw new HttpError(400, "Alineación inválida");
    out.align = body.align as ManuscriptFields["align"];
  }
  if ("width_pct" in body) {
    if (![25, 50, 75, 100].includes(body.width_pct as number)) throw new HttpError(400, "Ancho inválido");
    out.width_pct = body.width_pct as ManuscriptFields["width_pct"];
  }
  return out;
}

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
  if (use?.kind === "manuscript") {
    return { kind: "manuscript", ...(use.id !== undefined ? { id: assertId(use.id, "Imagen") } : {}), ...readManuscriptFields(use) };
  }
  if (use?.kind === "replace") {
    if (use.scope !== "use" && use.scope !== "all") throw new HttpError(400, "Indica si se reemplaza sólo aquí o en todos los usos.");
    if (use.character_image_id !== undefined) {
      return { kind: "replace", target: "character", id: assertId(use.character_image_id, "Imagen"), scope: use.scope };
    }
    return { kind: "replace", target: "manuscript", id: assertId(use.manuscript_image_id, "Imagen"), scope: use.scope };
  }
  throw new HttpError(400, "Indica dónde se usa la imagen.");
}

/** Applies a use of a ready file of `novelId`. */
export async function applyUse(use: Use, assetId: string, novelId: string): Promise<UseResult> {
  if (use.kind === "character") return { images: await addCharacterImage(use, assetId) };
  if (use.kind === "manuscript") return { manuscriptImage: await addManuscriptImage(use, assetId, novelId) };
  return replaceFile(use, assetId);
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
 * A new image of the book, not placed yet: its marker is in the editor's text
 * and the next chapter save places it. The composite key rejects a file of another novel.
 */
async function addManuscriptImage(use: Extract<Use, { kind: "manuscript" }>, assetId: string, novelId: string) {
  const { kind: _, id, ...fields } = use;
  const { data, error } = await db()
    .from("manuscript_images")
    .insert({ ...(id ? { id } : {}), novel_id: novelId, asset_id: assetId, ...fields })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new HttpError(409, "Esa imagen ya existe.");
    throw error;
  }
  // Its marker may already be in a chapter (inserted while the file uploaded): place it now,
  // without waiting for that chapter's next save.
  const { data: chapters, error: chapterError } = await db()
    .from("chapters")
    .select("id, content")
    .eq("novel_id", novelId)
    .like("content", `%${marker(data.id)}%`);
  if (chapterError) throw chapterError;
  const home = chapters.find((c) => imageIds(c.content).includes(data.id));
  if (home) {
    const { error: placeError } = await db().from("manuscript_images").update({ chapter_id: home.id }).eq("id", data.id);
    if (placeError) throw placeError;
  }
  return (await getManuscriptImage(data.id))!;
}

/**
 * Points an image (or every use of its file) at another file, in one transaction.
 * The previous file is deleted only if nothing uses it any more: a file shared
 * with another image survives a "this image only" replacement.
 */
async function replaceFile(use: Extract<Use, { kind: "replace" }>, assetId: string): Promise<UseResult> {
  const table = use.target === "character" ? "character_images" : "manuscript_images";
  const { data: image, error } = await db().from(table).select("novel_id").eq("id", use.id).maybeSingle();
  if (error) throw error;
  if (!image) throw new HttpError(404, "Imagen no encontrada");
  if (use.target === "manuscript") await assertImageChapterUnlocked(use.id);
  const { data: previous, error: rpcError } = await db().rpc("replace_asset_uses", {
    p_kind: use.target,
    p_use: use.id,
    p_new: assetId,
    p_all: use.scope === "all",
  });
  if (rpcError) throw rpcError;
  if (previous !== assetId) await deleteUnusedAssets([previous as string]);
  const [images, manuscriptImages] = await Promise.all([getNovelImages(image.novel_id), getManuscriptImages(image.novel_id)]);
  return { images, manuscriptImages };
}
