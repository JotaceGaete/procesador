import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http";
import type { Chapter, ChapterInfo, Fact, Memory, Novel } from "./types";
import { cleanBook } from "./book";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.");
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertId(id: unknown, what = "Elemento"): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new HttpError(404, `${what} no encontrado`);
  return id;
}

export async function getNovel(id: string): Promise<Novel> {
  const { data, error } = await db()
    .from("novels")
    .select("id, title, synopsis, notes, plot, guide, auto_digest, calendar, dismissed_warnings, book, updated_at")
    .eq("id", assertId(id, "Novela"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Novela no encontrada");
  return { ...data, book: cleanBook(data.book) } as Novel;
}

/**
 * Every chapter, without the text: the manuscript in order, then the reserve. For the author's
 * own lists (the chapter list, the trash), never for what the AI reads: that is readingOutline.
 */
export async function getOutline(novelId: string): Promise<ChapterInfo[]> {
  const { data, error } = await db().rpc("novel_outline", { p_novel: novelId });
  if (error) throw error;
  return (data as ChapterInfo[]).map((c) => ({ ...c, reserved: c.reserved === true }));
}

export async function getChapter(id: string): Promise<Chapter> {
  const { data, error } = await db()
    .from("chapters")
    .select("id, novel_id, title, content, revision, reserved")
    .eq("id", assertId(id, "Capítulo"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Capítulo no encontrado");
  return { ...data, reserved: data.reserved === true } as Chapter;
}

// ---------------------------------------------------------------------------
// What the AI may read (docs/capitulos-reserva.md)
// ---------------------------------------------------------------------------
//
// The rule, for every request to a model and every derived reading (digests, threads, the
// global summary, the chronology): the manuscript, in order, and — only when the author has a
// chapter in reserve open and asked about it — that chapter, after the manuscript. Never any
// other chapter in reserve. Every function below that feeds a model goes through `inScope`.

/** The chapter the author has open, if the request is about one (its id, or null). */
export type OpenChapter = string | null | undefined;

/** Rows in reading order (the manuscript first, then the reserve), narrowed to what the AI may read. */
export function inScope<T extends { id: string; reserved?: boolean | null }>(rows: T[], open?: OpenChapter): T[] {
  return [...rows.filter((r) => !r.reserved), ...rows.filter((r) => r.reserved && r.id === open)];
}

/** The outline the AI may read: the manuscript, plus the open chapter if it is in reserve. */
export async function readingOutline(novelId: string, open?: OpenChapter): Promise<ChapterInfo[]> {
  return inScope(await getOutline(novelId), open);
}

/** Ids of the chapters the AI may read. */
export async function scopeIds(novelId: string, open?: OpenChapter): Promise<Set<string>> {
  const { data, error } = await db().from("chapters").select("id, reserved").eq("novel_id", novelId);
  if (error) throw error;
  return new Set(inScope(data as { id: string; reserved: boolean }[], open).map((c) => c.id));
}

/**
 * Text of the chapters the AI may read, in order (server-side only, for context building):
 * the manuscript and, if `open` is a chapter in reserve, that one at the end.
 */
export async function getChapterTexts(
  novelId: string,
  open?: OpenChapter,
): Promise<{ id: string; title: string; content: string; reserved: boolean }[]> {
  const { data, error } = await db()
    .from("chapters")
    .select("id, title, content, reserved")
    .eq("novel_id", novelId)
    .order("position")
    .order("created_at");
  if (error) throw error;
  return inScope(data as { id: string; title: string; content: string; reserved: boolean }[], open);
}

/**
 * The Memoria as the AI may read it: without the facts tied to a chapter outside `ids`, and
 * without age anchors set in one. The Memoria the author sees and edits doesn't change.
 */
export function scopeMemory(memory: Memory, ids: Set<string>): Memory {
  return {
    ...memory,
    facts: memory.facts.filter((f) => !f.chapter_id || ids.has(f.chapter_id)),
    characters: memory.characters.map((c) => {
      const a = c.age_anchor;
      return a && a.kind === "age_at" && "chapter_id" in a.at && !ids.has(a.at.chapter_id) ? { ...c, age_anchor: null } : c;
    }),
  };
}

/** getMemory, narrowed to what the AI may read (see scopeMemory). */
export async function getScopedMemory(novelId: string, open?: OpenChapter): Promise<Memory> {
  const [memory, ids] = await Promise.all([getMemory(novelId), scopeIds(novelId, open)]);
  return scopeMemory(memory, ids);
}

/** All narrative memory of one novel. Every query is filtered by novel_id. */
export async function getMemory(novelId: string): Promise<Memory> {
  const by = (table: string, columns = "*") => db().from(table).select(columns).eq("novel_id", novelId).order("created_at");
  const [characters, relationships, places, facts, links] = await Promise.all([
    by("characters"),
    by("relationships"),
    by("places"),
    by("facts"),
    db().from("fact_characters").select("fact_id, character_id").eq("novel_id", novelId),
  ]);
  for (const r of [characters, relationships, places, facts, links]) if (r.error) throw r.error;

  const linksByFact = new Map<string, string[]>();
  for (const l of links.data as { fact_id: string; character_id: string }[]) {
    linksByFact.set(l.fact_id, [...(linksByFact.get(l.fact_id) ?? []), l.character_id]);
  }
  return {
    characters: characters.data as unknown as Memory["characters"],
    relationships: relationships.data as unknown as Memory["relationships"],
    places: places.data as unknown as Memory["places"],
    facts: (facts.data as unknown as Fact[]).map((f) => ({ ...f, character_ids: linksByFact.get(f.id) ?? [] })),
  };
}
