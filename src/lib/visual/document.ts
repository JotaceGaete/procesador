/**
 * Editor visual, Fase A (docs/editor-visual.md): the chapter as a ProseMirror document,
 * converted from and back to `chapters.content` in the manuscript format of today.
 *
 * `content` stays the source of truth and keeps its exact format. The document is a view of
 * it that loses nothing:
 *
 *   - each block keeps the exact text before it (`before`: newlines, blank lines, lines of
 *     invisible characters, CRLF) and the document keeps what follows the last one (`trail`);
 *   - each block keeps its original line (`raw`), written back byte for byte while the block
 *     is untouched. Only what the author edits is written again, in the canonical form.
 *
 * So `toContent(toDoc(c)) === c` for any text, and editing a paragraph changes that line only.
 * The reading of each line is the one of Lectura and the exports (src/lib/presentation.ts):
 * a line with something visible is a paragraph, a marker alone on its line is a block.
 *
 * Pure (no DOM): the editor, the tests and scripts/visual-roundtrip.mjs use it.
 */
import { Fragment, Schema, type Node as PMNode } from "prosemirror-model";
import { LINE_MARKER_RE, LINE_SEPARATOR_RE, SEPARATOR, marker } from "../manuscript";
import { isBlankLine } from "../presentation";

const blockAttrs = { raw: { default: null }, before: { default: null } };

export const schema = new Schema({
  nodes: {
    doc: { content: "block+", attrs: { trail: { default: "" }, gap: { default: "\n\n" } } },
    paragraph: {
      group: "block",
      content: "text*",
      marks: "italic",
      attrs: blockAttrs,
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    scene_break: {
      group: "block",
      atom: true,
      selectable: true,
      attrs: blockAttrs,
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr", { class: "scene-break" }],
    },
    image: {
      group: "block",
      atom: true,
      selectable: true,
      attrs: { id: {}, ...blockAttrs },
      parseDOM: [{ tag: "figure[data-image-id]", getAttrs: (d) => ({ id: (d as HTMLElement).getAttribute("data-image-id") }) }],
      toDOM: (n) => ["figure", { "data-image-id": n.attrs.id }],
    },
    text: {},
  },
  marks: {
    italic: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
  },
});

// ---------------------------------------------------------------------------
// One line of a paragraph: its visible characters, which are italic, and where each one
// comes from in the line. The same reading as inlineSpans(line.trim()).
// ---------------------------------------------------------------------------

export interface LineChars {
  text: string;
  italic: boolean[];
  /** For each visible character, where its representation starts in the line. */
  src: number[];
  /** …and where it ends (an escaped asterisk takes two characters). */
  srcEnd: number[];
  /** Where the line's content starts and ends (without the blank edges). */
  start: number;
  end: number;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** The asterisks that open and close italics in a line (as manuscript.ts reads them). */
function italicPairs(line: string): [number, number][] {
  const pairs: [number, number][] = [];
  const single = (i: number) => line[i] === "*" && line[i - 1] !== "*" && line[i + 1] !== "*";
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "*") {
      i++;
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

export function lineChars(line: string): LineChars {
  const chars: { c: string; italic: boolean; src: number; srcEnd: number }[] = [];
  const emit = (a: number, b: number, italic: boolean) => {
    for (let i = a; i < b; i++) {
      if (line[i] === "\\" && line[i + 1] === "*" && i + 1 < b) {
        chars.push({ c: "*", italic, src: i, srcEnd: i + 2 });
        i++;
      } else chars.push({ c: line[i], italic, src: i, srcEnd: i + 1 });
    }
  };
  let at = 0;
  for (const [open, close] of italicPairs(line)) {
    emit(at, open, false);
    emit(open + 1, close, true);
    at = close + 1;
  }
  emit(at, line.length, false);
  // The blank edges are never italic (italics need a visible character next to each asterisk).
  let a = 0;
  let b = chars.length;
  while (a < b && /\s/.test(chars[a].c)) a++;
  while (b > a && /\s/.test(chars[b - 1].c)) b--;
  const kept = chars.slice(a, b);
  return {
    text: kept.map((c) => c.c).join(""),
    italic: kept.map((c) => c.italic),
    src: kept.map((c) => c.src),
    srcEnd: kept.map((c) => c.srcEnd),
    start: kept.length ? kept[0].src : line.length - line.trimStart().length,
    end: kept.length ? kept[kept.length - 1].srcEnd + (kept[kept.length - 1].italic ? 1 : 0) : line.length - line.trimStart().length,
  };
}

/** A paragraph's runs: text with or without italics, adjacent equal runs merged. */
function runsOf(node: PMNode): { text: string; italic: boolean }[] {
  const runs: { text: string; italic: boolean }[] = [];
  node.forEach((child) => {
    const italic = child.marks.some((m) => m.type === schema.marks.italic);
    const last = runs.at(-1);
    if (last && last.italic === italic) last.text += child.text ?? "";
    else runs.push({ text: child.text ?? "", italic });
  });
  return runs;
}

/** The canonical line of a paragraph: literal asterisks escaped, italics between asterisks. */
export function canonicalLine(node: PMNode): string {
  let line = "";
  const esc = (t: string) => t.replace(/\*/g, "\\*");
  for (const run of runsOf(node)) {
    if (!run.italic) {
      line += esc(run.text);
      continue;
    }
    // The asterisks go next to visible characters: blank edges stay outside the italics.
    const lead = run.text.length - run.text.trimStart().length;
    const body = run.text.trim();
    if (!body) {
      line += esc(run.text);
      continue;
    }
    line += `${esc(run.text.slice(0, lead))}*${esc(body)}*${esc(run.text.slice(lead + body.length))}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// content → document
// ---------------------------------------------------------------------------

function paragraphFromLine(line: string, before: string | null): PMNode {
  const lc = lineChars(line);
  const nodes: PMNode[] = [];
  let i = 0;
  while (i < lc.text.length) {
    let j = i;
    while (j < lc.text.length && lc.italic[j] === lc.italic[i]) j++;
    nodes.push(schema.text(lc.text.slice(i, j), lc.italic[i] ? [schema.marks.italic.create()] : []));
    i = j;
  }
  return schema.nodes.paragraph.create({ raw: line, before }, nodes);
}

function blockFromLine(line: string, before: string | null): PMNode {
  const m = LINE_MARKER_RE.exec(line);
  if (m) return schema.nodes.image.create({ id: m[1].toLowerCase(), raw: line, before });
  if (LINE_SEPARATOR_RE.test(line)) return schema.nodes.scene_break.create({ raw: line, before });
  return paragraphFromLine(line, before);
}

/** The chapter's text as a document. Lossless: toContent(toDoc(c)) === c. */
export function toDoc(content: string): PMNode {
  const blocks: PMNode[] = [];
  const gaps = new Map<string, number>();
  let gapStart = 0;
  let pos = 0;
  for (const line of content.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    if (isBlankLine(line)) continue;
    const before = content.slice(gapStart, start);
    if (blocks.length) gaps.set(before, (gaps.get(before) ?? 0) + 1);
    blocks.push(blockFromLine(line, before));
    gapStart = start + line.length;
  }
  if (!blocks.length) return schema.nodes.doc.create({ trail: content }, schema.nodes.paragraph.create({ raw: "", before: "" }));
  // New paragraphs follow the chapter's habit: a blank line between them, or a single newline.
  const gap = [...gaps].sort((a, b) => b[1] - a[1])[0]?.[0];
  return schema.nodes.doc.create(
    { trail: content.slice(gapStart), gap: gap === "\n" || gap === "\n\n" ? gap : "\n\n" },
    blocks,
  );
}

// ---------------------------------------------------------------------------
// document → content, with where each block's line is
// ---------------------------------------------------------------------------

/** A block's line: the original one while it still says the same, else the canonical one. */
const lineCache = new WeakMap<PMNode, string>();
export function blockLine(node: PMNode): string {
  const cached = lineCache.get(node);
  if (cached !== undefined) return cached;
  const raw = node.attrs.raw as string | null;
  let line: string;
  if (node.type === schema.nodes.image) {
    const m = raw !== null ? LINE_MARKER_RE.exec(raw) : null;
    line = m && m[1].toLowerCase() === node.attrs.id ? raw! : marker(node.attrs.id);
  } else if (node.type === schema.nodes.scene_break) {
    line = raw !== null && LINE_SEPARATOR_RE.test(raw) ? raw : SEPARATOR;
  } else {
    line = canonicalLine(node);
    if (raw !== null && raw !== line && !raw.includes("\n") && !isBlankLine(raw) && !LINE_MARKER_RE.test(raw) && !LINE_SEPARATOR_RE.test(raw)) {
      const lc = lineChars(raw);
      if (lc.text === node.textContent && sameItalics(lc, node)) line = raw;
    }
  }
  lineCache.set(node, line);
  return line;
}

function sameItalics(lc: LineChars, node: PMNode): boolean {
  let i = 0;
  let same = true;
  node.forEach((child) => {
    const italic = child.marks.length > 0;
    for (let k = 0; k < (child.text?.length ?? 0); k++, i++) if (lc.italic[i] !== italic) same = false;
  });
  return same;
}

const blankRun = (s: string) => s.split("\n").every(isBlankLine);

/** The text before block k: the original one if it still separates blocks, else the chapter's habit. */
function gapBefore(node: PMNode, k: number, doc: PMNode): string {
  const before = node.attrs.before as string | null;
  if (before !== null && blankRun(before)) {
    // Before the first line, any blank text; between two lines, it must end one and start the other.
    if (k === 0 || (before.startsWith("\n") && before.endsWith("\n"))) return before;
  }
  return k === 0 ? "" : (doc.attrs.gap as string);
}

export interface Layout {
  content: string;
  /** Per block: where its node starts in the document and where its line is in the text. */
  blocks: { pos: number; size: number; lineStart: number; line: string; node: PMNode }[];
}

const layoutCache = new WeakMap<PMNode, Layout>();
export function layout(doc: PMNode): Layout {
  const cached = layoutCache.get(doc);
  if (cached) return cached;
  const parts: string[] = [];
  const blocks: Layout["blocks"] = [];
  let offset = 0;
  doc.forEach((node, pos, k) => {
    const gap = gapBefore(node, k, doc);
    const line = blockLine(node);
    parts.push(gap, line);
    offset += gap.length;
    blocks.push({ pos, size: node.nodeSize, lineStart: offset, line, node });
    offset += line.length;
  });
  // After the last line anything blank is harmless (at worst, spaces at the end of that line).
  let trail = doc.attrs.trail as string;
  if (!blankRun(trail)) trail = "";
  parts.push(trail);
  const result = { content: parts.join(""), blocks };
  layoutCache.set(doc, result);
  return result;
}

export const toContent = (doc: PMNode) => layout(doc).content;

// ---------------------------------------------------------------------------
// Positions: document ↔ offsets in the text, the currency of the rest of the app
// (the Asistente's selection and cursor, the Consejero's quotes, the image under the cursor).
// ---------------------------------------------------------------------------

function blockIndexAt(l: Layout, pos: number): number {
  let lo = 0;
  let hi = l.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.blocks[mid].pos <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const charsCache = new WeakMap<PMNode, LineChars>();
function charsOf(node: PMNode, line: string): LineChars {
  let lc = charsCache.get(node);
  if (!lc) charsCache.set(node, (lc = lineChars(line)));
  return lc;
}

/**
 * The offset in the text of a document position. `side` says which way a selection edge
 * grows: a selection that starts at the first italic letter includes the opening asterisk,
 * one that ends at the last includes the closing one, so italics are never cut in half.
 */
export function posToOffset(doc: PMNode, pos: number, side: "start" | "end" = "start"): number {
  const l = layout(doc);
  if (!l.blocks.length) return 0;
  const k = blockIndexAt(l, pos);
  const b = l.blocks[k];
  // The end of a selection that stops right after a block (an image selected whole) is that block's end.
  if (side === "end" && pos === b.pos && k > 0) return l.blocks[k - 1].lineStart + l.blocks[k - 1].line.length;
  if (pos <= b.pos) return b.lineStart;
  if (pos >= b.pos + b.size) return b.lineStart + b.line.length;
  if (!b.node.isTextblock) return side === "end" ? b.lineStart + b.line.length : b.lineStart;
  const lc = charsOf(b.node, b.line);
  const i = pos - b.pos - 1;
  const n = lc.text.length;
  if (n === 0) return b.lineStart + lc.start;
  if (side === "end" && i > 0) {
    const closes = lc.italic[i - 1] && (i === n || !lc.italic[i]);
    return b.lineStart + lc.srcEnd[i - 1] + (closes ? 1 : 0);
  }
  if (i >= n) return b.lineStart + lc.end;
  const opens = lc.italic[i] && (i === 0 || !lc.italic[i - 1]);
  return b.lineStart + lc.src[i] - (opens ? 1 : 0);
}

/** The document position for an offset in the text (the nearest place one can type). */
export function offsetToPos(doc: PMNode, offset: number): number {
  const l = layout(doc);
  let lo = 0;
  let hi = l.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.blocks[mid].lineStart <= offset) lo = mid;
    else hi = mid - 1;
  }
  const b = l.blocks[lo];
  if (!b.node.isTextblock) return offset > b.lineStart + b.line.length && lo + 1 < l.blocks.length ? l.blocks[lo + 1].pos : b.pos;
  const lc = charsOf(b.node, b.line);
  const at = offset - b.lineStart;
  if (at > b.line.length && lo + 1 < l.blocks.length) {
    // In the blank lines after this paragraph: the start of the next block.
    const next = l.blocks[lo + 1];
    return next.node.isTextblock ? next.pos + 1 : next.pos;
  }
  let i = 0;
  while (i < lc.text.length && lc.srcEnd[i] <= at) i++;
  return b.pos + 1 + i;
}

/** A fragment of manuscript text as document content (for pasting text). */
export function fragmentFromText(text: string): Fragment {
  return toDoc(text.replace(/\r\n?/g, "\n")).content;
}
