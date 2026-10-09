import "server-only";
import { assertId, db, getChapter, getMemory, getNovel } from "../supabase";
import { HttpError } from "../http";
import { chapterLabel, estimateTokens, nameMatcher } from "../ai/context";
import { confirmTokens } from "../ai/models";
import { formatCharacter } from "../ai/prompts";
import { compileGuide } from "../guide";
import { completeJson, InvalidOutput } from "../ai/structured";
import { recordUsage } from "../ai/usage";
import { chapterRows, digestRows, novelDigestRow, readableText, threadRows } from "../advisor/reading";
import { freshness, measureChange, textSketch } from "../advisor/freshness";
import { findQuote } from "../advisor/quotes";
import type { ContextPart, ProviderId } from "../types";
import { CRITIC_INSTRUCTIONS, criticPrompt, type CriticPromptInput } from "./prompts";
import { CritiqueError, parseCritique, type ParsedCritique } from "./schema";
import type { Critique, CritiqueView } from "./types";

/**
 * The Crítico Literario (docs/critico.md): one finished chapter, one call, one report. It
 * reads the chapter whole and what the novel says about itself (the Guía, digests of the
 * chapters before, open threads, the people in it). Not the synopsis, the notes or the
 * Argumento general: they hold the author's plan and secrets, and the Crítico reads as a
 * reader who has got this far. It never reads the Consejero, its
 * conversations or observations, nor its own earlier reports: an independent judgement. It
 * writes nothing but its report: the manuscript and the Memoria are only read.
 */

const OUTPUT_TOKENS = 5000;
/** The end of the previous chapter, literally: continuity, and a passage a contradiction can quote. */
const PREVIOUS_ENDING_CHARS = 2500;
const CHARACTER_CHARS = 700;
const MAX_CHARACTERS = 8;
/** Literal anchor quotes per earlier chapter, from its digest (checked against the text first). */
const QUOTES_PER_CHAPTER = 6;

export type EvaluateOutcome = { done: true; critique: CritiqueView } | { done: false; confirm: { tokens: number; limit: number } };

/** The request for one chapter, and what it is made of (for «Leyó: …»). */
export async function buildCriticRequest(chapterId: string) {
  const chapter = await getChapter(chapterId);
  const novel = await getNovel(chapter.novel_id);
  if (!chapter.content.trim()) throw new HttpError(400, "El capítulo está vacío: no hay nada que evaluar.");
  const [chapters, digests, global, threads, memory] = await Promise.all([
    chapterRows(novel.id),
    digestRows(novel.id),
    novelDigestRow(novel.id),
    threadRows(novel.id),
    getMemory(novel.id),
  ]);
  const index = chapters.findIndex((c) => c.id === chapter.id);
  const before = chapters.slice(0, Math.max(0, index));
  const byChapter = new Map(digests.map((d) => [d.chapter_id, d]));

  const earlier: CriticPromptInput["earlier"] = [];
  const missing: string[] = [];
  let stale = 0;
  for (const [i, c] of before.entries()) {
    const d = byChapter.get(c.id);
    const label = chapterLabel(i, c.title);
    if (!d) {
      if (c.content.trim()) missing.push(label);
      continue;
    }
    const outdated = freshness(d, c).status === "stale";
    if (outdated) stale++;
    // Only quotes still in the text travel as «literal passages»: the manuscript wins.
    const quotes = [...d.events, ...d.revelations]
      .map((x) => x.quote)
      .filter((q) => q && findQuote(c.content, q) !== null)
      .slice(0, QUOTES_PER_CHAPTER);
    earlier.push({ label, summary: d.summary, quotes, outdated });
  }

  const prev = before.at(-1);
  const previousEnding = prev?.content.trim()
    ? { label: chapterLabel(before.length - 1, prev.title), text: (await readableText(novel.id, prev.content)).slice(-PREVIOUS_ENDING_CHARS) }
    : null;
  const people = memory.characters.filter((c) => nameMatcher(c)?.test(chapter.content)).slice(0, MAX_CHARACTERS);
  const input: CriticPromptInput = {
    label: chapterLabel(index, chapter.title),
    text: await readableText(novel.id, chapter.content),
    guide: compileGuide(novel),
    novelSummary: global?.summary ?? null,
    earlier,
    missingDigests: missing,
    previousEnding,
    threads: threads.filter((t) => t.status === "open").map((t) => t.title),
    characters: people.map((c) => formatCharacter(c).slice(0, CHARACTER_CHARS)),
  };
  const prompt = criticPrompt(input);

  const t = (s: string) => estimateTokens(s.length);
  const parts: ContextPart[] = [
    { label: "Instrucciones del Crítico", tokens: t(CRITIC_INSTRUCTIONS) },
    { label: `${input.label} completo`, tokens: t(input.text) },
    { label: "Guía Maestra", tokens: t(input.guide) },
    ...(input.novelSummary ? [{ label: "Resumen global", tokens: t(input.novelSummary) }] : []),
    ...(earlier.length ? [{ label: `Fichas de ${earlier.length} capítulos anteriores`, tokens: t(earlier.map((e) => e.summary + e.quotes.join("")).join("")) }] : []),
    ...(previousEnding ? [{ label: `Final de ${previousEnding.label}`, tokens: t(previousEnding.text) }] : []),
    ...(people.length ? [{ label: `Fichas de ${people.length} personajes`, tokens: t(input.characters.join("")) }] : []),
  ];
  return {
    chapter,
    novel,
    index,
    prompt,
    parts,
    estimate: t(CRITIC_INSTRUCTIONS + prompt) + OUTPUT_TOKENS,
    missingDigests: missing.length,
    staleDigests: stale,
    // The manuscript a contradiction is checked against: every chapter up to this one.
    manuscript: [...before.map((c) => c.content), chapter.content],
  };
}

export async function evaluateChapter(opts: {
  chapterId: string;
  provider: ProviderId;
  signal: AbortSignal;
  approvedTokens?: number;
}): Promise<EvaluateOutcome> {
  const req = await buildCriticRequest(opts.chapterId);
  const limit = confirmTokens();
  if (req.estimate > limit && !(opts.approvedTokens && opts.approvedTokens >= req.estimate))
    return { done: false, confirm: { tokens: req.estimate, limit } };

  const usage = { input: 0, cached: 0, output: 0, costUsd: null as number | null };
  let attempt = 0;
  const { value, model } = await completeJson<ParsedCritique>(
    opts.provider,
    {
      instructions: CRITIC_INSTRUCTIONS,
      manuscript: null,
      project: "",
      prompt: req.prompt,
      signal: opts.signal,
      role: "critic",
      maxOutputTokens: OUTPUT_TOKENS,
    },
    (raw) => {
      // The first answer is held to every rule; the retry is taken as it comes, with what fails marked.
      const strict = attempt++ === 0;
      try {
        return parseCritique(raw, { text: req.chapter.content, manuscript: req.manuscript, strict });
      } catch (e) {
        throw e instanceof CritiqueError ? new InvalidOutput(e.message) : e;
      }
    },
    async (u) => {
      usage.input += u.input;
      usage.cached += u.cached;
      usage.output += u.output;
      if (u.costUsd != null) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
      await recordUsage(req.novel.id, "critic", opts.provider, u);
    },
  );

  const { data, error } = await db()
    .from("chapter_critiques")
    .insert({
      novel_id: req.novel.id,
      chapter_id: req.chapter.id,
      source_revision: req.chapter.revision,
      text_sketch: textSketch(req.chapter.content),
      ...value,
      context: { parts: req.parts, missingDigests: req.missingDigests, staleDigests: req.staleDigests, ...usage },
      provider: opts.provider,
      model,
    })
    .select("*")
    .single();
  if (error) throw error;
  return { done: true, critique: toView(data as Critique, req.chapter) };
}

/** The chapter's reports, newest first, each with whether the chapter changed since. */
export async function listCritiques(chapterId: string): Promise<CritiqueView[]> {
  const chapter = await getChapter(chapterId);
  const { data, error } = await db()
    .from("chapter_critiques")
    .select("*")
    .eq("chapter_id", chapter.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as Critique[]).map((c) => toView(c, chapter));
}

export function toView(c: Critique, chapter: { revision: number; content: string }): CritiqueView {
  const status =
    c.source_revision === chapter.revision ? "current" : measureChange(c.text_sketch, chapter.content).substantial ? "stale" : "touched";
  const quotes = [
    ...c.scores.flatMap((s) => s.refs.map((r) => r.quote)),
    ...c.experience.stretches.map((s) => s.quote),
    ...c.strengths.map((p) => p.quote),
    ...c.weaknesses.map((p) => p.quote),
    ...c.contradictions.map((x) => x.quote),
  ].filter(Boolean);
  const at = Object.fromEntries(quotes.map((q) => [q, findQuote(chapter.content, q)]));
  return { ...c, overall_score: Number(c.overall_score), average: Number(c.average), status, at };
}

/** The author's answer to a report: theirs alone. It never changes the report, and the Crítico never reads it. */
export async function respondToCritique(id: string, patch: { response?: unknown; note?: unknown }) {
  const update: Record<string, unknown> = {};
  if (patch.response !== undefined) {
    if (patch.response !== null && patch.response !== "agree" && patch.response !== "disagree")
      throw new HttpError(400, "La respuesta debe ser «de acuerdo» o «en desacuerdo».");
    update.author_response = patch.response;
  }
  if (patch.note !== undefined) {
    if (typeof patch.note !== "string") throw new HttpError(400, "La nota debe ser texto.");
    update.author_note = patch.note.trim().slice(0, 2000);
  }
  if (!Object.keys(update).length) throw new HttpError(400, "No hay nada que cambiar.");
  const { data, error } = await db().from("chapter_critiques").update(update).eq("id", assertId(id, "Informe")).select("id");
  if (error) throw error;
  if (!data.length) throw new HttpError(404, "Ese informe no existe.");
}

export async function deleteCritique(id: string) {
  const { data, error } = await db().from("chapter_critiques").delete().eq("id", assertId(id, "Informe")).select("id");
  if (error) throw error;
  if (!data.length) throw new HttpError(404, "Ese informe no existe.");
}
