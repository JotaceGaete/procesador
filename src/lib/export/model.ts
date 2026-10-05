/**
 * The book as exporters see it (docs/exportacion.md): front matter, chapters as blocks of
 * paragraphs (with their italics), scene breaks and images, and the checks before exporting.
 * Built from the manuscript format (src/lib/manuscript.ts), the same one the editor writes.
 * Pure: DOCX and EPUB are written from this, never from the raw text.
 */
import { chapterLabel } from "../ai/context";
import { MIN_PRINT_PPI, blocks, inlineSpans, printPpi, strayMarkers, type Span } from "../manuscript";
import { cleanBook, isbnProblem, trimOf, type BookMeta } from "../book";

export interface ExportImage {
  id: string;
  asset_id: string;
  alt: string;
  decorative: boolean;
  caption: string;
  credit: string;
  layout: "inline" | "page";
  align: "center" | "left" | "right";
  width_pct: number;
}

export interface ExportFile {
  id: string;
  version: number;
  file_name: string;
  original_type: string;
  width: number;
  height: number;
  orientation: number;
}

export interface ExportSource {
  novel: { id: string; title: string; book?: unknown };
  chapters: { id: string; title: string; content: string }[];
  images: { manuscript: (ExportImage & { chapter_id: string | null })[]; files: ExportFile[] };
}

export type BookBlock =
  | { kind: "para"; spans: Span[]; first: boolean }
  | { kind: "break" }
  | { kind: "image"; image: ExportImage; file: ExportFile };

export interface BookChapter {
  /** "Capítulo 3" */
  number: string;
  /** The author's own title, if any ("La llegada"); never the default "Capítulo 3". */
  title: string;
  /** For tables of contents: "Capítulo 3: La llegada". */
  heading: string;
  blocks: BookBlock[];
}

export interface Check {
  level: "warning" | "info";
  message: string;
}

export interface BookModel {
  id: string;
  title: string;
  meta: BookMeta;
  chapters: BookChapter[];
  /** Files used by the exported images (and the cover), each once. */
  files: ExportFile[];
  cover: ExportFile | null;
  words: number;
  checks: Check[];
}

/** The copyright page when the author wrote none. */
export function defaultCopyright(title: string, meta: BookMeta): string {
  const year = meta.year || String(new Date().getFullYear());
  return [
    `${title}${meta.subtitle ? `. ${meta.subtitle}` : ""}`,
    `© ${year}${meta.author ? ` ${meta.author}` : ""}`,
    meta.publisher ? `Edición: ${meta.publisher}` : "",
    meta.isbn ? `ISBN: ${meta.isbn}` : "",
    "Reservados todos los derechos.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function bookModel(src: ExportSource): BookModel {
  const meta = cleanBook(src.novel.book);
  const files = new Map(src.images.files.map((f) => [f.id, f]));
  const images = new Map(src.images.manuscript.map((m) => [m.id, m]));
  const checks: Check[] = [];
  const used = new Map<string, ExportFile>();
  const placed = new Set<string>();
  const trim = trimOf(meta);
  const textWidthCm = (trim.width - meta.layout.margins.inside - meta.layout.margins.outside) / 10;
  let words = 0;

  const chapters = src.chapters.map((c, i) => {
    const heading = chapterLabel(i, c.title);
    const own = c.title.trim() && !/^cap[ií]tulo\s+\d+$/i.test(c.title.trim()) ? c.title.trim() : "";
    const out: BookBlock[] = [];
    let first = true;
    for (const b of blocks(c.content)) {
      if (b.kind === "separator") {
        out.push({ kind: "break" });
        first = true;
      } else if (b.kind === "image") {
        const image = images.get(b.id);
        const file = image && files.get(image.asset_id);
        if (!image || !file) {
          checks.push({ level: "warning", message: `${heading}: una imagen ya no existe y se omite.` });
          continue;
        }
        placed.add(image.id);
        used.set(file.id, file);
        out.push({ kind: "image", image, file });
        if (!image.decorative && !image.alt.trim())
          checks.push({
            level: "warning",
            message: `${heading}: la imagen «${file.file_name || "sin nombre"}» no tiene texto alternativo (EPUB: los lectores de pantalla no podrán describirla).`,
          });
        const ppi = printPpi(file.width, image.layout === "page" ? 100 : image.width_pct, textWidthCm);
        if (ppi < MIN_PRINT_PPI)
          checks.push({
            level: "info",
            message: `${heading}: la imagen «${file.file_name || "sin nombre"}» se imprimiría a ${ppi} ppp en este tamaño de página (se recomiendan ${MIN_PRINT_PPI} o más). En pantalla y en EPUB no importa.`,
          });
        first = true;
      } else {
        for (const p of b.text.split(/\n\s*\n/)) {
          const t = p.trim();
          if (!t) continue;
          words += (t.match(/\S+/g) ?? []).filter((w) => !/^\*+$/.test(w)).length;
          out.push({ kind: "para", spans: inlineSpans(t), first });
          first = false;
        }
      }
    }
    if (strayMarkers(c.content).length)
      checks.push({ level: "warning", message: `${heading}: hay un marcador de imagen dentro de un párrafo; se exporta como texto.` });
    if (!out.length) checks.push({ level: "info", message: `${heading} está vacío.` });
    return { number: `Capítulo ${i + 1}`, title: own, heading, blocks: out };
  });

  const unplaced = src.images.manuscript.filter((m) => !placed.has(m.id)).length;
  if (unplaced)
    checks.push({
      level: "info",
      message: `${unplaced === 1 ? "1 imagen sin colocar no se exporta" : `${unplaced} imágenes sin colocar no se exportan`} (están en Imágenes, fuera del texto).`,
    });
  const isbn = isbnProblem(meta.isbn);
  if (isbn) checks.push({ level: "warning", message: isbn });
  if (!meta.author.trim()) checks.push({ level: "info", message: "Falta el nombre del autor: la portada y los metadatos irán sin él." });
  const cover = meta.coverAssetId ? (files.get(meta.coverAssetId) ?? null) : null;
  if (meta.coverAssetId && !cover) checks.push({ level: "warning", message: "La imagen elegida como portada ya no existe." });
  if (cover) used.set(cover.id, cover);

  return { id: src.novel.id, title: src.novel.title, meta, chapters, files: [...used.values()], cover, words, checks };
}
