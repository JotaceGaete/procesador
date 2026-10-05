/**
 * Presentación editorial del manuscrito (docs/formato-texto.md#presentación): how the stored
 * text reads as a book, apart from how it is stored. The same reading for Lectura and for the
 * exports (DOCX, EPUB), so that what the author sees is what the book will be.
 *
 *   - Every line with text is a paragraph. Whether the author pressed Enter once or left a
 *     blank line between paragraphs (or dialogue lines) is only how the text is typed: blank
 *     lines never become vertical space.
 *   - Spaces or tabs at the start of a line are dropped: the indent is the book's, not typed.
 *   - A scene break is a block of its own, with deliberate space and an ornament.
 *   - The first paragraph of the chapter, and the first after a scene break or an image, goes
 *     without indent (`first`), as in a printed novel.
 *
 * Pure: the text itself is never changed.
 */
import { blocks, inlineSpans, type Span } from "./manuscript";

export type PresentedBlock =
  | { kind: "para"; spans: Span[]; first: boolean }
  | { kind: "break" }
  | { kind: "image"; id: string };

/** The paragraphs of a run of text: one per line with text, trimmed. */
export function paragraphs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function present(content: string): PresentedBlock[] {
  const out: PresentedBlock[] = [];
  let first = true;
  for (const b of blocks(content)) {
    if (b.kind === "separator") {
      out.push({ kind: "break" });
      first = true;
    } else if (b.kind === "image") {
      out.push({ kind: "image", id: b.id });
      first = true;
    } else {
      for (const p of paragraphs(b.text)) {
        out.push({ kind: "para", spans: inlineSpans(p), first });
        first = false;
      }
    }
  }
  return out;
}

/**
 * A chapter's heading as the book shows it: «Capítulo 3» and the author's own title. The
 * default title the app gives («Capítulo 3») is not repeated under the number.
 */
export function chapterHeading(index: number, title: string): { number: string; title: string } {
  const t = title.trim();
  return { number: `Capítulo ${index + 1}`, title: t && !/^cap[ií]tulo\s+\d+$/i.test(t) ? t : "" };
}
