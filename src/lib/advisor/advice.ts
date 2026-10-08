import "server-only";
import { db, getMemory, getNovel, getOutline } from "../supabase";
import { HttpError } from "../http";
import { compileGuide } from "../guide";
import { countWords, forModel, separatorsForModel } from "../manuscript";
import { buildManuscript, chapterLabel, estimateTokens, excerpts, manuscriptRange, nameMatcher, nearbyRange, selectMemory } from "../ai/context";
import { memoryBlock } from "../ai/prompts";
import type { CompletionRequest } from "../ai/providers";
import type { AdvisorAction, ChapterDigest, ContextPart, StoryThread } from "../types";
import { ADVISOR_ACTIONS, CREATIVE_ACTIONS, THREAD_KINDS, THREAD_STATUS_LABELS } from "../types";
import { novelChronology } from "../chronology-server";
import { describeAge, formatPoint } from "../chronology";
import { assignLabels, isDiscard, leavesFocus, resolveReference, type Anchor, type CardRef, type CardWithState } from "./cards";
import { chapterRows, digestEstimate, digestRows, novelDigestRow, threadRows } from "./reading";
import { freshness } from "./freshness";
import { echoes, phraseRepetitions, presence } from "./stats";
import { NEW_TOPIC, planQuestion, type Plan } from "./planner";
import { planDetails, planOverview, questionWords } from "./plan-text";
import { ADVISE_INSTRUCTIONS, ADVISE_TASKS, CONVERSE_INSTRUCTIONS, CONVERSE_TASKS } from "./prompts";
import { lastProposal, likesProposal, wantsAnalysis, wantsOptions, type AdvisorMode } from "./converse";
import { deepInstructions, deepLimits, type ToolContext } from "./deep";

/** Rounded to hundreds, so the map (in the cached frame) does not change while the author types. */
const roundedWords = (n: number) => (n < 100 ? "menos de 100 palabras" : `≈${(Math.round(n / 100) * 100).toLocaleString("es")} palabras`);

/**
 * Context for each Consejero action (docs/consejero.md §4): levels with a budget each,
 * stable things first so they can be cached.
 *
 *   0 · frame       Guía Maestra, the author's synopsis, the novel map, the global summary
 *                   and the threads. The same for every action: cached.
 *   1 · focus       the open chapter, complete and live (with what isn't saved yet), or the
 *                   selection, or the end of the chapter. Never its digest.
 *   2 · structure   relevant Memory, and the digests of the previous chapters and of those
 *                   where the people involved appear.
 *   3 · passages    paragraphs of other chapters, by character, by thread and by the
 *                   question's words.
 *   4 · chapters    chapters named in the question, complete.
 *
 * Plus what can be computed (mentions, repetitions), which goes as data, not as a question.
 */

const MAX_OUTPUT_TOKENS = 4000;
/** Creative answers have more room (three paths with their sections), never a scene. */
const CREATIVE_OUTPUT_TOKENS = 6000;
/** Conversar: usually a few sentences, but room to develop an idea when asked (no word limit). */
const CONVERSE_OUTPUT_TOKENS = 3000;
/** Analytic actions: in Conversar, asking for one of them makes that turn an Analizar turn. */
const ANALYTIC: AdvisorAction[] = ["analizar", "repeticiones", "coherencia", "cabos", "personajes"];
const chars = (tokens: number) => Math.round(tokens * 3.5);

/** Input budgets in tokens, per level (orientative, docs §4). */
type Data = "presence" | "repetitions" | "threads" | "secrets";
const RECIPES: Record<AdvisorAction, { focus: "chapter" | "tail" | "none"; digests: number; passages: number; data: Data[] }> = {
  analizar: { focus: "chapter", digests: 3000, passages: 2500, data: ["presence"] },
  seguir: { focus: "tail", digests: 4000, passages: 2000, data: ["presence", "threads", "secrets"] },
  // Consejero creativo (phase 1).
  caminos: { focus: "tail", digests: 5000, passages: 2000, data: ["presence", "threads", "secrets"] },
  explorar: { focus: "tail", digests: 3500, passages: 2500, data: ["threads"] },
  consecuencias: { focus: "tail", digests: 4500, passages: 3000, data: ["presence", "threads"] },
  giro: { focus: "tail", digests: 5000, passages: 2500, data: ["presence", "threads", "secrets"] },
  oportunidades: { focus: "chapter", digests: 5000, passages: 2500, data: ["presence", "threads", "secrets"] },
  tension: { focus: "chapter", digests: 3000, passages: 1500, data: ["threads", "secrets"] },
  conversar: { focus: "tail", digests: 2500, passages: 1500, data: [] },
  repeticiones: { focus: "chapter", digests: 3000, passages: 0, data: ["repetitions"] },
  cabos: { focus: "tail", digests: 5000, passages: 2500, data: ["threads"] },
  coherencia: { focus: "chapter", digests: 3500, passages: 4000, data: [] },
  personajes: { focus: "chapter", digests: 4000, passages: 2500, data: ["presence"] },
};
const FOCUS_TOKENS = 18_000;
/** The author's plan (Argumento general, synopsis and notes): its global view, in the cached
 *  frame (larger with an Argumento general: it is cached, so cheap after the first turn), and
 *  the paragraphs that matter for this turn, in the prompt (docs/consejero.md, «Argumento general»). */
const PLAN_OVERVIEW_TOKENS = { base: 2000, withPlot: 3000 };
const PLAN_DETAIL_TOKENS = { base: { conversar: 1500, analizar: 2500 }, withPlot: { conversar: 2000, analizar: 3500 } };
const TAIL_CHARS = 8000;
const NAMED_CHAPTERS_TOKENS = 14_000;

export interface AdviceInput {
  novelId: string;
  chapterId: string;
  content: string;
  action?: AdvisorAction;
  question?: string;
  selection?: { start: number; end: number } | null;
  characterIds?: string[];
  /** The conversation so far (summary and last turns), when continuing one. */
  conversation?: string;
  /** Lectura profunda: the model may ask for more material in rounds (default on). */
  deep?: boolean;
  /** The conversation's cards (labelled, with states) and the proposal being developed. */
  cards?: CardWithState[];
  focus?: CardRef | null;
  /** "Seguir con esta": the card the author chose with the button. */
  anchorId?: string | null;
  /** The author let the proposal in course go: this message doesn't inherit it. */
  release?: boolean;
  /** Conversar (a companion: brief, one proposal) or Analizar (the full evaluation). Default: analizar. */
  mode?: AdvisorMode;
}

export interface Advice {
  novelId: string;
  request: CompletionRequest;
  parts: ContextPart[];
  plan: Plan;
  /** How the question was understood, for the panel. */
  detail: string;
  /** Chapters (with the live one) to verify quotes against. */
  chapters: { id: string; content: string }[];
  /** Revisions of the chapters the answer reads complete (the focus and named ones). */
  basedOn: Record<string, number>;
  /** What the read-only tools of lectura profunda work on. */
  tools: ToolContext;
  /** Chapters the recipe reads through their digest that have none, or a stale one. */
  unread: { id: string; title: string; estimate: number }[];
  /** The card the author's message is about (resolved without AI), if any. */
  anchor: Anchor | null;
  /** A card the author discarded by name ("descarta la C"). */
  discard: CardRef | null;
  /** The mode this turn was answered in (an explicit analysis in Conversar switches it). */
  mode: AdvisorMode;
  /** Rounds of lectura profunda this turn may use (Conversar: one). */
  deepRounds: number | null;
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function buildAdvice(input: AdviceInput, signal: AbortSignal): Promise<Advice> {
  const novel = await getNovel(input.novelId);
  const [rows, memory, digests, threads, global, outline] = await Promise.all([
    chapterRows(novel.id),
    getMemory(novel.id),
    digestRows(novel.id),
    threadRows(novel.id),
    novelDigestRow(novel.id),
    getOutline(novel.id),
  ]);
  const index = rows.findIndex((c) => c.id === input.chapterId);
  if (index === -1) throw new HttpError(404, "Capítulo no encontrado");
  const chapters = rows.map((c, i) => (i === index ? { ...c, content: input.content } : c));
  const current = chapters[index];
  const label = (i: number) => chapterLabel(i, chapters[i].title);
  const byChapter = new Map(digests.map((d) => [d.chapter_id, d]));
  const status = (i: number) => freshness(byChapter.get(rows[i].id) ?? null, rows[i]).status;

  // The plan: an action chosen by the author, or the planner's reading of the question.
  const question = (input.question ?? "").trim().slice(0, 2000);
  if (!input.action && !question) throw new HttpError(400, "Elige una acción o escribe una pregunta.");
  if (input.action && !ADVISOR_ACTIONS.some((a) => a.id === input.action)) throw new HttpError(400, "Acción desconocida");
  const plan = planQuestion(question, { characters: memory.characters, places: memory.places, chapters, threads });
  if (input.action) plan.action = input.action;
  for (const id of input.characterIds ?? []) if (memory.characters.some((c) => c.id === id) && !plan.characterIds.includes(id)) plan.characterIds.push(id);

  // The card the message is about (docs/consejero.md, Consejero creativo): the button,
  // the author's words ("el segundo", "la B", "el último"), or the proposal in course,
  // which a message inherits unless it names another card, asks for something new, or
  // the author let it go. Resolved here, without AI; the panel shows how it was understood.
  // Conversar is the default of the panel; asking for an analysis makes this one turn Analizar
  // (and it is about the chapter, not about the proposal in course).
  let mode: AdvisorMode = input.mode === "conversar" ? "conversar" : "analizar";
  const asksAnalysis = mode === "conversar" && ((input.action && ANALYTIC.includes(input.action)) || (!input.action && !!question && wantsAnalysis(question)));
  if (asksAnalysis) mode = "analizar";
  const cards = input.cards ?? [];
  let anchor: Anchor | null = null;
  let discard: CardRef | null = null;
  if (input.anchorId) {
    const c = cards.find((x) => x.id === input.anchorId);
    if (!c) throw new HttpError(400, "Esa propuesta no es de esta conversación.");
    anchor = { id: c.id, label: c.label, title: c.title, how: "boton" };
  } else if (question && !input.action) {
    const ref = resolveReference(question, cards);
    if (ref && isDiscard(question)) discard = ref.card;
    else if (ref) anchor = { id: ref.card.id, label: ref.card.label, title: ref.card.title, how: ref.how };
    else if (input.focus && !input.release && !asksAnalysis && !leavesFocus(question) && !(plan.explicit && NEW_TOPIC.includes(plan.explicit)))
      anchor = { id: input.focus.id, label: input.focus.label, title: input.focus.title, how: "heredado" };
  }
  // «Me gusta», «esa», «desarróllala» with nothing named and nothing in course: the proposal
  // just made.
  if (!anchor && !discard && !asksAnalysis && !input.anchorId && !input.action && !input.release && question && likesProposal(question)) {
    const last = lastProposal(cards);
    if (last) anchor = { id: last.id, label: last.label, title: last.title, how: "esa" };
  }
  const anchored = anchor ? cards.find((c) => c.id === anchor!.id) ?? null : null;
  if (!input.action && mode === "analizar") {
    // About a card: develop it, unless the words ask for its consequences, a twist or tension.
    if (anchored) plan.action = plan.explicit && ["consecuencias", "giro", "tension", "caminos"].includes(plan.explicit) ? plan.explicit : "explorar";
    // A message without an intent in a creative conversation follows the conversation.
    else if (!plan.explicit && cards.some((c) => c.kind === "alternative")) plan.action = "explorar";
  } else if (!input.action) {
    // Conversar: one proposal by default; several only when asked; the rest, a conversation.
    const keep: AdvisorAction[] = ["seguir", "caminos", "consecuencias", "giro", "tension", "oportunidades"];
    if (question && wantsOptions(question)) plan.action = "caminos";
    else if (anchored) plan.action = plan.explicit && ["consecuencias", "giro", "tension"].includes(plan.explicit) ? plan.explicit : "explorar";
    else plan.action = plan.explicit && keep.includes(plan.explicit) ? plan.explicit : "conversar";
  }
  // The people of the card it's about are involved too ("mete a Nacho": Nacho comes by name).
  if (anchored) {
    for (const c of memory.characters)
      if (!plan.characterIds.includes(c.id) && nameMatcher(c)?.test(`${anchored.title}\n${anchored.body}`)) plan.characterIds.push(c.id);
  }
  const creative = CREATIVE_ACTIONS.includes(plan.action);
  // Conversar reads less: the end of the chapter, the people involved, the conversation; no
  // tables of presence or repetitions to comment on (twists and opportunities keep the secrets).
  const recipe =
    mode === "conversar"
      ? { ...RECIPES.conversar, data: (["giro", "oportunidades"].includes(plan.action) ? ["secrets"] : []) as Data[] }
      : RECIPES[plan.action];

  // Images become their description and separators `* * *`; the model never sees a marker.
  const { data: imgs, error } = await db().from("manuscript_images").select("id, alt, caption, decorative").eq("novel_id", novel.id);
  if (error) throw error;
  const described = new Map(imgs.map((i) => [i.id, i.decorative ? "decorativa" : i.alt || i.caption]));
  const plain = (t: string) => (t.includes("[[imagen:") ? forModel(t, (id) => described.get(id) ?? "") : separatorsForModel(t));

  const parts: ContextPart[] = [];
  const part = (lbl: string, text: string) => {
    if (text) parts.push({ label: lbl, tokens: estimateTokens(text.length) });
    return text;
  };

  // ---------- 0 · frame (stable, cached) ----------
  const names = new Map([...memory.characters, ...memory.places].map((x) => [x.id, x.name]));
  const people = presence(chapters, memory.characters, index);
  // The map, stable between turns so the frame can be cached: the saved chapters (not the
  // live text, which changes as the author types) and their length rounded to hundreds.
  const savedPeople = presence(rows, memory.characters, index);
  const mapLines = rows.map((c, i) => {
    const d = byChapter.get(c.id);
    const who = savedPeople.filter((p) => p.counts[i] > 0).map((p) => p.name).slice(0, 6).join(", ");
    const line = d ? d.summary.split(/(?<=[.!?])\s/)[0] : "sin ficha";
    const stale = d && status(i) === "stale" ? " (ficha de una versión anterior)" : "";
    return `- ${label(i)} · ${roundedWords(countWords(c.content))}${who ? ` · aparecen: ${who}` : ""} · ${clip(line, 220)}${stale}`;
  });
  const threadLines = threads.map((t) => threadLine(t, chapters, label));
  // The author's plan: the Argumento general, the synopsis and the notes (never sent to the
  // Asistente). Its global view goes in the frame, once; the details that matter, in the prompt.
  // Each text keeps its own premise and ending, with a share of the budget by its weight.
  const planSources = [
    { title: "Argumento general", text: (novel.plot ?? "").trim(), weight: 6 },
    { title: "Sinopsis", text: novel.synopsis.trim(), weight: 3 },
    { title: "Notas del autor", text: novel.notes.trim(), weight: 1 },
  ].filter((x) => x.text);
  const totalWeight = planSources.reduce((n, x) => n + x.weight, 0);
  const overviewBudget = chars(novel.plot?.trim() ? PLAN_OVERVIEW_TOKENS.withPlot : PLAN_OVERVIEW_TOKENS.base);
  const planTexts = planSources
    .map((x) => ({ ...x, share: x.weight / totalWeight }))
    .map((x) => ({ ...x, overview: planOverview(x.text, Math.floor(overviewBudget * x.share)) }));
  const overview = {
    whole: planTexts.every((x) => x.overview.whole),
    text: planTexts.map((x) => `${x.title}:\n${x.overview.text}`).join("\n\n"),
  };
  const frame = [
    `## Guía Maestra (estilo)\n${compileGuide(novel)}`,
    overview.text &&
      `## Plan del autor${overview.whole ? "" : " (visión general; los detalles pertinentes van aparte)"}\nSu intención para la novela. En gran parte aún no está escrito: no es canon ni algo que ya ocurrió.\n${overview.text}`,
    `## Mapa de la novela\n${mapLines.join("\n")}`,
    global && `## Resumen global (derivado de las fichas)\n${clip(global.summary, 9000)}`,
    `## Cabos\n${threadLines.length ? threadLines.join("\n") : "(ninguno registrado)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  part("Marco: guía, mapa, resumen global y cabos", frame);

  // ---------- 1 · focus ----------
  const blocks: string[] = [];
  const sel = input.selection && input.selection.end > input.selection.start ? input.selection : null;
  let focusRange = { start: 0, end: current.content.length };
  if (sel && (plan.action === "coherencia" || plan.action === "analizar" || plan.action === "tension")) {
    const s = { start: Math.max(0, sel.start), end: Math.min(current.content.length, sel.end) };
    focusRange = nearbyRange(current.content, s);
    blocks.push(
      part(
        "La selección y su entorno",
        `<seleccion capitulo="${index + 1}">\n${plain(current.content.slice(s.start, s.end))}\n</seleccion>\n\n<entorno capitulo="${index + 1}">\n${plain(current.content.slice(focusRange.start, focusRange.end))}\n</entorno>`,
      ),
    );
  } else if (recipe.focus === "chapter" || (recipe.focus === "tail" && current.content.length <= TAIL_CHARS * 1.5)) {
    const text = current.content.length > chars(FOCUS_TOKENS) ? current.content.slice(-chars(FOCUS_TOKENS)) : current.content;
    focusRange = { start: current.content.length - text.length, end: current.content.length };
    blocks.push(
      part(
        `${label(index)} completo`,
        `<capitulo-actual numero="${index + 1}" titulo="${current.title}">\n${plain(text)}\n</capitulo-actual>`,
      ),
    );
  } else {
    focusRange = { start: Math.max(0, current.content.length - TAIL_CHARS), end: current.content.length };
    blocks.push(
      part(
        `Final de ${label(index)}`,
        `<capitulo-actual numero="${index + 1}" titulo="${current.title}" fragmento="final">\n${plain(current.content.slice(focusRange.start))}\n</capitulo-actual>`,
      ),
    );
  }

  // ---------- 4 · chapters named in the question ----------
  const named = plan.chapterIndexes.filter((i) => i !== index);
  if (named.length) {
    const each = Math.floor(chars(NAMED_CHAPTERS_TOKENS) / named.length);
    blocks.push(
      part(
        `${named.map((i) => `Capítulo ${i + 1}`).join(" y ")} completo${named.length > 1 ? "s" : ""}`,
        named.map((i) => `<capitulo numero="${i + 1}" titulo="${chapters[i].title}">\n${plain(clip(chapters[i].content, each))}\n</capitulo>`).join("\n\n"),
      ),
    );
  }

  // ---------- 2 · structure ----------
  const focusText = current.content.slice(focusRange.start, focusRange.end);
  // Cronología (docs/cronologia-edades.md): the story's time at the open chapter and the
  // ages of the characters in the memory block, plus each chapter's time.
  const chron = await novelChronology(novel, { memory, chapters: rows.map((r) => ({ id: r.id, title: r.title })) });
  const point = chron.result.points[index];
  const time = chron.marks.length
    ? {
        now: formatPoint(point, novel.calendar),
        estimated: point.estimated,
        ages: new Map(
          memory.characters
            .map((c) => [c.id, describeAge(c, chron.result.ages.get(c.id)?.[index] ?? null, rows, novel.calendar)] as const)
            .filter((x): x is readonly [string, string] => Boolean(x[1])),
        ),
      }
    : null;

  const selected = selectMemory(memory, {
    text: `${question}\n${anchored ? `${anchored.title}\n${anchored.body}\n` : ""}${focusText}`,
    characterIds: plan.characterIds,
    placeIds: plan.placeIds,
    // "¿Qué pasa si…?" about someone: their relationships (with whoever is at the other
    // end) and their facts, which is where consequences come from.
    focus: plan.action === "consecuencias" && plan.characterIds.length > 0,
    chapterId: current.id,
    chapterOrder: chapters.map((c) => c.id),
  });
  const mem = memoryBlock(selected, memory, outline, current.id, time);
  if (mem) blocks.push(part(`Memoria de ${selected.characters.length} personaje${selected.characters.length === 1 ? "" : "s"}`, mem));
  // Where the author is: what the plan puts later has not happened (not in the cached frame:
  // it changes with the chapter).
  if (overview.text)
    blocks.push(
      part(
        "Posición en la novela",
        `<posicion>El autor tiene abierto el capítulo ${index + 1} de ${chapters.length}. Del plan del autor, lo que no está en el manuscrito ni en las fichas hasta aquí todavía no ha ocurrido: trátalo como intención, sin adelantar sus revelaciones.</posicion>`,
      ),
    );
  // The plan's paragraphs about the people and places in play, or the question's words.
  if (!overview.whole) {
    const matchers = [
      ...memory.characters.filter((c) => selected.characters.some((x) => x.id === c.id) || plan.characterIds.includes(c.id)),
      ...memory.places.filter((p) => plan.placeIds.includes(p.id) || selected.places.some((x) => x.id === p.id)),
    ]
      .map(nameMatcher)
      .filter((m): m is RegExp => Boolean(m));
    const detail = novel.plot?.trim() ? PLAN_DETAIL_TOKENS.withPlot : PLAN_DETAIL_TOKENS.base;
    const budget = chars(mode === "conversar" ? detail.conversar : detail.analizar);
    const words = questionWords(`${question} ${anchored ? anchored.title : ""}`);
    const details = planTexts
      .filter((x) => !x.overview.whole)
      .map((x) => ({ x, d: planDetails(x.text, { matchers, words, budget: Math.floor(budget * x.share), skip: x.overview.full, current: index + 1 }) }))
      .filter(({ d }) => d)
      .map(({ x, d }) => `${x.title}:\n${d}`)
      .join("\n\n");
    if (details)
      blocks.push(part("Plan del autor: pasajes pertinentes", `<plan-del-autor-detalles>\n${details}\n</plan-del-autor-detalles>\n(Intención del autor, no canon: lo que aún no ha ocurrido no se presenta como ocurrido.)`));
  }
  // Estado actual: what the people in play have learned so far (the digests' revelations).
  const knowing = selected.characters.slice(0, 6);
  const learned: string[] = [];
  for (let i = 0; i <= index; i++) {
    const d = byChapter.get(chapters[i].id);
    for (const r of d?.revelations ?? []) {
      const who = knowing.find((c) => c.id === r.to);
      if (who) learned.push(`- ${who.name}: ${clip(r.text.trim(), 200)} (${label(i)})`);
    }
  }
  if (learned.length) blocks.push(part("Lo que saben hasta aquí", `<lo-que-saben>\n${learned.slice(-15).join("\n")}\n</lo-que-saben>`));
  if (chron.marks.length) {
    const lines = chapters.map((c, i) => {
      const p = chron.result.points[i];
      const where = i === index ? " (capítulo abierto: el «ahora» del relato)" : i > index ? " (posterior al capítulo abierto)" : "";
      return `- ${label(i)}: ${formatPoint(p, novel.calendar)}${p.estimated ? " (estimado)" : ""}${chron.marks.find((m) => m.chapter_id === c.id)?.flashback ? " · retrospectiva" : ""}${where}`;
    });
    const warnings = chron.result.warnings.map((w) => `- ${w.message}`);
    blocks.push(
      part(
        "Cronología",
        `<cronologia>\nTiempo del relato por capítulo:\n${lines.join("\n")}${warnings.length ? `\n\nAvisos de cronología:\n${warnings.join("\n")}` : ""}\n(Las edades de los personajes en este punto están en sus fichas. Lo que propongas debe ser posible en este tiempo.)\n</cronologia>`,
      ),
    );
  }

  const involved = new Set(plan.characterIds.length ? plan.characterIds : selected.characters.map((c) => c.id));
  const wanted: number[] = [];
  const consider = plan.action === "cabos" ? chapters.map((_, i) => i).reverse() : [index - 1, index - 2, index - 3];
  for (const i of consider) if (i >= 0 && i !== index && byChapter.has(chapters[i].id)) wanted.push(i);
  // Chapters where the people involved are on stage, nearest first.
  for (let i = index - 1; i >= 0; i--) {
    const d = byChapter.get(chapters[i].id);
    if (d && !wanted.includes(i) && d.presence.some((p) => involved.has(p.character))) wanted.push(i);
  }
  let budget = chars(recipe.digests);
  const digestBlocks: string[] = [];
  const used: number[] = [];
  for (const i of wanted) {
    const text = digestText(byChapter.get(chapters[i].id)!, i, label, names, threads, status(i) === "stale");
    if (text.length > budget) continue;
    budget -= text.length;
    digestBlocks.push(text);
    used.push(i);
  }
  if (digestBlocks.length) {
    used.sort((a, b) => a - b);
    digestBlocks.sort((a, b) => Number(a.match(/numero="(\d+)"/)![1]) - Number(b.match(/numero="(\d+)"/)![1]));
    blocks.push(part(`Fichas: ${rangeLabel(used)}`, digestBlocks.join("\n\n")));
  }

  // ---------- 3 · passages ----------
  if (recipe.passages) {
    const ms = buildManuscript(chapters, { id: current.id, content: current.content });
    const exclude = manuscriptRange(ms, current.id, focusRange);
    const found: string[] = [];
    let left = chars(recipe.passages);
    const who = memory.characters.filter((c) => involved.has(c.id)).slice(0, 3);
    for (const c of who) {
      const e = excerpts(ms, c, exclude, Math.floor(left / Math.max(1, who.length)));
      if (e) found.push(e);
    }
    left -= found.join("").length;
    // Paragraphs around the anchors of the threads asked about (or, for "cabos", the open ones).
    const ids = plan.threadIds.length ? plan.threadIds : plan.action === "cabos" ? threads.filter((t) => t.status === "open").map((t) => t.id) : [];
    for (const d of digests) {
      const i = chapters.findIndex((c) => c.id === d.chapter_id);
      if (i === -1 || i === index) continue;
      for (const t of d.threads) {
        if (!ids.includes(t.thread) || !t.quote || left <= 0) continue;
        const para = paragraphWith(chapters[i].content, t.quote);
        if (para) {
          const text = `[${label(i)}]\n${clip(plain(para), 900)}`;
          left -= text.length;
          found.push(text);
        }
      }
    }
    // Paragraphs that share the question's own words.
    if (question && left > 0) {
      for (const p of keywordParagraphs(question, chapters, index, 4)) {
        const text = `[${label(p.i)}]\n${clip(plain(p.text), 900)}`;
        if (text.length > left) break;
        left -= text.length;
        found.push(text);
      }
    }
    if (found.length) blocks.push(part(`Pasajes de otros capítulos`, `<pasajes>\n${found.join("\n\n---\n\n")}\n</pasajes>`));
  }

  // ---------- computed data ----------
  const data: string[] = [];
  if (recipe.data.includes("presence")) {
    data.push(
      `Última aparición de cada personaje (contando hasta ${label(index)}):\n` +
        people
          .map((p) =>
            p.chaptersSince == null
              ? `- ${p.name}: aún no aparece`
              : `- ${p.name}: ${p.chaptersSince === 0 ? "en este capítulo" : `hace ${p.chaptersSince} capítulos (en el ${index - p.chaptersSince + 1}), ≈${p.wordsSince} palabras`} · ${p.total} menciones en total`,
          )
          .join("\n"),
    );
  }
  if (recipe.data.includes("repetitions")) {
    const fmt = (r: ReturnType<typeof phraseRepetitions>[number]) =>
      `- «${r.text}»${r.kind === "eco" ? " (eco: la misma palabra muy cerca)" : ""} ×${r.occurrences.length} (${[...new Set(r.occurrences.map((o) => chapters.findIndex((c) => c.id === o.chapterId) + 1))].map((n) => `cap. ${n}`).join(", ")})`;
    const local = [...phraseRepetitions([current], 15), ...echoes(current, [...memory.characters, ...memory.places], 15)];
    const wide = phraseRepetitions(chapters, 200).filter((r) => new Set(r.occurrences.map((o) => o.chapterId)).size > 1).slice(0, 15);
    data.push(`Repeticiones en ${label(index)} (frases y ecos de palabras cercanas):\n${local.map(fmt).join("\n") || "(ninguna)"}`);
    data.push(`Frases repetidas entre capítulos:\n${wide.map(fmt).join("\n") || "(ninguna)"}`);
  }
  if (recipe.data.includes("threads") && threads.length) {
    data.push(
      `Cabos abiertos y capítulos sin aparecer:\n` +
        threads
          .filter((t) => t.status === "open")
          .map((t) => {
            const last = chapters.findIndex((c) => c.id === t.last_chapter_id);
            return `- «${t.title}»: ${last === -1 ? "sin capítulo" : `última vez en el ${last + 1}, hace ${index - last} capítulos`}`;
          })
          .join("\n"),
    );
  }
  if (recipe.data.includes("secrets")) {
    // What a twist or an opportunity can be built from: secrets and what each one ignores.
    const lines = memory.characters
      .filter((c) => c.secrets.trim() || c.unaware.trim())
      .slice(0, 15)
      .map((c) => `- ${c.name}:${c.secrets.trim() ? ` secretos: ${clip(c.secrets.trim(), 300)}.` : ""}${c.unaware.trim() ? ` no sabe: ${clip(c.unaware.trim(), 300)}.` : ""}`);
    if (lines.length) data.push(`Secretos y lo que cada personaje no sabe (de la Memoria):\n${lines.join("\n")}`);
  }
  if (data.length) blocks.push(part("Datos calculados", `<datos>\n${data.join("\n\n")}\n</datos>`));

  // ---------- the conversation so far ----------
  if (input.conversation) {
    blocks.push(part("Conversación", `<conversacion>\n${input.conversation}\n</conversacion>`));
  }

  // ---------- the proposal being developed ----------
  if (anchored) {
    blocks.push(
      part(
        `Propuesta en curso: ${anchored.label}`,
        `<propuesta-en-curso etiqueta="${anchored.label}"${anchored.from ? ` version-de="${anchored.from}"` : ""}>\n${anchored.title}\n${anchored.body}\n</propuesta-en-curso>\n(Es una posibilidad que el autor está pensando, no un hecho de la novela.)`,
      ),
    );
  }

  // ---------- task ----------
  const next = anchored ? assignLabels(cards.map((c) => c.label), ["alternative"], anchored)[0].label : "";
  const task = (mode === "conversar" ? (CONVERSE_TASKS[plan.action] ?? CONVERSE_TASKS.conversar) : ADVISE_TASKS[plan.action])(label(index), {
    anchor: anchored ? { label: anchored.label, title: anchored.title, next } : null,
    conversation: cards.some((c) => c.kind === "alternative"),
  });
  const ask = question ? `${task}\n\nPregunta del autor: ${question}` : task;
  blocks.push(part("Tarea", `<tarea>\n${ask}\n</tarea>`));

  // Chapters this recipe reads through their digest that have none or a stale one: the
  // panel offers to read them first.
  const reach = plan.action === "cabos" ? chapters.map((_, i) => i) : chapters.map((_, i) => i).filter((i) => i < index);
  const unread = reach
    .filter((i) => i !== index && countWords(rows[i].content) > 0)
    .filter((i) => {
      const s = status(i);
      return s === "missing" || (s === "stale" && !byChapter.get(rows[i].id)?.author_edited);
    })
    .map((i) => ({ id: rows[i].id, title: label(i), estimate: digestEstimate(rows[i].content) }));
  if (unread.length) parts.push({ label: `${unread.length} capítulo${unread.length === 1 ? "" : "s"} sin ficha al día`, tokens: 0 });

  const how = { boton: "con «Seguir con esta»", etiqueta: "por su letra", ordinal: "por su orden", ultimo: "la última", heredado: "la que estamos desarrollando", esa: "la que acabo de proponer" };
  const detail = [
    input.mode === "conversar" && mode === "analizar" && "en modo Analizar, porque lo pediste",
    anchor && `sobre ${anchor.label} «${clip(anchor.title, 60)}» (${how[anchor.how]})`,
    discard && `descartar ${discard.label} «${clip(discard.title, 60)}»`,
    plan.characterIds.length && `personajes: ${plan.characterIds.map((id) => names.get(id)).join(", ")}`,
    plan.chapterIndexes.length && `capítulos: ${plan.chapterIndexes.map((i) => i + 1).join(", ")}`,
    plan.threadIds.length && `cabos: ${plan.threadIds.map((id) => threads.find((t) => t.id === id)?.title).join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    novelId: novel.id,
    request: {
      instructions: (() => {
        const base = mode === "conversar" ? CONVERSE_INSTRUCTIONS : ADVISE_INSTRUCTIONS;
        return input.deep === false ? base : `${base}\n\n${deepInstructions({ ...deepLimits(), ...(mode === "conversar" ? { rounds: 1 } : {}) })}`;
      })(),
      manuscript: null,
      project: frame,
      prompt: blocks.join("\n\n"),
      signal,
      role: "advise",
      maxOutputTokens: mode === "conversar" ? CONVERSE_OUTPUT_TOKENS : creative ? CREATIVE_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      cacheProject: true,
    },
    parts,
    plan,
    detail,
    chapters: chapters.map((c) => ({ id: c.id, content: c.content })),
    basedOn: Object.fromEntries([index, ...named].map((i) => [rows[i].id, rows[i].revision])),
    tools: {
      chapters: chapters.map((c, i) => ({ id: c.id, title: c.title, content: c.content, revision: rows[i].revision })),
      digests: byChapter,
      memory,
      threads,
      current: index,
      plain,
    },
    unread,
    anchor,
    discard,
    mode,
    deepRounds: mode === "conversar" ? 1 : null,
  };
}

function threadLine(t: StoryThread, chapters: { id: string }[], label: (i: number) => string) {
  const at = (id: string | null) => {
    const i = chapters.findIndex((c) => c.id === id);
    return i === -1 ? null : label(i);
  };
  const kind = THREAD_KINDS.find((k) => k.id === t.kind)?.label ?? "Otro";
  const where = [at(t.opened_chapter_id) && `se abre en ${at(t.opened_chapter_id)}`, at(t.last_chapter_id) && `última vez en ${at(t.last_chapter_id)}`, at(t.closed_chapter_id) && `se cierra en ${at(t.closed_chapter_id)}`]
    .filter(Boolean)
    .join(", ");
  return `- «${t.title}» · ${kind} · ${THREAD_STATUS_LABELS[t.status]}${t.confirmed ? "" : " · posible (sin confirmar)"}${where ? ` · ${where}` : ""}${t.description ? ` — ${t.description}` : ""}`;
}

function digestText(
  d: ChapterDigest,
  i: number,
  label: (i: number) => string,
  names: Map<string, string>,
  threads: StoryThread[],
  stale: boolean,
) {
  const who = (ids: string[]) => ids.map((id) => names.get(id)).filter(Boolean).join(", ");
  const lines = [
    `<ficha numero="${i + 1}" capitulo="${label(i)}"${stale ? ' version="anterior"' : ""}>`,
    d.summary,
    d.events.length ? `Acontecimientos:\n${d.events.map((e) => `- ${e.text}${e.characters.length ? ` (${who(e.characters)})` : ""}${e.quote ? ` «${e.quote}»` : ""}`).join("\n")}` : "",
    d.presence.length ? `En escena: ${who(d.presence.filter((p) => p.kind === "present").map((p) => p.character)) || "—"}` : "",
    d.revelations.length ? `Revelaciones:\n${d.revelations.map((r) => `- ${r.text} → ${r.to === "lector" ? "el lector" : names.get(r.to) ?? "?"}${r.quote ? ` «${r.quote}»` : ""}`).join("\n")}` : "",
    d.threads.length ? `Cabos: ${d.threads.map((t) => `${threads.find((x) => x.id === t.thread)?.title ?? "?"} (${t.change})`).join("; ")}` : "",
    d.notes,
    "</ficha>",
  ];
  return lines.filter(Boolean).join("\n");
}

function rangeLabel(list: number[]) {
  const n = list.map((i) => i + 1);
  return n.length > 2 && n.at(-1)! - n[0] === n.length - 1 ? `caps. ${n[0]}–${n.at(-1)}` : `caps. ${n.join(", ")}`;
}

function paragraphWith(text: string, quote: string): string | null {
  const i = text.indexOf(quote);
  if (i === -1) return null;
  const start = text.lastIndexOf("\n", i) + 1;
  const end = text.indexOf("\n", i + quote.length);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

const STOP = /^(que|para|como|pero|porque|cuando|donde|esta|este|esto|todo|toda|sobre|entre|desde|hasta|tiene|tengo|puede|deber|capitulo|capítulo|personaje|novela|escena)$/i;

/** Paragraphs of other chapters with most of the question's content words (a simple lexical score). */
function keywordParagraphs(question: string, chapters: { content: string }[], skip: number, max: number) {
  const words = [...new Set(question.toLocaleLowerCase("es").match(/[\p{L}]{5,}/gu) ?? [])].filter((w) => !STOP.test(w));
  if (!words.length) return [];
  const scored: { i: number; text: string; score: number }[] = [];
  chapters.forEach((c, i) => {
    if (i === skip) return;
    for (const p of c.content.split(/\n+/)) {
      const lower = p.toLocaleLowerCase("es");
      const score = words.filter((w) => lower.includes(w)).length;
      if (score) scored.push({ i, text: p.trim(), score });
    }
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max);
}

