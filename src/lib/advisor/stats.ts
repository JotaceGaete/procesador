import { nameMatcher } from "../ai/context";
import { MARKER_RE, countWords } from "../manuscript";

/**
 * The Consejero's deterministic base (docs/consejero.md, phase 1): what can be
 * measured in the text without any AI. Every figure points back to the manuscript,
 * which is always the source of truth: nothing here is stored.
 */

export interface StatsChapter {
  id: string;
  title: string;
  content: string;
}

interface Named {
  id: string;
  name: string;
  aliases: string;
}

// ---------------------------------------------------------------------------
// Presence: who and what appears in each chapter
// ---------------------------------------------------------------------------

export interface Presence {
  id: string;
  name: string;
  /** Mentions per chapter, in outline order. */
  counts: number[];
  total: number;
  /** Chapter indexes; null when never mentioned. */
  first: number | null;
  last: number | null;
  /** Chapters written since the last mention, counted up to the current one; null if never mentioned. */
  chaptersSince: number | null;
  /** Words between the last mention and the end of the current chapter. */
  wordsSince: number | null;
}

/** Image markers become spaces of the same length, so offsets keep matching the real text. */
export function proseOnly(text: string): string {
  return text.replace(MARKER_RE, (m) => " ".repeat(m.length));
}

function mentions(text: string, entity: Named): number[] {
  const one = nameMatcher(entity);
  if (!one) return [];
  const all = new RegExp(one.source, "giu");
  return [...text.matchAll(all)].map((m) => m.index!);
}

export function presence(chapters: StatsChapter[], entities: Named[], currentIndex: number): Presence[] {
  const prose = chapters.map((c) => proseOnly(c.content));
  return entities.map((e) => {
    const offsets = prose.map((t) => mentions(t, e));
    const counts = offsets.map((o) => o.length);
    const present = counts.flatMap((n, i) => (n ? [i] : []));
    const first = present.length ? present[0] : null;
    // "Since" is measured from where the author is: later chapters don't count yet.
    const before = present.filter((i) => i <= currentIndex);
    const last = present.length ? present[present.length - 1] : null;
    const lastSeen = before.length ? before[before.length - 1] : null;
    let wordsSince: number | null = null;
    if (lastSeen != null) {
      const at = offsets[lastSeen][offsets[lastSeen].length - 1];
      wordsSince = countWords(prose[lastSeen].slice(at));
      for (let i = lastSeen + 1; i <= currentIndex; i++) wordsSince += countWords(prose[i]);
    }
    return {
      id: e.id,
      name: e.name,
      counts,
      total: counts.reduce((a, b) => a + b, 0),
      first,
      last,
      chaptersSince: lastSeen == null ? null : currentIndex - lastSeen,
      wordsSince,
    };
  });
}

// ---------------------------------------------------------------------------
// Repetitions
// ---------------------------------------------------------------------------

/** Function words: they don't make a phrase or an echo worth pointing out. */
const STOPWORDS = new Set(
  `a al algo algún alguna algunas alguno algunos ante antes aquel aquella aquellas aquello aquellos aquí así aun aún
  bajo bien cada casi como cómo con contra cual cuál cuales cuando cuándo cuanto de del desde donde dónde dos
  e el él ella ellas ello ellos en entre era eran eres es esa esas ese eso esos esta está estaba estaban estado
  estar estas este esto estos estoy fue fueron fui ha había habían han has hasta hay he la las le les lo los más
  me mi mí mis mucho muy nada ni no nos nosotros o os otra otras otro otros para pero poco por porque que qué
  quien quién quienes se sea según ser si sí sido sin sino sobre su sus también tan tanto te tenía ti todo
  todos tu tú tus u un una unas uno unos usted ya yo hacia mientras luego entonces después dijo dice
  había habían hubo tenía tiene tienen ser fue sus mismo misma vez cosa algo nunca siempre todavía allí ahí
  ahora sólo solo hacer hizo puede podía cuando donde mientras porque aunque
  `.split(/\s+/).filter(Boolean),
);

interface Token {
  word: string;
  start: number;
  end: number;
  /** Index of the sentence: a phrase never crosses a sentence boundary. */
  sentence: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const BOUNDARY_RE = /[.!?¡¿;:…—\n]/;

function tokenize(text: string): Token[] {
  const prose = proseOnly(text);
  const tokens: Token[] = [];
  let sentence = 0;
  let last = 0;
  for (const m of prose.matchAll(WORD_RE)) {
    if (BOUNDARY_RE.test(prose.slice(last, m.index))) sentence++;
    tokens.push({ word: m[0].toLocaleLowerCase("es"), start: m.index!, end: m.index! + m[0].length, sentence });
    last = m.index! + m[0].length;
  }
  return tokens;
}

const isContent = (w: string) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w);

export interface Occurrence {
  chapterId: string;
  start: number;
  end: number;
  /** A few words around it, to recognise the place without opening it. */
  snippet: string;
}

export interface Repetition {
  /** As written in its first occurrence. */
  text: string;
  kind: "frase" | "eco";
  occurrences: Occurrence[];
}

function snippet(text: string, start: number, end: number, around = 40): string {
  const a = Math.max(0, start - around);
  const b = Math.min(text.length, end + around);
  return `${a > 0 ? "…" : ""}${text.slice(a, b).replace(/\s+/g, " ").trim()}${b < text.length ? "…" : ""}`;
}

const MIN_GRAM = 3;
const MAX_GRAM = 6;

interface Run {
  chapter: number;
  /** First token and number of tokens. */
  at: number;
  length: number;
}

/**
 * Phrases of three or more words, with at least two content words, that appear more
 * than once in the given chapters. A longer repeat is reported once, whole (not as its
 * overlapping pieces); a shorter phrase is listed only if it also appears outside it.
 */
export function phraseRepetitions(chapters: StatsChapter[], limit = 30): Repetition[] {
  const tokens = chapters.map((c) => tokenize(c.content));
  const covered = tokens.map((t) => new Uint8Array(t.length));
  const phrases: Run[][] = [];

  for (let n = MAX_GRAM; n >= MIN_GRAM; n--) {
    const grams = new Map<string, Run[]>();
    tokens.forEach((list, chapter) => {
      for (let at = 0; at + n <= list.length; at++) {
        if (list[at + n - 1].sentence !== list[at].sentence) continue;
        const key = list
          .slice(at, at + n)
          .map((t) => t.word)
          .join(" ");
        grams.set(key, [...(grams.get(key) ?? []), { chapter, at, length: n }]);
      }
    });
    const repeated = [...grams.values()].filter((o) => o.length > 1);
    const found: Run[][] = [];
    if (n === MAX_GRAM) {
      // A repeat longer than MAX_GRAM shows up as a chain of grams, each one token further
      // along in every occurrence: join them into one phrase.
      repeated.sort((a, b) => a[0].chapter - b[0].chapter || a[0].at - b[0].at);
      const open = new Map<string, Run[]>();
      const sig = (runs: Run[], shift: number) => runs.map((r) => `${r.chapter}:${r.at + shift}`).join(",");
      for (const occ of repeated) {
        const chain = open.get(sig(occ, 0));
        if (chain) {
          open.delete(sig(occ, 0));
          for (const r of chain) r.length++;
          open.set(sig(chain, chain[0].length - MAX_GRAM + 1), chain);
        } else {
          const runs = occ.map((r) => ({ ...r }));
          found.push(runs);
          open.set(sig(runs, 1), runs);
        }
      }
    } else {
      for (const occ of repeated) {
        if (occ.every((r) => covered[r.chapter].subarray(r.at, r.at + r.length).every(Boolean))) continue;
        found.push(occ);
      }
    }
    for (const occ of found) for (const r of occ) covered[r.chapter].fill(1, r.at, r.at + r.length);
    phrases.push(...found);
  }

  const out: Repetition[] = [];
  const seen = new Set<string>();
  for (const occ of phrases) {
    // Function words at the edges add nothing: "la puerta del" is "la puerta".
    const words = tokens[occ[0].chapter].slice(occ[0].at, occ[0].at + occ[0].length).map((t) => t.word);
    let a = 0;
    let b = words.length;
    while (a < b && !isContent(words[a])) a++;
    while (b > a && !isContent(words[b - 1])) b--;
    const core = words.slice(a, b);
    if (core.length < MIN_GRAM || core.filter(isContent).length < 2) continue;
    const key = core.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    const occurrences = occ.map((r) => {
      const list = tokens[r.chapter];
      const start = list[r.at + a].start;
      const end = list[r.at + b - 1].end;
      const text = chapters[r.chapter].content;
      return { chapterId: chapters[r.chapter].id, start, end, snippet: snippet(text, start, end) };
    });
    const first = occurrences[0];
    out.push({ text: chapters[occ[0].chapter].content.slice(first.start, first.end), kind: "frase", occurrences });
  }
  // The most noticeable first: more occurrences, then longer phrases.
  out.sort((a, b) => b.occurrences.length - a.occurrences.length || b.text.length - a.text.length);
  return out.slice(0, limit);
}

const ECHO_WINDOW = 40;

/**
 * Echoes: the same content word again within a few lines (about 40 words). Names of
 * characters and places are not echoes: they are repeated on purpose.
 */
export function echoes(chapter: StatsChapter, names: Named[], limit = 30): Repetition[] {
  const nameWords = new Set(
    names.flatMap((n) => [n.name, ...n.aliases.split(",")].flatMap((s) => s.toLocaleLowerCase("es").split(/\s+/))).filter(Boolean),
  );
  const tokens = tokenize(chapter.content).filter((t) => isContent(t.word) && t.word.length >= 4 && !nameWords.has(t.word));
  // Positions in the full word sequence, so the window is measured in words of prose.
  const all = tokenize(chapter.content);
  const position = new Map(all.map((t, i) => [t.start, i]));
  const byWord = new Map<string, Token[]>();
  for (const t of tokens) byWord.set(t.word, [...(byWord.get(t.word) ?? []), t]);

  const out: (Repetition & { close: number })[] = [];
  for (const list of byWord.values()) {
    if (list.length < 2) continue;
    const involved = new Set<Token>();
    let close = 0;
    for (let i = 1; i < list.length; i++) {
      if (position.get(list[i].start)! - position.get(list[i - 1].start)! <= ECHO_WINDOW) {
        involved.add(list[i - 1]).add(list[i]);
        close++;
      }
    }
    if (!close) continue;
    const occ = [...involved];
    out.push({
      text: chapter.content.slice(occ[0].start, occ[0].end),
      kind: "eco",
      close,
      occurrences: occ.map((t) => ({ chapterId: chapter.id, start: t.start, end: t.end, snippet: snippet(chapter.content, t.start, t.end) })),
    });
  }
  out.sort((a, b) => b.close - a.close || b.occurrences.length - a.occurrences.length);
  return out.slice(0, limit).map(({ close: _close, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Novel map
// ---------------------------------------------------------------------------

export interface MapChapter {
  id: string;
  title: string;
  words: number;
  /** Ids of the characters and places mentioned, most mentioned first. */
  characters: string[];
  places: string[];
}

export function novelMap(chapters: StatsChapter[], characters: Presence[], places: Presence[]): MapChapter[] {
  const present = (list: Presence[], i: number) =>
    list
      .filter((p) => p.counts[i] > 0)
      .sort((a, b) => b.counts[i] - a.counts[i])
      .map((p) => p.id);
  return chapters.map((c, i) => ({
    id: c.id,
    title: c.title,
    words: countWords(c.content),
    characters: present(characters, i),
    places: present(places, i),
  }));
}
