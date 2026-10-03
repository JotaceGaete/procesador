import "server-only";
import { db, getChapter, getMemory, getNovel } from "../supabase";
import { HttpError } from "../http";
import { countWords, describeImages } from "../manuscript";
import { chapterLabel, estimateTokens } from "../ai/context";
import { confirmTokens } from "../ai/models";
import { completeJson, InvalidOutput } from "../ai/structured";
import { recordUsage } from "../ai/usage";
import type {
  ChapterDigest,
  DigestThread,
  NovelDigest,
  ProviderId,
  StoryThread,
  ThreadChange,
} from "../types";
import { changeThresholds, freshness, textSketch, type ChangeMeasure, type Freshness } from "./freshness";
import { parseChapterDigest, parseNovelDigest, SchemaError } from "./digest-schema";
import { findQuote, type Located } from "./quotes";
import { DIGEST_INSTRUCTIONS, NOVEL_DIGEST_INSTRUCTIONS, digestPrompt, novelDigestPrompt } from "./prompts";

/**
 * The Consejero's reading of the novel (docs/consejero.md, phase 2): chapter digests,
 * story threads and the global summary. All derived from the manuscript, which always
 * wins; generated lazily and visibly, never while the author types.
 */

/** Output reserved for a chapter digest, for the estimate shown before reading. */
const DIGEST_OUTPUT_TOKENS = 2000;

interface ChapterRow {
  id: string;
  title: string;
  content: string;
  revision: number;
}

export async function chapterRows(novelId: string): Promise<ChapterRow[]> {
  const { data, error } = await db()
    .from("chapters")
    .select("id, title, content, revision")
    .eq("novel_id", novelId)
    .order("position")
    .order("created_at");
  if (error) throw error;
  return data;
}

export async function digestRows(novelId: string): Promise<ChapterDigest[]> {
  const { data, error } = await db().from("chapter_digests").select("*").eq("novel_id", novelId);
  if (error) throw error;
  return data as ChapterDigest[];
}

export async function threadRows(novelId: string): Promise<StoryThread[]> {
  const { data, error } = await db().from("story_threads").select("*").eq("novel_id", novelId).order("created_at");
  if (error) throw error;
  return data as StoryThread[];
}

export async function novelDigestRow(novelId: string): Promise<NovelDigest | null> {
  const { data, error } = await db().from("novel_digests").select("*").eq("novel_id", novelId).maybeSingle();
  if (error) throw error;
  return data as NovelDigest | null;
}

/** The chapter as the model reads it: image markers become their description. */
export async function readableText(novelId: string, text: string): Promise<string> {
  if (!text.includes("[[imagen:")) return text;
  const { data, error } = await db().from("manuscript_images").select("id, alt, caption, decorative").eq("novel_id", novelId);
  if (error) throw error;
  const d = new Map(data.map((i) => [i.id, i.decorative ? "decorativa" : i.alt || i.caption]));
  return describeImages(text, (id) => d.get(id) ?? "");
}

export const digestEstimate = (content: string) => estimateTokens(DIGEST_INSTRUCTIONS.length + content.length + 1500);

// ---------------------------------------------------------------------------
// State for the panel
// ---------------------------------------------------------------------------

type Ref<T> = T & { at: Located | null };

export interface ChapterReading {
  id: string;
  title: string;
  words: number;
  status: Freshness;
  change: ChangeMeasure | null;
  /** Input tokens a (re)reading would send. */
  estimate: number;
  digest:
    | (Omit<ChapterDigest, "events" | "revelations" | "threads"> & {
        events: Ref<ChapterDigest["events"][number]>[];
        revelations: Ref<ChapterDigest["revelations"][number]>[];
        threads: Ref<DigestThread>[];
      })
    | null;
}

export interface ReadingState {
  auto: boolean;
  confirmTokens: number;
  chapters: ChapterReading[];
  threads: StoryThread[];
  novel: (NovelDigest & { status: "current" | "stale" }) | null;
  novelEstimate: number;
}

export async function readingState(novelId: string): Promise<ReadingState> {
  const novel = await getNovel(novelId);
  const [chapters, digests, threads, global] = await Promise.all([
    chapterRows(novel.id),
    digestRows(novel.id),
    threadRows(novel.id),
    novelDigestRow(novel.id),
  ]);
  const byChapter = new Map(digests.map((d) => [d.chapter_id, d]));
  const order = new Map(chapters.map((c, i) => [c.id, i]));

  const list: ChapterReading[] = chapters.map((c) => {
    const d = byChapter.get(c.id) ?? null;
    const { status, change } = freshness(d, c);
    // Each quote with its place in the saved text, for "Ir"; null when it isn't there any more.
    const locate = <T extends { quote: string }>(x: T): Ref<T> => ({ ...x, at: x.quote ? findQuote(c.content, x.quote) : null });
    return {
      id: c.id,
      title: c.title,
      words: countWords(c.content),
      status,
      change,
      estimate: digestEstimate(c.content),
      digest: d
        ? { ...d, events: d.events.map(locate), revelations: d.revelations.map(locate), threads: d.threads.map(locate) }
        : null,
    };
  });

  // Open threads first, in the order they appear in the novel.
  const pos = (id: string | null) => (id && order.has(id) ? order.get(id)! : Infinity);
  const sorted = [...threads].sort(
    (a, b) => Number(a.status !== "open") - Number(b.status !== "open") || pos(a.opened_chapter_id) - pos(b.opened_chapter_id),
  );

  return {
    auto: novel.auto_digest,
    confirmTokens: confirmTokens(),
    chapters: list,
    threads: sorted,
    novel: global ? { ...global, status: novelDigestFresh(global, digests) ? "current" : "stale" } : null,
    novelEstimate: estimateTokens(NOVEL_DIGEST_INSTRUCTIONS.length + digests.reduce((n, d) => n + d.summary.length + 400, 0)),
  };
}

/** The summary is current while it was made from exactly the digests there are now. */
function novelDigestFresh(global: NovelDigest, digests: ChapterDigest[]): boolean {
  const based = global.based_on ?? {};
  if (Object.keys(based).length !== digests.length) return false;
  return digests.every(
    (d) => based[d.chapter_id] === d.source_revision && new Date(d.updated_at) <= new Date(global.updated_at),
  );
}

// ---------------------------------------------------------------------------
// Chapter digest
// ---------------------------------------------------------------------------

export type DigestOutcome =
  | { done: true; status: Freshness; unverified: number }
  | { done: false; reason: string };

/**
 * Reads one chapter. `auto` is the switch's path, when the author leaves a chapter: it
 * only reads when the change was substantial (or a chapter of some length was never
 * read), never over the author's own corrections, and never above the confirmation
 * threshold. Without `auto`, the author asked: it reads, except over their corrections
 * unless `force`.
 */
export async function digestChapter(opts: {
  chapterId: string;
  provider: ProviderId;
  signal: AbortSignal;
  auto?: boolean;
  force?: boolean;
}): Promise<DigestOutcome> {
  const chapter = await getChapter(opts.chapterId);
  const novel = await getNovel(chapter.novel_id);
  const { data: existing, error } = await db()
    .from("chapter_digests")
    .select("*")
    .eq("chapter_id", chapter.id)
    .maybeSingle();
  if (error) throw error;
  const current = existing as ChapterDigest | null;
  const { status } = freshness(current, chapter);

  if (opts.auto) {
    if (!novel.auto_digest) return { done: false, reason: "automatización desactivada" };
    if (status === "current" || status === "touched") return { done: false, reason: "sin cambios sustanciales" };
    if (current?.author_edited) return { done: false, reason: "ficha corregida por el autor" };
    if (status === "missing" && countWords(chapter.content) < changeThresholds().words)
      return { done: false, reason: "capítulo breve" };
    if (digestEstimate(chapter.content) > confirmTokens()) return { done: false, reason: "demasiado grande para leerlo solo" };
  } else if (current?.author_edited && !opts.force) {
    throw new HttpError(409, "Esta ficha tiene correcciones tuyas. Regenerarla las reemplaza.");
  }
  if (!chapter.content.trim()) throw new HttpError(400, "El capítulo está vacío.");

  const [chapters, memory, threads] = await Promise.all([
    chapterRows(novel.id),
    getMemory(novel.id),
    threadRows(novel.id),
  ]);
  const index = chapters.findIndex((c) => c.id === chapter.id);
  const prev = index > 0 ? chapters[index - 1] : null;
  let previousSummary: string | null = null;
  if (prev) {
    const { data } = await db().from("chapter_digests").select("summary").eq("chapter_id", prev.id).maybeSingle();
    previousSummary = data?.summary || null;
  }

  const characterIds = new Set(memory.characters.map((c) => c.id));
  const threadIds = new Set(threads.map((t) => t.id));
  const { value, model } = await completeJson(
    opts.provider,
    {
      instructions: DIGEST_INSTRUCTIONS,
      manuscript: null,
      project: "",
      prompt: digestPrompt({
        label: chapterLabel(index, chapter.title),
        text: await readableText(novel.id, chapter.content),
        characters: memory.characters.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
        threads: threads.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status })),
        previousSummary,
      }),
      signal: opts.signal,
      role: "digest",
    },
    (raw) => {
      try {
        // Quotes are checked against the real text (markers are not prose).
        return parseChapterDigest(raw, { text: chapter.content, characterIds, threadIds });
      } catch (e) {
        throw e instanceof SchemaError ? new InvalidOutput(e.message) : e;
      }
    },
    (u) => recordUsage(novel.id, "digest", opts.provider, u),
  );

  // New threads become "possible threads" (unconfirmed); one with the same title is reused.
  const refs: DigestThread[] = [];
  for (const t of value.threads) {
    let id = t.thread;
    if (!id) {
      const same = threads.find((x) => x.title.toLocaleLowerCase("es") === t.title.toLocaleLowerCase("es"));
      if (same) id = same.id;
      else {
        const { data, error: e } = await db()
          .from("story_threads")
          .insert({ novel_id: novel.id, title: t.title, kind: t.kind, origin: "advisor" })
          .select("*")
          .single();
        if (e) throw e;
        threads.push(data as StoryThread);
        id = data.id as string;
      }
    }
    if (!refs.some((r) => r.thread === id)) refs.push({ thread: id, change: t.change, quote: t.quote });
  }

  const { error: upsertError } = await db()
    .from("chapter_digests")
    .upsert({
      chapter_id: chapter.id,
      novel_id: novel.id,
      source_revision: chapter.revision,
      text_sketch: textSketch(chapter.content),
      summary: value.summary,
      events: value.events,
      presence: value.presence,
      revelations: value.revelations,
      threads: refs,
      notes: value.notes,
      author_edited: false,
      model,
    });
  if (upsertError) throw upsertError;
  await recomputeThreads(novel.id);
  return { done: true, status: "current", unverified: value.unverified };
}

/** The author's correction of a digest: it prevails and is not overwritten automatically. */
export async function editDigest(chapterId: string, patch: { summary?: string; notes?: string }) {
  const chapter = await getChapter(chapterId);
  const update: Record<string, unknown> = { author_edited: true };
  if (typeof patch.summary === "string") {
    if (patch.summary.trim().length < 1) throw new HttpError(400, "El resumen no puede quedar vacío.");
    update.summary = patch.summary.trim().slice(0, 4000);
  }
  if (typeof patch.notes === "string") update.notes = patch.notes.trim().slice(0, 600);
  const { data, error } = await db().from("chapter_digests").update(update).eq("chapter_id", chapter.id).select("chapter_id");
  if (error) throw error;
  if (!data.length) throw new HttpError(404, "Este capítulo aún no tiene ficha.");
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * Where each thread opens, last appears and closes comes from the digests, in chapter
 * order; so re-reading a chapter that no longer closes a thread reopens it. A status the
 * author set stays. A possible thread (the Consejero's, unconfirmed) that no digest
 * mentions any more is removed.
 */
export async function recomputeThreads(novelId: string) {
  const [chapters, digests, threads] = await Promise.all([chapterRows(novelId), digestRows(novelId), threadRows(novelId)]);
  const order = chapters.map((c) => c.id);
  const byChapter = new Map(digests.map((d) => [d.chapter_id, d]));
  for (const t of threads) {
    const refs: { chapter: string; change: ThreadChange }[] = [];
    for (const id of order) {
      const r = byChapter.get(id)?.threads.find((x) => x.thread === t.id);
      if (r) refs.push({ chapter: id, change: r.change });
    }
    if (!refs.length && t.origin === "advisor" && !t.confirmed) {
      const { error } = await db().from("story_threads").delete().eq("id", t.id);
      if (error) throw error;
      continue;
    }
    const closed = [...refs].reverse().find((r) => r.change === "closed");
    const opened = refs.find((r) => r.change === "opened") ?? refs[0];
    const next = {
      opened_chapter_id: opened?.chapter ?? null,
      last_chapter_id: refs.at(-1)?.chapter ?? null,
      closed_chapter_id: closed?.chapter ?? null,
      status: t.status_by === "author" ? t.status : closed ? "closed" : "open",
    };
    if (Object.entries(next).some(([k, v]) => t[k as keyof StoryThread] !== v)) {
      const { error } = await db().from("story_threads").update(next).eq("id", t.id);
      if (error) throw error;
    }
  }
}

/** Removes (or, with `into`, moves to another thread) every reference to a thread in the digests. */
export async function rewriteThreadRefs(novelId: string, from: string, into: string | null) {
  for (const d of await digestRows(novelId)) {
    if (!d.threads.some((t) => t.thread === from)) continue;
    const next: DigestThread[] = [];
    for (const t of d.threads) {
      const id = t.thread === from ? into : t.thread;
      if (!id || next.some((x) => x.thread === id)) continue;
      next.push({ ...t, thread: id });
    }
    const { error } = await db().from("chapter_digests").update({ threads: next }).eq("chapter_id", d.chapter_id);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Global summary
// ---------------------------------------------------------------------------

export async function digestNovel(opts: { novelId: string; provider: ProviderId; signal: AbortSignal }) {
  const novel = await getNovel(opts.novelId);
  const [chapters, digests, threads] = await Promise.all([chapterRows(novel.id), digestRows(novel.id), threadRows(novel.id)]);
  const byChapter = new Map(digests.map((d) => [d.chapter_id, d]));
  const read = chapters.map((c, i) => ({ c, i, d: byChapter.get(c.id) })).filter((x) => x.d);
  if (!read.length) throw new HttpError(400, "Primero hay que leer al menos un capítulo.");

  const { value, model } = await completeJson(
    opts.provider,
    {
      instructions: NOVEL_DIGEST_INSTRUCTIONS,
      manuscript: null,
      project: "",
      prompt: novelDigestPrompt({
        chapters: read.map(({ c, i, d }) => ({
          label: chapterLabel(i, c.title),
          summary: d!.summary,
          events: d!.events.map((e) => e.text),
          outdated: freshness(d!, c).status === "stale",
        })),
        threads: threads.map((t) => ({ title: t.title, status: t.status })),
      }),
      signal: opts.signal,
      role: "digest",
    },
    (raw) => {
      try {
        return parseNovelDigest(raw);
      } catch (e) {
        throw e instanceof SchemaError ? new InvalidOutput(e.message) : e;
      }
    },
    (u) => recordUsage(novel.id, "digest", opts.provider, u),
  );
  const { error } = await db()
    .from("novel_digests")
    .upsert({
      novel_id: novel.id,
      summary: value.summary,
      based_on: Object.fromEntries(digests.map((d) => [d.chapter_id, d.source_revision])),
      model,
    });
  if (error) throw error;
}
