/**
 * Editor visual, Fase A: what happens to a chapter's text in the visual editor, measured
 * (scripts/visual-roundtrip.ts writes the report; docs/editor-visual.md explains it).
 *
 * Read-only: it converts, compares and counts, never changes a chapter.
 */
import { LINE_MARKER_RE, LINE_SEPARATOR_RE, MARKER_RE, SEPARATOR_RE } from "../manuscript";
import { isBlankLine, present } from "../presentation";
import { canonicalLine, lineChars, schema, toContent, toDoc } from "./document";
import type { Node as PMNode } from "prosemirror-model";

export interface ChapterFindings {
  /** content → document → content gives back the very same text. */
  identical: boolean;
  /** The editor shows exactly what Lectura and the exports show. */
  sameAsReading: boolean;
  blocks: { paragraphs: number; images: number; breaks: number };
  /** Lines that look like a marker but are not a block (Windows line ending, other characters). */
  markerLookingText: string[];
  /** Markers inside a paragraph: text in every view (the plain editor warns about them). */
  markersInParagraphs: number;
  /** Blank-looking lines made of invisible characters (ignored, as Lectura does). */
  invisibleLines: number;
  /** Lines ending in \r (Windows): kept as they are. */
  crlfLines: number;
  /**
   * Paragraphs that would read differently once edited and written in the canonical form
   * (italics next to a literal asterisk or backslash). Untouched, they stay byte for byte.
   */
  fragileParagraphs: string[];
  ms: number;
}

const excerpt = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);

function shown(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => {
    if (n.type === schema.nodes.paragraph) {
      if (!n.textContent) return;
      let s = "¶";
      n.forEach((c) => (s += c.marks.length ? `<${c.text}>` : c.text));
      out.push(s.replace(/></g, ""));
    } else out.push(n.type === schema.nodes.image ? `img:${n.attrs.id}` : "break");
  });
  return out;
}
const seen = (content: string) =>
  present(content).map((b) =>
    b.kind === "para" ? `¶${b.spans.map((s) => (s.italic ? `<${s.text}>` : s.text)).join("")}`.replace(/></g, "") : b.kind === "image" ? `img:${b.id}` : "break",
  );

export function analyse(content: string): ChapterFindings {
  const t0 = performance.now();
  const doc = toDoc(content);
  const identical = toContent(doc) === content;
  const sameAsReading = JSON.stringify(shown(doc)) === JSON.stringify(seen(content));
  const blocks = { paragraphs: 0, images: 0, breaks: 0 };
  const fragileParagraphs: string[] = [];
  doc.forEach((n) => {
    if (n.type === schema.nodes.image) blocks.images++;
    else if (n.type === schema.nodes.scene_break) blocks.breaks++;
    else if (n.textContent) {
      blocks.paragraphs++;
      const back = lineChars(canonicalLine(n));
      const letters = (text: string, italic: boolean[]) => [...text].map((c, i) => (/\s/.test(c) ? " " : italic[i] ? `<${c}>` : c)).join("").trim();
      const mine: boolean[] = [];
      n.forEach((c) => {
        for (let i = 0; i < (c.text?.length ?? 0); i++) mine.push(c.marks.length > 0);
      });
      if (letters(back.text, back.italic) !== letters(n.textContent, mine)) fragileParagraphs.push(excerpt(n.attrs.raw ?? n.textContent));
    }
  });
  const lines = content.split("\n");
  const markerLookingText = lines
    .filter((l) => (/^\s*\[\[imagen:[^\]]*\]\]\s*$/i.test(l) && !LINE_MARKER_RE.test(l)) || (/^\s*\[\[separador\]\]\s*$/i.test(l) && !LINE_SEPARATOR_RE.test(l)))
    .map((l) => JSON.stringify(excerpt(l)));
  const lookalike = (l: string) => /^\s*\[\[(imagen:[^\]]*|separador)\]\]\s*$/i.test(l);
  let markersInParagraphs = 0;
  for (const l of lines) {
    if (LINE_MARKER_RE.test(l) || LINE_SEPARATOR_RE.test(l) || isBlankLine(l) || lookalike(l)) continue;
    markersInParagraphs += (l.match(MARKER_RE) ?? []).length + (l.match(SEPARATOR_RE) ?? []).length;
  }
  return {
    identical,
    sameAsReading,
    blocks,
    markerLookingText,
    markersInParagraphs,
    invisibleLines: lines.filter((l) => isBlankLine(l) && /[^\s]/.test(l)).length,
    crlfLines: lines.filter((l) => l.endsWith("\r")).length,
    fragileParagraphs,
    ms: performance.now() - t0,
  };
}

export interface Source {
  label: string;
  content: string;
}

/** The report, in Spanish, as Markdown. */
export function report(sources: Source[], origin: string): string {
  const rows = sources.map((s) => ({ ...s, f: analyse(s.content) }));
  const total = (pick: (f: ChapterFindings) => number) => rows.reduce((n, r) => n + pick(r.f), 0);
  const chars = rows.reduce((n, r) => n + r.content.length, 0);
  const out: string[] = [];
  out.push(`# Editor visual · Fase A · conversión de capítulos`, ``, `Origen: ${origin}. ${rows.length} textos, ${chars.toLocaleString("es")} caracteres.`, ``);
  out.push(`| Comprobación | Resultado |`, `|---|---|`);
  out.push(`| content → documento → content idéntico, byte a byte | ${rows.filter((r) => r.f.identical).length} de ${rows.length} |`);
  out.push(`| El editor muestra lo mismo que Lectura y la exportación | ${rows.filter((r) => r.f.sameAsReading).length} de ${rows.length} |`);
  out.push(`| Párrafos / imágenes / separadores | ${total((f) => f.blocks.paragraphs)} / ${total((f) => f.blocks.images)} / ${total((f) => f.blocks.breaks)} |`);
  out.push(`| Líneas con aspecto de marcador que el formato no reconoce como bloque | ${total((f) => f.markerLookingText.length)} |`);
  out.push(`| Marcadores dentro de un párrafo (texto en todas las vistas) | ${total((f) => f.markersInParagraphs)} |`);
  out.push(`| Líneas sólo de caracteres invisibles (ignoradas, como en Lectura) | ${total((f) => f.invisibleLines)} |`);
  out.push(`| Líneas con fin de línea de Windows (\\r) conservadas | ${total((f) => f.crlfLines)} |`);
  out.push(`| Párrafos que cambiarían al editarlos (cursiva junto a * o \\ literal) | ${total((f) => f.fragileParagraphs.length)} |`);
  const slowest = rows.reduce((m, r) => Math.max(m, r.f.ms), 0);
  out.push(`| Conversión más lenta de un texto | ${slowest.toFixed(1)} ms |`, ``);
  const notable = rows.filter((r) => !r.f.identical || !r.f.sameAsReading || r.f.markerLookingText.length || r.f.markersInParagraphs || r.f.fragileParagraphs.length);
  if (!notable.length) out.push(`Ningún texto con diferencias ni casos a revisar.`);
  else {
    out.push(`## Textos a revisar`, ``);
    for (const r of notable) {
      out.push(`### ${r.label}`);
      if (!r.f.identical) out.push(`- **La ida y vuelta NO es idéntica.**`);
      if (!r.f.sameAsReading) out.push(`- **El editor no muestra lo mismo que Lectura.**`);
      for (const l of r.f.markerLookingText) out.push(`- Línea con aspecto de marcador, leída como texto (también en Lectura y al exportar): ${l}`);
      if (r.f.markersInParagraphs) out.push(`- ${r.f.markersInParagraphs} marcador(es) dentro de un párrafo: se ven como texto (también hoy).`);
      for (const p of r.f.fragileParagraphs) out.push(`- Cambiaría si se edita: ${JSON.stringify(p)}`);
      out.push(``);
    }
  }
  return out.join("\n");
}
