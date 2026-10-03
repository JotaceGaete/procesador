/**
 * Manuscript format (docs/manuscrito-imagenes.md). Read by the editor, the server,
 * the assistant's context and future exporters (PDF, EPUB, DOCX).
 *
 * A chapter is plain text. An image of the book is a marker alone on its own line:
 *
 *     [[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]]
 *
 * Rules:
 *   1. A marker is an image only when it is the whole line (spaces around it are ignored).
 *   2. A marker inside a line with other text is not an image: the editor points it
 *      out and exporters treat it as text.
 *   3. `[[…]]` is reserved for future blocks of the format (e.g. `[[separador]]`).
 *
 * The marker is an internal, transitional representation: what lasts is the
 * sequence of blocks (paragraphs and image ids) and each image's row in
 * manuscript_images. A future block editor would draw each marker as an image
 * block and keep saving it the same way, so existing chapters never change.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Any marker-looking text, valid or not. */
export const MARKER_RE = new RegExp(`\\[\\[imagen:(${UUID})\\]\\]`, "gi");
const LINE_MARKER_RE = new RegExp(`^[ \\t]*\\[\\[imagen:(${UUID})\\]\\][ \\t]*$`, "i");

export function marker(id: string) {
  return `[[imagen:${id}]]`;
}

export type Block =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "image"; id: string; start: number; end: number };

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
    if (m) {
      flush(pos);
      out.push({ kind: "image", id: m[1].toLowerCase(), start: pos, end: pos + line.length });
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

/** Words of the prose: markers don't count. */
export function countWords(text: string): number {
  return (text.replace(MARKER_RE, " ").match(/\S+/g) ?? []).length;
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
