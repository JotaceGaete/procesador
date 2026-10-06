/**
 * The book's data for publishing (docs/exportacion.md): who signs it, the front matter and
 * the page. Stored in novels.book (jsonb), validated here. Everything is optional: an export
 * with nothing filled in is still a correct book, with the novel's title.
 */

export interface TrimSize {
  id: string;
  label: string;
  /** Page size in millimetres. */
  width: number;
  height: number;
}

/** Common trim sizes (KDP and bookshops), plus letter and A4 for a manuscript. */
export const TRIM_SIZES: TrimSize[] = [
  { id: "6x9", label: "15,24 × 22,86 cm (6 × 9 in, KDP)", width: 152.4, height: 228.6 },
  { id: "5.5x8.5", label: "13,97 × 21,59 cm (5,5 × 8,5 in)", width: 139.7, height: 215.9 },
  { id: "5x8", label: "12,7 × 20,32 cm (5 × 8 in)", width: 127, height: 203.2 },
  { id: "a5", label: "A5 · 14,8 × 21 cm", width: 148, height: 210 },
  { id: "15x23", label: "15 × 23 cm", width: 150, height: 230 },
  { id: "letter", label: "Carta · 21,59 × 27,94 cm", width: 215.9, height: 279.4 },
  { id: "a4", label: "A4 · 21 × 29,7 cm", width: 210, height: 297 },
];

export interface BookLayout {
  trim: string;
  /** Margins in millimetres: top, bottom, inside (binding), outside. */
  margins: { top: number; bottom: number; inside: number; outside: number };
  /** Body text size in points. */
  fontSize: number;
  /** First-line indent of paragraphs, in millimetres (none after a heading or a scene break). */
  indent: number;
  /** Running head: the author on even pages and the title on odd ones. */
  runningHead: boolean;
}

export interface BookMeta {
  author: string;
  subtitle: string;
  /** BCP 47: "es", "es-CL"… */
  language: string;
  publisher: string;
  isbn: string;
  year: string;
  dedication: string;
  epigraph: string;
  epigraphSource: string;
  /** The copyright page, as the author wants it; a sensible default is generated if empty. */
  copyright: string;
  /** An image of the novel (its file) as the cover of the EPUB. */
  coverAssetId: string | null;
  layout: BookLayout;
}

export const DEFAULT_LAYOUT: BookLayout = {
  trim: "6x9",
  margins: { top: 20, bottom: 20, inside: 22, outside: 16 },
  fontSize: 11,
  indent: 6,
  runningHead: true,
};

export const DEFAULT_BOOK: BookMeta = {
  author: "",
  subtitle: "",
  language: "es",
  publisher: "",
  isbn: "",
  year: "",
  dedication: "",
  epigraph: "",
  epigraphSource: "",
  copyright: "",
  coverAssetId: null,
  layout: DEFAULT_LAYOUT,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const number = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Whatever comes in, a complete and valid BookMeta (unknown fields dropped, values clamped). */
export function cleanBook(input: unknown): BookMeta {
  const o = (typeof input === "object" && input ? input : {}) as Record<string, unknown>;
  const l = (typeof o.layout === "object" && o.layout ? o.layout : {}) as Record<string, unknown>;
  const m = (typeof l.margins === "object" && l.margins ? l.margins : {}) as Record<string, unknown>;
  const d = DEFAULT_LAYOUT;
  const language = text(o.language, 35).trim();
  return {
    author: text(o.author, 300),
    subtitle: text(o.subtitle, 300),
    language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) ? language : "es",
    publisher: text(o.publisher, 300),
    isbn: text(o.isbn, 40).replace(/[^0-9Xx-]/g, ""),
    year: text(o.year, 10).replace(/[^0-9]/g, ""),
    dedication: text(o.dedication, 4000),
    epigraph: text(o.epigraph, 4000),
    epigraphSource: text(o.epigraphSource, 300),
    copyright: text(o.copyright, 4000),
    coverAssetId: typeof o.coverAssetId === "string" && UUID.test(o.coverAssetId) ? o.coverAssetId : null,
    layout: {
      trim: TRIM_SIZES.some((t) => t.id === l.trim) ? String(l.trim) : d.trim,
      margins: {
        top: number(m.top, 5, 60, d.margins.top),
        bottom: number(m.bottom, 5, 60, d.margins.bottom),
        inside: number(m.inside, 5, 60, d.margins.inside),
        outside: number(m.outside, 5, 60, d.margins.outside),
      },
      fontSize: number(l.fontSize, 8, 16, d.fontSize),
      indent: number(l.indent, 0, 20, d.indent),
      runningHead: typeof l.runningHead === "boolean" ? l.runningHead : d.runningHead,
    },
  };
}

/** ISBN-13 (or ISBN-10) with a valid check digit; empty is fine (no ISBN). */
export function isbnProblem(isbn: string): string | null {
  const digits = isbn.replace(/-/g, "").toUpperCase();
  if (!digits) return null;
  if (/^\d{13}$/.test(digits)) {
    const sum = [...digits.slice(0, 12)].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(digits[12]) ? null : "El dígito de control del ISBN-13 no cuadra.";
  }
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((n, c, i) => n + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? null : "El dígito de control del ISBN-10 no cuadra.";
  }
  return "Un ISBN tiene 13 cifras (o 10 en el formato antiguo).";
}

export const trimOf = (b: BookMeta) => TRIM_SIZES.find((t) => t.id === b.layout.trim) ?? TRIM_SIZES[0];
