import type { Character, ContextItem, ContextSection, Memory, Novel, Place } from "../types";
import { GUIDE_SECTIONS } from "../guide";
import { countWords } from "../manuscript";
import { chapterLabel, estimateTokens, nameMatcher, type SelectedMemory } from "./context";
import { CHARACTER_LABELS, memorySections, type StoryTime } from "./prompts";

/**
 * "Ver contexto": what a request carries, said for the author. Built from the very pieces
 * the request is made of (same selection, same texts), so a section only exists when
 * something of it is sent.
 */

const tokens = (...texts: (string | null | undefined)[]) => estimateTokens(texts.reduce((n, t) => n + (t?.length ?? 0), 0));
const clip = (s: string, max = 240) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);
export const wordsLabel = (text: string) => {
  const n = countWords(text);
  return n === 1 ? "1 palabra" : `${n.toLocaleString("es")} palabras`;
};

/** Where a name was found, in order of preference: the first source that names it. */
export interface NameSource {
  reason: string;
  text: string;
}

function reasonFor(who: { id: string; name: string; aliases: string }, chosen: string[], chosenReason: string, sources: NameSource[]) {
  if (chosen.includes(who.id)) return chosenReason;
  const m = nameMatcher(who);
  return (m && sources.find((s) => m.test(s.text))?.reason) || null;
}

/** The Guía Maestra as the Asistente receives it: the style, never the synopsis nor the notes. */
export function guideSection(novel: Pick<Novel, "guide">, compiled: string): ContextSection {
  const g = novel.guide ?? {};
  const items: ContextItem[] = [];
  for (const section of GUIDE_SECTIONS) {
    const filled = section.fields.filter((f) => g[f.key]?.trim());
    if (filled.length)
      items.push({ label: section.title, detail: filled.map((f) => `${f.label}: ${clip(g[f.key]!.trim(), 160)}`).join("\n") });
  }
  const hasGuide = items.length > 0;
  return {
    id: "guide",
    label: items.length ? "Guía Maestra" : "Guía Maestra (sólo el título de la novela)",
    tokens: tokens(compiled),
    items: hasGuide ? items : [...items, { label: "Sin guía de estilo: se le pide seguir el estilo de tu texto" }],
  };
}

/**
 * The memory that goes, kind by kind, with why each character and place is there.
 * `chosen` are the ids picked in the panel; `sources` the texts searched for names.
 */
export function memorySectionsFor(opts: {
  selected: SelectedMemory;
  memory: Memory;
  chapters: { id: string; title: string }[];
  currentChapterId: string;
  chosenCharacters: string[];
  chosenCharacterReason: string;
  chosenPlaces?: string[];
  sources: NameSource[];
  /** Included for another reason than being chosen or named (id → reason). */
  extraReasons?: Map<string, string>;
  /** Cronología: the time at this point and the computed ages. */
  time?: StoryTime | null;
}): ContextSection[] {
  const { selected, memory, chapters } = opts;
  const blocks = memorySections(selected, memory, chapters, opts.currentChapterId, opts.time);
  const names = new Map(memory.characters.map((c) => [c.id, c.name]));
  const placeNames = new Map(memory.places.map((p) => [p.id, p.name]));
  const out: ContextSection[] = [];

  if (blocks.time)
    out.push({
      id: "time",
      label: `Tiempo del relato: ${opts.time!.now}${opts.time!.estimated ? " (heredado del capítulo anterior)" : ""}`,
      tokens: tokens(blocks.time),
      items: [],
    });
  if (blocks.characters) {
    const included = new Set(selected.characters.map((c) => c.id));
    out.push({
      id: "characters",
      label: "Personajes",
      tokens: tokens(blocks.characters),
      items: selected.characters.map((c: Character) => {
        const related = selected.relationships.find(
          (r) => (r.from_id === c.id && included.has(r.to_id)) || (r.to_id === c.id && included.has(r.from_id)),
        );
        const other = related && names.get(related.from_id === c.id ? related.to_id : related.from_id);
        return {
          label: c.name,
          reason:
            reasonFor(c, opts.chosenCharacters, opts.chosenCharacterReason, opts.sources) ??
            opts.extraReasons?.get(c.id) ??
            (other ? `por su relación con ${other}` : undefined),
          detail: characterSummary(c, opts.time?.ages.get(c.id)),
        };
      }),
    });
  }
  if (blocks.places) {
    out.push({
      id: "places",
      label: "Lugares",
      tokens: tokens(blocks.places),
      items: selected.places.map((p: Place) => ({
        label: p.name,
        reason: reasonFor(p, opts.chosenPlaces ?? [], "elegido en «Lugar»", opts.sources) ?? undefined,
        detail: clip(p.description.trim()) || undefined,
      })),
    });
  }
  if (blocks.relationships) {
    out.push({
      id: "relationships",
      label: "Relaciones",
      tokens: tokens(blocks.relationships),
      items: selected.relationships.map((r) => ({
        label: `${names.get(r.from_id) ?? "?"} → ${r.kind} → ${names.get(r.to_id) ?? "?"}`,
        detail: r.note.trim() || undefined,
      })),
    });
  }
  if (blocks.facts) {
    const current = chapters.findIndex((c) => c.id === opts.currentChapterId);
    out.push({
      id: "facts",
      label: "Hechos aprobados",
      tokens: tokens(blocks.facts),
      items: selected.facts.map((f) => {
        const i = f.chapter_id ? chapters.findIndex((c) => c.id === f.chapter_id) : -1;
        const where = [
          i >= 0 ? chapterLabel(i, chapters[i].title) + (current >= 0 && i > current ? " (posterior)" : "") : null,
          f.place_id ? placeNames.get(f.place_id) : null,
          f.character_ids.map((id) => names.get(id)).filter(Boolean).join(", ") || null,
        ].filter(Boolean);
        if (f.story_time.trim()) where.push(f.story_time.trim());
        return { label: clip(f.text.trim(), 200), note: where.join(" · ") || undefined };
      }),
    });
  }
  return out;
}

/**
 * What of a character's file goes: every filled field, as the author wrote it (shortened).
 * It is the author's own data, the same fields that formatCharacter sends.
 */
function characterSummary(c: Character, age?: string | null): string {
  const lines = CHARACTER_LABELS.filter(([k]) => String(c[k] ?? "").trim() && !(age && k === "age")).map(
    ([k, label]) => `${label}: ${clip(String(c[k]).trim().replace(/\s+/g, " "), 140)}`,
  );
  if (age) lines.unshift(`Edad en este punto: ${age}`);
  return lines.length ? lines.join("\n") : "Ficha sin datos más allá del nombre";
}

export function sceneTextSections(opts: {
  chapterIndex: number;
  chapterTitle: string;
  before: string;
  after: string;
  /** The chapter from its start up to `before`, and the words of it left out. */
  earlier?: string | null;
  earlierOmitted?: number;
  /** With the whole novel: the text around the cursor is not sent apart, only its place. */
  inManuscript?: boolean;
  previousChapterTail: string | null;
  previousIndex: number;
  previousTitle: string;
  argument: string;
}): { text: ContextSection[]; argument: ContextSection } {
  const label = chapterLabel(opts.chapterIndex, opts.chapterTitle);
  const argument: ContextSection = {
    id: "argument",
    label: "Tu argumento",
    tokens: tokens(opts.argument),
    items: [{ label: clip(opts.argument, 400) }],
  };
  if (opts.inManuscript)
    return {
      text: [{ id: "chapter", label, tokens: 0, items: [{ label: "El lugar del cursor, al final de la historia hasta aquí" }] }],
      argument,
    };

  const items: ContextItem[] = [];
  if (opts.earlier?.trim())
    items.push(
      opts.earlierOmitted
        ? { label: `Desde el inicio: ≈${wordsLabel(opts.earlier)}`, note: `se omiten ≈${opts.earlierOmitted.toLocaleString("es")} palabras intermedias` }
        : { label: "Desde el inicio del capítulo" },
    );
  items.push(
    opts.before.trim()
      ? { label: `≈${wordsLabel(opts.before)} antes del cursor`, detail: `Empieza en: «${clip(opts.before.trim(), 120)}»` }
      : { label: "La escena va al principio del capítulo" },
  );
  if (opts.after.trim()) items.push({ label: `≈${wordsLabel(opts.after)} después del cursor` });
  const text: ContextSection[] = [
    { id: "chapter", label, tokens: tokens(opts.earlier, opts.before, opts.after), items },
  ];
  if (opts.previousChapterTail)
    text.push({
      id: "previous",
      label: "Final del capítulo anterior",
      tokens: tokens(opts.previousChapterTail),
      items: [{ label: `${chapterLabel(opts.previousIndex, opts.previousTitle)}: últimas ≈${wordsLabel(opts.previousChapterTail)}` }],
    });
  return { text, argument };
}

export function selectionSection(selection: string, before: string, after: string): ContextSection {
  const items: ContextItem[] = [{ label: `Fragmento seleccionado (≈${wordsLabel(selection)})` }];
  if (before.trim() || after.trim())
    items.push({ label: `Texto cercano: ≈${wordsLabel(before)} antes y ≈${wordsLabel(after)} después` });
  return { id: "selection", label: "Tu selección", tokens: tokens(selection, before, after), items };
}

export function passagesSection(found: { name: string; text: string }[]): ContextSection | null {
  if (!found.length) return null;
  return {
    id: "passages",
    label: "Pasajes de otros capítulos",
    tokens: tokens(...found.map((f) => f.text)),
    items: found.map((f) => ({ label: `Donde aparece ${f.name}` })),
  };
}

/** «Leer toda la historia hasta aquí» (scene): the previous chapters and this one up to the cursor. */
export function storyManuscriptSection(text: string, chapterIndex: number): ContextSection {
  const n = chapterIndex + 1;
  const which =
    n === 1 ? "El capítulo 1 hasta el cursor" : n === 2 ? "El capítulo 1 y el 2 hasta el cursor" : `Los capítulos 1 a ${n - 1} y el ${n} hasta el cursor`;
  return {
    id: "manuscript",
    label: "La historia hasta aquí",
    tokens: tokens(text),
    items: [{ label: `${which} · ≈${wordsLabel(text)}` }, { label: "Nada posterior: ni el resto de este capítulo ni los siguientes" }],
  };
}

/** «Ampliar»: the scene already written, sent to be developed. */
export function draftSection(draft: string): ContextSection {
  return {
    id: "draft",
    label: "La escena a ampliar",
    tokens: tokens(draft),
    items: [{ label: `La propuesta anterior · ≈${wordsLabel(draft)}`, detail: `Empieza: «${clip(draft.trim(), 160)}»` }],
  };
}

export function manuscriptSection(text: string, chapters: number): ContextSection {
  return {
    id: "manuscript",
    label: "Novela completa",
    tokens: tokens(text),
    items: [{ label: `${chapters === 1 ? "1 capítulo" : `${chapters} capítulos`} · ≈${wordsLabel(text)}` }],
  };
}
