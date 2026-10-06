import type { Character, Fact, Memory, Place, Relationship } from "../types";

/** Rough estimate for Spanish prose; good enough to warn about size, not for billing. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

const BEFORE_CHARS = 4000;
const AFTER_CHARS = 1500;
const EXCERPT_BUDGET_CHARS = 12_000;
const MAX_PARAGRAPH_CHARS = 1500;
const MAX_FACTS = 40;

export interface Range {
  start: number;
  end: number;
}

/** Text around the selection, widened to whole paragraphs when that stays close to the limit. */
export function nearbyRange(content: string, sel: Range, before = BEFORE_CHARS, after = AFTER_CHARS): Range {
  let start = Math.max(0, sel.start - before);
  let end = Math.min(content.length, sel.end + after);
  const paraStart = content.lastIndexOf("\n", start);
  if (start > 0 && paraStart !== -1 && start - paraStart < 500) start = paraStart + 1;
  const paraEnd = content.indexOf("\n", end);
  if (paraEnd !== -1 && paraEnd - end < 500) end = paraEnd;
  return { start: Math.min(start, sel.start), end: Math.max(end, sel.end) };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the full name, its first word and every alias, as whole words. Works for characters and places. */
export function nameMatcher(c: { name: string; aliases: string }): RegExp | null {
  const names = new Set<string>();
  const full = c.name.trim();
  if (full) names.add(full);
  const first = full.split(/\s+/)[0];
  if (first && first.length >= 3 && first !== full) names.add(first);
  for (const alias of c.aliases.split(",")) if (alias.trim().length >= 2) names.add(alias.trim());
  if (!names.size) return null;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

/** Chosen characters first, then anyone named in the given text. */
export function relevantCharacters(characters: Character[], chosenIds: string[], text: string): Character[] {
  const chosen = chosenIds.map((id) => characters.find((c) => c.id === id)).filter((c): c is Character => Boolean(c));
  const mentioned = characters.filter((c) => !chosenIds.includes(c.id) && nameMatcher(c)?.test(text));
  return [...chosen, ...mentioned];
}

// ---------------------------------------------------------------------------
// Manuscript split in chapters
// ---------------------------------------------------------------------------

export interface ChapterText {
  id: string;
  title: string;
  content: string;
}

export interface Manuscript {
  text: string;
  chapters: (ChapterText & { index: number; start: number; end: number })[];
}

/** Joins the chapters (with the current one's unsaved text) and remembers where each one starts. */
export function buildManuscript(chapters: ChapterText[], current: { id: string; content: string }): Manuscript {
  let text = "";
  const out: Manuscript["chapters"] = [];
  chapters.forEach((c, index) => {
    const content = c.id === current.id ? current.content : c.content;
    const header = `## ${chapterLabel(index, c.title)}\n\n`;
    if (text) text += "\n\n";
    text += header;
    const start = text.length;
    text += content;
    out.push({ ...c, content, index, start, end: text.length });
  });
  return { text, chapters: out };
}

export function chapterLabel(index: number, title: string) {
  const t = title.trim();
  return t && !/^cap[ií]tulo\s+\d+$/i.test(t) ? `Capítulo ${index + 1}: ${t}` : `Capítulo ${index + 1}`;
}

function locate(ms: Manuscript, offset: number): string {
  const c = ms.chapters.find((ch) => offset >= ch.start && offset <= ch.end) ?? ms.chapters.at(-1);
  return c ? chapterLabel(c.index, c.title) : "";
}

interface Paragraph extends Range {
  text: string;
}

function paragraphs(content: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[0].trim() && !m[0].startsWith("## Capítulo")) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * Paragraphs elsewhere in the novel where the character (or place) appears, so a
 * consistency check sees what was already established without sending the whole book.
 * When there are too many, keeps an even spread from beginning to end.
 */
export function excerpts(
  ms: Manuscript,
  who: { name: string; aliases: string },
  exclude: Range,
  budget = EXCERPT_BUDGET_CHARS,
): string | null {
  const matcher = nameMatcher(who);
  if (!matcher) return null;
  const hits = paragraphs(ms.text).filter((p) => (p.end <= exclude.start || p.start >= exclude.end) && matcher.test(p.text));
  if (!hits.length) return null;

  const clipped = hits.map((p) => ({
    ...p,
    text: p.text.length > MAX_PARAGRAPH_CHARS ? `${p.text.slice(0, MAX_PARAGRAPH_CHARS)}…` : p.text,
  }));
  const LABEL_CHARS = 32; // "[Capítulo N]" plus separators
  const total = clipped.reduce((n, p) => n + p.text.length + LABEL_CHARS, 0);
  let picked = clipped;
  if (total > budget) {
    const avg = total / clipped.length;
    const count = Math.max(1, Math.floor(budget / avg));
    const step = clipped.length / count;
    picked = Array.from({ length: count }, (_, i) => clipped[Math.floor(i * step)]);
  }

  const omitted = hits.length - picked.length;
  const body = picked.map((p) => `[${locate(ms, p.start)}]\n${p.text}`).join("\n\n");
  return omitted > 0 ? `${body}\n\n(${omitted} pasajes más con ${who.name} no incluidos)` : body;
}

/** Offset of a position of the current chapter inside the whole manuscript. */
export function manuscriptRange(ms: Manuscript, chapterId: string, range: Range): Range {
  const c = ms.chapters.find((ch) => ch.id === chapterId);
  return c ? { start: c.start + range.start, end: c.start + range.end } : range;
}

// ---------------------------------------------------------------------------
// Narrative memory selection
// ---------------------------------------------------------------------------

export interface SelectedMemory {
  characters: Character[];
  relationships: Relationship[];
  places: Place[];
  facts: Fact[];
}

/**
 * Picks the memory that matters for a request: the chosen and mentioned
 * characters, the relationships between them, the places named or chosen, and
 * the approved facts linked to any of those (or to the current chapter).
 */
export function selectMemory(
  memory: Memory,
  opts: {
    text: string;
    characterIds: string[];
    placeIds?: string[];
    chapterId: string | null;
    chapterOrder: string[];
    /** "focus": only relationships and facts of the chosen characters. */
    focus?: boolean;
    /**
     * Temporal ignorance (writing a scene): facts of later chapters are left out, never
     * sent "marked as later". A fact without a chapter counts as known from the start.
     */
    noLaterThan?: string;
  },
): SelectedMemory & { later: number } {
  const characters = relevantCharacters(memory.characters, opts.characterIds, opts.text);
  const charIds = new Set(
    (opts.focus ? characters.filter((c) => opts.characterIds.includes(c.id)) : characters).map((c) => c.id),
  );
  const allIds = new Set(characters.map((c) => c.id));

  const relationships = memory.relationships.filter((r) =>
    opts.focus ? charIds.has(r.from_id) || charIds.has(r.to_id) : allIds.has(r.from_id) && allIds.has(r.to_id),
  );
  // In focus mode the other end of a relationship is relevant too.
  if (opts.focus) {
    for (const r of relationships) {
      for (const id of [r.from_id, r.to_id]) {
        const c = memory.characters.find((x) => x.id === id);
        if (c && !allIds.has(id)) {
          allIds.add(id);
          characters.push(c);
        }
      }
    }
  }

  const placeIds = new Set(opts.placeIds ?? []);
  const places = memory.places.filter((p) => placeIds.has(p.id) || nameMatcher(p)?.test(opts.text));
  const relevantPlaceIds = new Set(places.map((p) => p.id));

  // Facts that name someone relevant count even without explicit links.
  const named = opts.focus ? characters.filter((c) => charIds.has(c.id)) : [...characters, ...places];
  const matchers = named.map(nameMatcher).filter((m): m is RegExp => Boolean(m));
  const limit = opts.noLaterThan ? opts.chapterOrder.indexOf(opts.noLaterThan) : -1;
  const isLater = (f: Fact) => limit >= 0 && Boolean(f.chapter_id) && opts.chapterOrder.indexOf(f.chapter_id!) > limit;
  const scored = memory.facts
    .filter((f) => f.status === "approved")
    .map((f) => {
      let score = 0;
      if (f.character_ids.some((id) => charIds.has(id))) score += 3;
      else if (!opts.focus && f.character_ids.some((id) => allIds.has(id))) score += 2;
      if (f.place_id && relevantPlaceIds.has(f.place_id)) score += 2;
      if (f.chapter_id && f.chapter_id === opts.chapterId) score += 1;
      if (matchers.some((m) => m.test(f.text))) score += 1;
      return { f, score };
    })
    .filter((x) => x.score > 0);
  // Relevant facts of later chapters: counted (the author is told), never sent.
  const later = scored.filter((x) => isLater(x.f)).length;
  const kept = scored.filter((x) => !isLater(x.f));
  kept.sort((a, b) => b.score - a.score);
  const order = (f: Fact) => (f.chapter_id ? opts.chapterOrder.indexOf(f.chapter_id) : -1);
  const facts = kept
    .slice(0, MAX_FACTS)
    .map((x) => x.f)
    .sort((a, b) => order(a) - order(b));

  return { characters, relationships, places, facts, later };
}
