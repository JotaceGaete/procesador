import { MARKER_RE } from "../manuscript";

/**
 * Verifying a quote against the manuscript (docs/consejero.md, decision 5): a quote is
 * only shown as such if it is in the text. The comparison forgives what a model or a
 * copy changes without changing the words: case, spacing, the kind of quotes and dashes,
 * and an ellipsis at either end.
 */

const FOLD: Record<string, string> = {
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "‘": "'", "’": "'", "‚": "'",
  "—": "-", "–": "-", "―": "-", "…": "...", " ": " ",
};

/** The normalized text and, for each of its characters, the offset in the original. */
function normalize(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let space = true; // collapse leading and repeated whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = FOLD[text[i]] ?? text[i].toLocaleLowerCase("es");
    if (/\s/.test(ch)) {
      if (space) continue;
      space = true;
      norm += " ";
      map.push(i);
      continue;
    }
    space = false;
    for (const c of ch) {
      norm += c;
      map.push(i);
    }
  }
  return { norm, map };
}

function cleanQuote(quote: string): string {
  return normalize(quote)
    .norm.replace(/^["'\s.]+|["'\s.]+$/g, "")
    .trim();
}

export interface Located {
  start: number;
  end: number;
}

/** Where the quote is in the text (the occurrence nearest to `near`), or null if it isn't. */
export function findQuote(text: string, quote: string, near = 0): Located | null {
  const q = cleanQuote(quote);
  if (q.length < 3) return null;
  // Image markers are not prose: a quote never matches inside one.
  const prose = text.replace(MARKER_RE, (m) => " ".repeat(m.length));
  const { norm, map } = normalize(prose);
  let best: Located | null = null;
  for (let i = norm.indexOf(q); i !== -1; i = norm.indexOf(q, i + 1)) {
    const found = { start: map[i], end: map[i + q.length - 1] + 1 };
    if (!best || Math.abs(found.start - near) < Math.abs(best.start - near)) best = found;
  }
  return best;
}

export const quoteExists = (text: string, quote: string) => findQuote(text, quote) !== null;
