/**
 * Manuscript format (docs/manuscrito-imagenes.md, docs/formato-texto.md). Read by the
 * editor, the server, the assistant's context and future exporters (PDF, EPUB, DOCX).
 *
 * A chapter is plain text. Paragraphs are separated by blank lines. Two kinds of block
 * are a marker alone on its own line:
 *
 *     [[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]]   an image of the book
 *     [[separador]]                                    a scene break
 *
 * Inside a paragraph, *italics* go between single asterisks (`\*` is a literal asterisk).
 *
 * Rules:
 *   1. A marker is a block only when it is the whole line (spaces around it are ignored).
 *   2. A marker inside a line with other text is not a block: the editor points it
 *      out and exporters treat it as text.
 *   3. `[[…]]` is reserved for blocks of the format.
 *   4. Italics never cross a line: an asterisk without its pair is just an asterisk.
 *
 * The marker is an internal, transitional representation: what lasts is the
 * sequence of blocks (paragraphs and image ids) and each image's row in
 * manuscript_images. A future block editor would draw each marker as an image
 * block and keep saving it the same way, so existing chapters never change.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Any marker-looking text, valid or not. */
export const MARKER_RE = new RegExp(`\\[\\[imagen:(${UUID})\\]\\]`, "gi");
export const LINE_MARKER_RE = new RegExp(`^[ \\t]*\\[\\[imagen:(${UUID})\\]\\][ \\t]*$`, "i");

export function marker(id: string) {
  return `[[imagen:${id}]]`;
}

/** A scene break: alone on its line, like an image. */
export const SEPARATOR = "[[separador]]";
/** Any separator-looking text, on its own line or not. */
export const SEPARATOR_RE = /\[\[separador\]\]/gi;
export const LINE_SEPARATOR_RE = /^[ \t]*\[\[separador\]\][ \t]*$/i;

export type Block =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "image"; id: string; start: number; end: number }
  | { kind: "separator"; start: number; end: number };

/**
 * The chapter as a sequence of blocks: runs of text and images, with their
 * offsets in the text. This is the structure exporters will walk.
 */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  let textStart = 0;
  let pos = 0;
  const flush = (end: number) => {
    if (end > textStart && text.slice(textStart, end).trim()) out.push({ kind: "text", text: text.slice(textStart, end), start: textStart, end });
  };
  for (const line of text.split("\n")) {
    const m = LINE_MARKER_RE.exec(line);
    if (m || LINE_SEPARATOR_RE.test(line)) {
      flush(pos);
      out.push(
        m
          ? { kind: "image", id: m[1].toLowerCase(), start: pos, end: pos + line.length }
          : { kind: "separator", start: pos, end: pos + line.length },
      );
      textStart = pos + line.length + 1;
    }
    pos += line.length + 1;
  }
  flush(text.length);
  return out;
}

/** Ids of the images placed in the text, in order of appearance (repeats included). */
export function imageIds(text: string): string[] {
  return blocks(text)
    .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
    .map((b) => b.id);
}

/** Ids of markers written inside a line of text: not images (rule 2). */
export function strayMarkers(text: string): string[] {
  const placed = imageIds(text);
  const stray = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text.matchAll(MARKER_RE)) {
    const id = m[1].toLowerCase();
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (seen.get(id)! > placed.filter((x) => x === id).length) stray.add(id);
  }
  return [...stray];
}

/** Markers (images, separators) become spaces of the same length: offsets keep matching the real text. */
export function proseOnly(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text.replace(MARKER_RE, blank).replace(SEPARATOR_RE, blank);
}

/** Words of the prose: markers and the asterisks of italics don't count. */
export function countWords(text: string): number {
  return (proseOnly(text).match(/\S+/g) ?? []).filter((w) => !/^\*+$/.test(w)).length;
}

/** The block marker (image or separator) whose line holds a text offset, or null. */
export function markerLineAt(text: string, offset: number): { start: number; end: number } | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const nl = text.indexOf("\n", offset);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  return LINE_MARKER_RE.test(line) || LINE_SEPARATOR_RE.test(line) ? { start: lineStart, end: lineEnd } : null;
}

/** Position of the image marker at a text offset (the cursor on its line), or null. */
export function imageAt(text: string, offset: number): { id: string; start: number; end: number } | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const nl = text.indexOf("\n", offset);
  const lineEnd = nl === -1 ? text.length : nl;
  const m = LINE_MARKER_RE.exec(text.slice(lineStart, lineEnd));
  return m ? { id: m[1].toLowerCase(), start: lineStart, end: lineEnd } : null;
}

// ---------------------------------------------------------------------------
// Italics: *between single asterisks*, inside one line.
// ---------------------------------------------------------------------------

export interface Span {
  text: string;
  italic: boolean;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function lineAround(text: string, offset: number): { start: number; line: string } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const nl = text.indexOf("\n", offset);
  return { start, line: text.slice(start, nl === -1 ? text.length : nl) };
}

/** Where italics open and close in a line: [open, close] offsets of the two asterisks. */
function italicPairs(line: string): [number, number][] {
  const pairs: [number, number][] = [];
  // Only a single asterisk counts: a run of two or more ("**", "***") is never italics.
  const single = (i: number) => line[i] === "*" && line[i - 1] !== "*" && line[i + 1] !== "*";
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "*") {
      i++; // an escaped asterisk is a literal one
      continue;
    }
    if (!single(i)) continue;
    if (open !== -1 && !isSpace(line[i - 1]) && i > open + 1) {
      pairs.push([open, i]);
      open = -1;
    } else if (!isSpace(line[i + 1])) {
      open = i;
    }
  }
  return pairs;
}

/**
 * Text as runs of plain and italic text, without the asterisks and escapes. This is
 * what the reading view draws and what exporters will write.
 */
export function inlineSpans(text: string): Span[] {
  const out: Span[] = [];
  const push = (t: string, italic: boolean) => {
    const clean = t.replace(/\\\*/g, "*");
    if (!clean) return;
    const last = out.at(-1);
    if (last && last.italic === italic) last.text += clean;
    else out.push({ text: clean, italic });
  };
  text.split("\n").forEach((line, n) => {
    if (n > 0) push("\n", false);
    let at = 0;
    for (const [open, close] of italicPairs(line)) {
      push(line.slice(at, open), false);
      push(line.slice(open + 1, close), true);
      at = close + 1;
    }
    push(line.slice(at), false);
  });
  return out;
}

/**
 * Cursiva (Ctrl/⌘+I): the edit that toggles italics, as a range to replace, its new text
 * and the selection after it. Never wraps block markers or the blank edges of a line; a
 * selection over several paragraphs gets italics in each one.
 */
export function toggleItalic(
  text: string,
  start: number,
  end: number,
): { start: number; end: number; text: string; select: [number, number] } {
  // Italics around the cursor, or whose content (or whole run) is selected: unwrap them.
  const { start: lineStart, line } = lineAround(text, start);
  const pair = italicPairs(line)
    .map(([o, c]) => [lineStart + o, lineStart + c] as const)
    .find(([o, c]) =>
      start === end ? o < start && start <= c : (start === o + 1 && end === c) || (start === o && end === c + 1),
    );
  if (pair) {
    const [o, c] = pair;
    const content = text.slice(o + 1, c);
    const caret = start === end ? start - 1 : o;
    return { start: o, end: c + 1, text: content, select: start === end ? [caret, caret] : [o, o + content.length] };
  }
  // Nothing selected: a pair of asterisks to type in.
  if (start === end) return { start, end, text: "**", select: [start + 1, start + 1] };

  const wrapped = text
    .slice(start, end)
    .split("\n")
    .map((l) => {
      if (!l.trim() || LINE_MARKER_RE.test(l) || LINE_SEPARATOR_RE.test(l)) return l;
      const lead = l.length - l.trimStart().length;
      const body = l.trim();
      return `${l.slice(0, lead)}*${body}*${l.slice(lead + body.length)}`;
    })
    .join("\n");
  return { start, end, text: wrapped, select: [start, start + wrapped.length] };
}

// ---------------------------------------------------------------------------
// The format as the models read and write it (docs/formato-texto.md): italics travel
// *as they are*; a separator is the line `* * *`, the usual scene break in prose. What
// a model writes goes through fromModel before it reaches the manuscript.
// ---------------------------------------------------------------------------

const MODEL_SEPARATOR = "* * *";
/** A line that is only a scene break, as models (and authors) write it: ***, * * *, ⁂, #. */
const MODEL_SEPARATOR_LINE = /^[ \t]*(?:(?:\*[ \t]*){3}|⁂|#)[ \t]*$/;

/** For a model: separators become `* * *`. */
export function separatorsForModel(text: string): string {
  return text.replace(/^[ \t]*\[\[separador\]\][ \t]*$/gim, MODEL_SEPARATOR);
}

/** Context for a model: images become their description, separators `* * *`. */
export function forModel(text: string, describe: (id: string) => string): string {
  return separatorsForModel(describeImages(text, describe));
}

/**
 * A model's prose back in the manuscript format: scene-break lines become separators,
 * and bold, which the format doesn't have, becomes italics.
 */
export function fromModel(text: string): string {
  return text
    .split("\n")
    .map((line) => (MODEL_SEPARATOR_LINE.test(line) ? SEPARATOR : line.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "*$1*")))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The assistant never receives images: markers become neutral lines, and in a
// selection to rewrite, numbered placeholders it must keep.
// ---------------------------------------------------------------------------

/** For context sent to the assistant: each marker becomes `[Imagen: …]`. */
export function describeImages(text: string, describe: (id: string) => string): string {
  return text.replace(MARKER_RE, (_, id: string) => `[Imagen: ${describe(id.toLowerCase()) || "sin descripción"}]`);
}

/** A selection to rewrite: markers become [IMAGEN 1], [IMAGEN 2]… in order. */
export function protectImages(selection: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const text = selection.replace(MARKER_RE, (_, id: string) => {
    ids.push(id.toLowerCase());
    return `[IMAGEN ${ids.length}]`;
  });
  return { text, ids };
}

/**
 * Puts the real markers back into a proposal. `missing` lists the images the
 * proposal dropped; placeholders it invented are removed.
 */
export function restoreImages(proposal: string, ids: string[]): { text: string; missing: string[] } {
  const used = new Set<number>();
  const text = proposal.replace(/\[IMAGEN (\d+)\]/g, (_, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= ids.length || used.has(i)) return "";
    used.add(i);
    return marker(ids[i]);
  });
  return { text, missing: ids.filter((_, i) => !used.has(i)) };
}

/** Appends markers at the end of a text, each in its own paragraph. */
export function appendImages(text: string, ids: string[]): string {
  return [text.replace(/\s+$/, ""), ...ids.map(marker)].join("\n\n");
}

// ---------------------------------------------------------------------------
// Print resolution: computed from the original, never from interface copies.
// ---------------------------------------------------------------------------

/** Width of the text block used until the book has its own page settings. */
export const REFERENCE_TEXT_WIDTH_CM = 12;
export const MIN_PRINT_PPI = 200;
export const TARGET_PRINT_PPI = 300;

/** Pixels per inch the original would print at, at a given share of the text block. */
export function printPpi(originalWidthPx: number, widthPct: number, textWidthCm = REFERENCE_TEXT_WIDTH_CM): number {
  const inches = (textWidthCm * widthPct) / 100 / 2.54;
  return Math.round(originalWidthPx / inches);
}

/** Original width needed for the target resolution at that size. */
export function pixelsFor(widthPct: number, ppi = TARGET_PRINT_PPI, textWidthCm = REFERENCE_TEXT_WIDTH_CM): number {
  return Math.ceil(((textWidthCm * widthPct) / 100 / 2.54) * ppi);
}
