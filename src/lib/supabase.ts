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
    .select("id, title, synopsis, notes, guide, auto_digest, calendar, dismissed_warnings, book, updated_at")
    .eq("id", assertId(id, "Novela"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Novela no encontrada");
  return { ...data, book: cleanBook(data.book) } as Novel;
}

export async function getOutline(novelId: string): Promise<ChapterInfo[]> {
  const { data, error } = await db().rpc("novel_outline", { p_novel: novelId });
  if (error) throw error;
  return data as ChapterInfo[];
}

export async function getChapter(id: string): Promise<Chapter> {
  const { data, error } = await db()
    .from("chapters")
    .select("id, novel_id, title, content, revision")
    .eq("id", assertId(id, "Capítulo"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Capítulo no encontrado");
  return data as Chapter;
}

/** Text of every chapter, in order (server-side only, for context building). */
export async function getChapterTexts(novelId: string): Promise<{ id: string; title: string; content: string }[]> {
  const { data, error } = await db()
    .from("chapters")
    .select("id, title, content")
    .eq("novel_id", novelId)
    .order("position")
    .order("created_at");
  if (error) throw error;
  return data;
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
