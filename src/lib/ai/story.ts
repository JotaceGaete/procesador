import type { Character, ChapterDigest, ContextItem, ContextSection, NovelDigest, StoryThread } from "../types";
import { THREAD_KINDS } from "../types";
import { freshness } from "../advisor/freshness";
import { findQuote } from "../advisor/quotes";
import { chapterLabel, estimateTokens, nameMatcher } from "./context";

/**
 * "La historia hasta aquí" for Desarrollar escena (docs/asistente-contexto.md §1.2–1.4):
 * what the Consejero's reading already knows about the chapters before this point, said
 * to the writer. Read only, no AI call; nothing from after the cursor ever goes:
 *
 *   - the digests of the previous chapters (never the current one, never later ones), with
 *     more detail for the closest and for those where someone of the scene is present;
 *   - what the people of the scene have learned so far (the digests' revelations);
 *   - the threads open at this point (a thread closed later is still open here).
 *
 * The text and its inventory ("Ver contexto") come out of the same pass.
 */

export const STORY_TOKENS = 3000;
export const GLOBAL_TOKENS = 1500;
export const KNOWLEDGE_TOKENS = 600;
export const THREADS_TOKENS = 800;
export const MAX_THREADS = 12;

const chars = (tokens: number) => Math.round(tokens * 3.5);
const tokens = (s: string) => estimateTokens(s.length);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);
const firstSentence = (s: string) => s.trim().split(/(?<=[.!?…])\s/)[0] ?? "";
const list = (n: number[]) => {
  const l = n.map((i) => i + 1);
  return l.length === 1 ? `El capítulo ${l[0]}` : `Los capítulos ${l.slice(0, -1).join(", ")} y ${l.at(-1)}`;
};

export interface StoryInput {
  /** Saved chapters, in order (with their revision, to tell a stale digest). */
  chapters: { id: string; title: string; content: string; revision: number }[];
  currentIndex: number;
  /** The chapter as on screen, and the cursor in it. */
  liveContent: string;
  cursor: number;
  digests: ChapterDigest[];
  threads: StoryThread[];
  global: NovelDigest | null;
  /** The global summary was made from the digests there are now. */
  globalCurrent: boolean;
  /** Nothing after this point but what the scene request already shows (last chapter, near its end). */
  atEnd: boolean;
  /** The people of the scene (as selected for the request) and every name in the novel. */
  characters: Character[];
  names: Map<string, string>;
  /** With the whole novel the digests are redundant: only knowledge and threads go. */
  includeManuscript: boolean;
}

export interface StoryOutput {
  story: string | null;
  knowledge: string | null;
  threads: string | null;
  sections: { story: ContextSection | null; knowledge: ContextSection | null; threads: ContextSection | null };
  notices: string[];
}

type Tier = 1 | 2 | 3;
const TIER_REASON: Record<Tier, string> = { 1: "en detalle", 2: "resumen", 3: "una línea" };

export function storySoFar(input: StoryInput): StoryOutput {
  const { chapters, currentIndex: k } = input;
  const label = (i: number) => chapterLabel(i, chapters[i].title);
  const index = new Map(chapters.map((c, i) => [c.id, i]));
  const byChapter = new Map(input.digests.map((d) => [d.chapter_id, d]));
  const scene = new Set(input.characters.map((c) => c.id));
  const name = (id: string) => input.names.get(id) ?? "?";
  const notices: string[] = [];

  // Threads the writer may hear about: confirmed, or the author's own.
  const trusted = (t: StoryThread) => t.confirmed || t.origin === "author";
  const threadTitle = new Map(input.threads.filter(trusted).map((t) => [t.id, t.title]));

  // Previous chapters with their digest and its state.
  const previous = chapters.slice(0, k).map((c, i) => {
    const d = byChapter.get(c.id) ?? null;
    return { i, d, stale: d ? freshness(d, c).status === "stale" : false };
  });

  // ---- 1.2 the digests of the previous chapters
  let story: string | null = null;
  let storySection: ContextSection | null = null;
  if (!input.includeManuscript) {
    const missing = previous.filter((p) => !p.d).map((p) => p.i);
    if (missing.length)
      notices.push(
        `${list(missing)} no ${missing.length === 1 ? "tiene" : "tienen"} ficha de lectura: la IA no sabe qué pasó ${missing.length === 1 ? "en él" : "en ellos"}. Puedes leer${missing.length === 1 ? "lo" : "los"} en Consejero → Lectura.`,
      );

    const entries = previous
      .filter((p): p is { i: number; d: ChapterDigest; stale: boolean } => Boolean(p.d))
      .map((p) => {
        const tier: Tier =
          p.i >= k - 2 ? 1 : p.d.presence.some((x) => x.kind === "present" && scene.has(x.character)) ? 2 : 3;
        const text = digestText(p.d, label(p.i), tier, p.stale, scene, name, threadTitle);
        return { ...p, tier, text, tokens: tokens(text) };
      });
    // Over budget: the least detailed and oldest go first.
    const kept = [...entries];
    const dropOrder = [...entries].sort((a, b) => b.tier - a.tier || a.i - b.i);
    let total = kept.reduce((n, e) => n + e.tokens, 0);
    let omitted = 0;
    for (const e of dropOrder) {
      if (total <= STORY_TOKENS) break;
      kept.splice(kept.indexOf(e), 1);
      total -= e.tokens;
      omitted++;
    }

    const withGlobal = input.global?.summary.trim() && input.atEnd ? input.global : null;
    const globalText = withGlobal
      ? `<resumen_novela${input.globalCurrent ? "" : ' version="anterior"'}>\n${clip(withGlobal.summary.trim(), chars(GLOBAL_TOKENS))}\n</resumen_novela>`
      : null;

    if (kept.length || globalText) {
      story = [globalText, ...kept.map((e) => e.text)].filter(Boolean).join("\n\n");
      const items: ContextItem[] = [];
      if (globalText)
        items.push({
          label: "Resumen de la novela",
          note: input.globalCurrent ? undefined : "desactualizado",
          detail: clip(withGlobal!.summary.trim(), 300),
        });
      for (const e of kept)
        items.push({
          label: label(e.i),
          reason: TIER_REASON[e.tier],
          note: e.stale ? "ficha desactualizada" : undefined,
          detail: clip(e.d.summary.trim(), 300),
        });
      if (omitted) items.push({ label: `${omitted === 1 ? "1 capítulo antiguo no cabe" : `${omitted} capítulos antiguos no caben`}` });
      storySection = {
        id: "story",
        label: `Lo ocurrido antes: ${kept.length === 1 ? "1 capítulo" : `${kept.length} capítulos`}${globalText ? " y el resumen de la novela" : ""}`,
        tokens: tokens(story),
        items,
      };
    }
  }

  // ---- 1.3 what the people of the scene know by now
  let knowledgeLines: { who: string; text: string; i: number }[] = [];
  for (const p of previous)
    for (const r of p.d?.revelations ?? []) if (scene.has(r.to)) knowledgeLines.push({ who: name(r.to), text: r.text.trim(), i: p.i });
  const knowledgeLine = (l: (typeof knowledgeLines)[number]) => `- ${l.who}: ${l.text} (${label(l.i)})`;
  // Over budget: the oldest go first.
  while (knowledgeLines.length && tokens(knowledgeLines.map(knowledgeLine).join("\n")) > KNOWLEDGE_TOKENS) knowledgeLines = knowledgeLines.slice(1);
  const knowledge = knowledgeLines.length ? knowledgeLines.map(knowledgeLine).join("\n") : null;
  const perPerson = new Map<string, number>();
  for (const l of knowledgeLines) perPerson.set(l.who, (perPerson.get(l.who) ?? 0) + 1);
  const knowledgeSection: ContextSection | null = knowledge
    ? {
        id: "knowledge",
        label: `Lo que saben: ${[...perPerson].map(([w, n]) => `${w} (${n})`).join(", ")}`,
        tokens: tokens(knowledge),
        items: knowledgeLines.map((l) => ({ label: `${l.who}: ${l.text}`, note: label(l.i) })),
      }
    : null;

  // ---- 1.4 threads open at this point
  const current = byChapter.get(chapters[k]?.id) ?? null;
  // Where the current chapter's digest says a thread opens or closes, if that is before the cursor.
  // null: the digest doesn't say where (or the quote is no longer in the text).
  const beforeCursor = (threadId: string, change?: "opened" | "advanced" | "closed") => {
    const refs = current?.threads.filter((t) => t.thread === threadId && (!change || t.change === change)) ?? [];
    let found: boolean | null = null;
    for (const ref of refs) {
      const at = ref.quote ? findQuote(input.liveContent, ref.quote) : null;
      if (at) found = found || at.start < input.cursor;
    }
    return found;
  };
  let unconfirmed = 0;
  const open = input.threads.filter((t) => {
    if (t.status === "abandoned") return false;
    const opened = t.opened_chapter_id ? (index.get(t.opened_chapter_id) ?? -1) : -1;
    if (opened > k) return false;
    if (opened === k && beforeCursor(t.id, "opened") !== true) return false;
    if (t.status === "closed") {
      const closed = t.closed_chapter_id ? (index.get(t.closed_chapter_id) ?? -1) : -1;
      if (closed === -1 || closed < k) return false;
      if (closed === k && beforeCursor(t.id, "closed") !== false) return false;
    }
    if (!trusted(t)) {
      unconfirmed++;
      return false;
    }
    return true;
  });
  if (unconfirmed)
    notices.push(
      `${unconfirmed === 1 ? "1 hilo posible, sin confirmar, no se envía" : `${unconfirmed} hilos posibles, sin confirmar, no se envían`}: puedes confirmarlos en Consejero → Lectura.`,
    );
  const lastSeen = (id: string) => {
    for (let i = k - 1; i >= 0; i--) if (previous[i].d?.threads.some((t) => t.thread === id)) return i;
    return -1;
  };
  const recent = (id: string) => lastSeen(id) >= Math.max(0, k - 2) || beforeCursor(id) === true;
  const matchers = input.characters.map(nameMatcher).filter((m): m is RegExp => Boolean(m));
  const rank = (t: StoryThread) => (recent(t.id) ? 0 : matchers.some((m) => m.test(`${t.title} ${t.description}`)) ? 1 : 2);
  const openedAt = (t: StoryThread) => (t.opened_chapter_id ? (index.get(t.opened_chapter_id) ?? Infinity) : Infinity);
  let chosen = open
    .map((t) => ({ t, rank: rank(t) }))
    .sort((a, b) => a.rank - b.rank || openedAt(a.t) - openedAt(b.t))
    .slice(0, MAX_THREADS)
    .map((x) => x.t);
  const threadLine = (t: StoryThread) => {
    const kind = THREAD_KINDS.find((x) => x.id === t.kind)?.label ?? "Otro";
    const o = openedAt(t);
    const seen = lastSeen(t.id);
    const where = [Number.isFinite(o) && o < k ? `se abre en ${label(o)}` : o === k ? "se abre en este capítulo" : null, seen > o ? `última vez en ${label(seen)}` : null]
      .filter(Boolean)
      .join(", ");
    return `- «${t.title}» · ${kind}${where ? ` · ${where}` : ""}${t.description.trim() ? ` — ${clip(t.description.trim(), 300)}` : ""}`;
  };
  while (chosen.length && tokens(chosen.map(threadLine).join("\n")) > THREADS_TOKENS) chosen = chosen.slice(0, -1);
  const threads = chosen.length ? chosen.map(threadLine).join("\n") : null;
  const threadsSection: ContextSection | null = threads
    ? {
        id: "threads",
        label: "Hilos abiertos",
        tokens: tokens(threads),
        items: chosen.map((t) => {
          const o = openedAt(t);
          return {
            label: t.title,
            note: [THREAD_KINDS.find((x) => x.id === t.kind)?.label, Number.isFinite(o) ? `desde ${o === k ? "este capítulo" : label(o)}` : null]
              .filter(Boolean)
              .join(" · "),
            detail: t.description.trim() ? clip(t.description.trim(), 300) : undefined,
          };
        }),
      }
    : null;

  return {
    story,
    knowledge,
    threads,
    sections: { story: storySection, knowledge: knowledgeSection, threads: threadsSection },
    notices,
  };
}

/** A previous chapter's digest as the writer reads it: no quotes (they don't help to write). */
function digestText(
  d: ChapterDigest,
  label: string,
  tier: Tier,
  stale: boolean,
  scene: Set<string>,
  name: (id: string) => string,
  threadTitle: Map<string, string>,
): string {
  const who = (ids: string[]) => ids.map(name).join(", ");
  const to = (r: { to: string }) => (r.to === "lector" ? "el lector" : name(r.to));
  const open = `<ficha capitulo="${label}"${stale ? ' version="anterior"' : ""}>`;
  if (tier === 3) return `${open}\n${firstSentence(d.summary)}\n</ficha>`;
  const revelations = tier === 1 ? d.revelations : d.revelations.filter((r) => scene.has(r.to));
  const changes: Record<string, string> = { opened: "se abre", advanced: "avanza", closed: "se cierra" };
  const lines = [
    open,
    d.summary.trim(),
    tier === 1 && d.events.length
      ? `Acontecimientos:\n${d.events.map((e) => `- ${e.text.trim()}${e.characters.length ? ` (${who(e.characters)})` : ""}`).join("\n")}`
      : "",
    tier === 1 && d.presence.some((p) => p.kind === "present")
      ? `En escena: ${who(d.presence.filter((p) => p.kind === "present").map((p) => p.character))}`
      : "",
    revelations.length ? `Revelaciones:\n${revelations.map((r) => `- ${r.text.trim()} → ${to(r)}`).join("\n")}` : "",
    tier === 1 && d.threads.some((t) => threadTitle.has(t.thread))
      ? `Cabos: ${d.threads
          .filter((t) => threadTitle.has(t.thread))
          .map((t) => `«${threadTitle.get(t.thread)}» ${changes[t.change] ?? t.change}`)
          .join("; ")}`
      : "",
    "</ficha>",
  ];
  return lines.filter(Boolean).join("\n");
}
