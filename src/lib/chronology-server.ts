import "server-only";
import { db, getChapterTexts, getMemory, getOutline } from "./supabase";
import { HttpError } from "./http";
import {
  chronology,
  parseAgeAnchor,
  parseStoryDate,
  type AgeAnchor,
  type Chronology,
  type StoryDate,
  type TimeMark,
} from "./chronology";
import type { Character, Memory, Novel } from "./types";

/** The novel's time marks (v1: one at the start of each chapter that has one). */
export async function getTimeMarks(novelId: string): Promise<TimeMark[]> {
  const { data, error } = await db().from("time_marks").select("chapter_id, when, flashback, label").eq("novel_id", novelId);
  if (error) throw error;
  return data as TimeMark[];
}

/**
 * The novel's chronology. With `texts`, who appears where is read from the chapters (for
 * the warnings); without, only times and ages (cheaper, enough for the AI's context).
 */
export async function novelChronology(
  novel: Pick<Novel, "id" | "calendar">,
  opts: { texts?: boolean; memory?: Memory; chapters?: { id: string; title: string; content?: string }[] } = {},
): Promise<{ result: Chronology; chapters: { id: string; title: string }[]; characters: Character[]; marks: TimeMark[] }> {
  const [marks, memory, chapters] = await Promise.all([
    getTimeMarks(novel.id),
    opts.memory ?? getMemory(novel.id),
    opts.chapters ?? (opts.texts ? getChapterTexts(novel.id) : getOutline(novel.id)),
  ]);
  const result = chronology({
    calendar: novel.calendar,
    chapters,
    marks,
    characters: memory.characters,
    relationships: memory.relationships,
  });
  return { result, chapters, characters: memory.characters, marks };
}

/**
 * The time fields of a character, validated: only those present in the body. An anchor
 * "age in a chapter" must point to a chapter of the same novel.
 */
export async function readCharacterTime(
  body: Record<string, unknown>,
  novelId: string,
): Promise<{ age_anchor?: AgeAnchor | null; age_approx?: boolean; death?: StoryDate | null }> {
  const out: { age_anchor?: AgeAnchor | null; age_approx?: boolean; death?: StoryDate | null } = {};
  try {
    if ("age_anchor" in body) out.age_anchor = parseAgeAnchor(body.age_anchor);
    if ("death" in body) out.death = parseStoryDate(body.death);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if ("age_approx" in body) {
    if (typeof body.age_approx !== "boolean") throw new HttpError(400, "Edad aproximada: sí o no.");
    out.age_approx = body.age_approx;
  }
  const a = out.age_anchor;
  if (a?.kind === "age_at" && "chapter_id" in a.at) {
    const { data, error } = await db().from("chapters").select("id").eq("id", a.at.chapter_id).eq("novel_id", novelId).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(400, "Ese capítulo no es de esta novela.");
  }
  return out;
}
