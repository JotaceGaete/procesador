import { proseOnly } from "../manuscript";
import { quoteExists } from "./quotes";

/**
 * Is a chapter's reading (its digest) still valid for the text? (docs/consejero.md §3, §6)
 *
 *   current   the chapter has the revision that was read
 *   touched   it changed, but little: the digest is still used ("con retoques")
 *   stale     it changed substantially, or a quote of the digest is no longer in the text
 *   missing   never read
 *
 * How much changed is measured on a sketch of the text read: its three-word sequences
 * (shingles), of which the 256 with the smallest hash are kept (a bottom-k sketch). A
 * typo changes a few sequences even inside a long paragraph; a rewrite changes most of
 * them. Up to 256 sequences (about 250 words) the measure is exact. No AI, no copy of the
 * text: only numbers.
 */

export type Freshness = "current" | "touched" | "stale" | "missing";

export interface TextSketch {
  /** Distinct shingles in the text. */
  n: number;
  /** The smallest shingle hashes, ascending. */
  h: number[];
}

const K = 256;

/**
 * Above these, a change is substantial: a share of the text (DIGEST_CHANGE_PCT, 15 %)
 * provided at least DIGEST_CHANGE_MIN_WORDS (40) words changed, so one word in a very
 * short chapter is not a rewrite; or, whatever the share, DIGEST_CHANGE_WORDS (300) new words.
 */
export function changeThresholds() {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    fraction: num("DIGEST_CHANGE_PCT", 15) / 100,
    minWords: num("DIGEST_CHANGE_MIN_WORDS", 40),
    words: num("DIGEST_CHANGE_WORDS", 300),
  };
}

function words(text: string): string[] {
  return proseOnly(text).toLocaleLowerCase("es").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** FNV-1a then a murmur3 finalizer: a well spread 32-bit hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function shingles(text: string): Set<number> {
  const w = words(text);
  const set = new Set<number>();
  if (w.length < 3) for (const x of w) set.add(hash(x));
  for (let i = 0; i + 3 <= w.length; i++) set.add(hash(`${w[i]} ${w[i + 1]} ${w[i + 2]}`));
  return set;
}

export function textSketch(text: string): TextSketch {
  const all = [...shingles(text)].sort((a, b) => a - b);
  return { n: all.length, h: all.slice(0, K) };
}

export interface ChangeMeasure {
  /** Share of the text that changed (1 − similarity of the two versions). */
  fraction: number;
  /** About how many words are new since it was read. */
  newWords: number;
  substantial: boolean;
}

export function measureChange(stored: TextSketch, text: string): ChangeMeasure {
  const now = textSketch(text);
  const a = new Set(stored.h);
  const b = new Set(now.h);
  // Bottom-k estimate of the Jaccard similarity, over the smallest hashes of the union.
  const union = [...new Set([...stored.h, ...now.h])].sort((x, y) => x - y).slice(0, K);
  const both = union.filter((x) => a.has(x) && b.has(x)).length;
  const similarity = union.length ? both / union.length : 1;
  const common = (similarity * (stored.n + now.n)) / (1 + similarity);
  const newWords = Math.max(0, Math.round(now.n - common));
  const changed = Math.round(stored.n + now.n - 2 * common);
  const t = changeThresholds();
  const fraction = 1 - similarity;
  return {
    fraction,
    newWords,
    substantial: newWords > t.words || (fraction > t.fraction && changed >= t.minWords),
  };
}

export interface DigestQuotes {
  events: { quote: string }[];
  revelations: { quote: string }[];
  threads: { quote: string }[];
}

/** Quotes of the digest that are no longer in the text. */
export function brokenQuotes(d: DigestQuotes, text: string): string[] {
  return [...d.events, ...d.revelations, ...d.threads].map((x) => x.quote).filter((q) => q && !quoteExists(text, q));
}

export function freshness(
  digest: (DigestQuotes & { source_revision: number; text_sketch: TextSketch }) | null,
  chapter: { revision: number; content: string },
): { status: Freshness; change: ChangeMeasure | null } {
  if (!digest) return { status: "missing", change: null };
  if (digest.source_revision === chapter.revision) return { status: "current", change: null };
  const change = measureChange(digest.text_sketch, chapter.content);
  if (change.substantial || brokenQuotes(digest, chapter.content).length) return { status: "stale", change };
  return { status: "touched", change };
}
