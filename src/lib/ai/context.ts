import type { Character } from "../types";

/** Rough estimate for Spanish prose; good enough to warn about cost, not for billing. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

const BEFORE_CHARS = 4000;
const AFTER_CHARS = 1500;
const EXCERPT_BUDGET_CHARS = 12_000;
const MAX_PARAGRAPH_CHARS = 1500;

export interface Range {
  start: number;
  end: number;
}

/** Text around the selection, widened to whole paragraphs when that stays close to the limit. */
export function nearbyRange(content: string, sel: Range): Range {
  let start = Math.max(0, sel.start - BEFORE_CHARS);
  let end = Math.min(content.length, sel.end + AFTER_CHARS);
  const paraStart = content.lastIndexOf("\n", start);
  if (paraStart !== -1 && start - paraStart < 500) start = paraStart + 1;
  const paraEnd = content.indexOf("\n", end);
  if (paraEnd !== -1 && paraEnd - end < 500) end = paraEnd;
  return { start: Math.min(start, sel.start), end: Math.max(end, sel.end) };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the full name, its first word and every alias, as whole words. */
export function nameMatcher(c: Pick<Character, "name" | "aliases">): RegExp | null {
  const names = new Set<string>();
  const full = c.name.trim();
  if (full) names.add(full);
  const first = full.split(/\s+/)[0];
  if (first && first.length >= 3) names.add(first);
  for (const alias of c.aliases.split(",")) if (alias.trim().length >= 2) names.add(alias.trim());
  if (!names.size) return null;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

/** Chosen character first, then anyone named in the given text. */
export function relevantCharacters(characters: Character[], chosen: Character | null, text: string): Character[] {
  const mentioned = characters.filter((c) => c.id !== chosen?.id && nameMatcher(c)?.test(text));
  return chosen ? [chosen, ...mentioned] : mentioned;
}

interface Paragraph extends Range {
  text: string;
}

function paragraphs(content: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[0].trim()) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * Paragraphs elsewhere in the manuscript where the character appears, so a
 * consistency check sees how they behaved before without sending the whole book.
 * When there are too many, keeps an even spread from beginning to end.
 */
export function characterExcerpts(content: string, character: Character, exclude: Range): string | null {
  const matcher = nameMatcher(character);
  if (!matcher) return null;
  const hits = paragraphs(content).filter((p) => (p.end <= exclude.start || p.start >= exclude.end) && matcher.test(p.text));
  if (!hits.length) return null;

  const clipped = hits.map((p) => ({
    ...p,
    text: p.text.length > MAX_PARAGRAPH_CHARS ? `${p.text.slice(0, MAX_PARAGRAPH_CHARS)}…` : p.text,
  }));
  const LABEL_CHARS = 32; // "[≈NN% del manuscrito]" plus separators
  const total = clipped.reduce((n, p) => n + p.text.length + LABEL_CHARS, 0);
  let picked = clipped;
  if (total > EXCERPT_BUDGET_CHARS) {
    const avg = total / clipped.length;
    const count = Math.max(1, Math.floor(EXCERPT_BUDGET_CHARS / avg));
    const step = clipped.length / count;
    picked = Array.from({ length: count }, (_, i) => clipped[Math.floor(i * step)]);
  }

  const omitted = hits.length - picked.length;
  const body = picked
    .map((p) => `[≈${Math.round((p.start / Math.max(1, content.length)) * 100)}% del manuscrito]\n${p.text}`)
    .join("\n\n");
  return omitted > 0 ? `${body}\n\n(${omitted} pasajes más con ${character.name} no incluidos)` : body;
}
