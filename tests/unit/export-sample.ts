// A sample book for the exporters' tests (and for checking them with LibreOffice and epubcheck).
import zlib from "node:zlib";
import { bookModel, type ExportSource } from "@/lib/export/model";
import type { PreparedImage } from "@/lib/export/docx";

/** A real grey PNG of the given size. */
export function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

export const IMG = "3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10";
export const MAP = "00000000-1111-4222-8333-444444444444";
export const FILE = "a1b2c3d4-0000-4000-8000-000000000001";
export const FILE2 = "a1b2c3d4-0000-4000-8000-000000000002";

export const SOURCE: ExportSource = {
  novel: {
    id: "11111111-1111-4111-8111-111111111111",
    title: "La casa del puerto",
    book: {
      author: "Ana Pérez",
      subtitle: "Una novela",
      language: "es",
      publisher: "Ediciones del Muelle",
      isbn: "978-84-376-0494-7",
      year: "2026",
      dedication: "A mi madre.",
      epigraph: "Todo puerto es una despedida.",
      epigraphSource: "Anónimo",
      coverAssetId: FILE,
      layout: { trim: "6x9", fontSize: 11, indent: 6, runningHead: true, margins: { top: 20, bottom: 20, inside: 22, outside: 16 } },
    },
  },
  chapters: [
    {
      id: "c1",
      title: "La llegada",
      content: `Elena leyó *Rayuela* de un tirón & sin <prisa>.\n\nSegundo párrafo,\ncon un salto de línea.\n\n[[separador]]\n\nOtra escena.\n\n[[imagen:${IMG}]]\n\nDespués de la imagen.`,
    },
    { id: "c2", title: "Capítulo 2", content: `Un mapa a página completa.\n\n[[imagen:${MAP}]]\n\nFin.` },
  ],
  images: {
    manuscript: [
      { id: IMG, asset_id: FILE, chapter_id: "c1", alt: "El puerto al amanecer", decorative: false, caption: "El puerto", credit: "Foto: Archivo", layout: "inline", align: "center", width_pct: 50 },
      { id: MAP, asset_id: FILE2, chapter_id: "c2", alt: "", decorative: false, caption: "", credit: "", layout: "page", align: "center", width_pct: 100 },
    ],
    files: [
      { id: FILE, version: 1, file_name: "puerto.png", original_type: "image/png", width: 400, height: 300, orientation: 1 },
      { id: FILE2, version: 1, file_name: "mapa.png", original_type: "image/png", width: 300, height: 400, orientation: 1 },
    ],
  },
};

export const model = () => bookModel(SOURCE);
export const prepared = () =>
  new Map<string, PreparedImage>([
    [FILE, { bytes: png(400, 300), ext: "png", width: 400, height: 300 }],
    [FILE2, { bytes: png(300, 400), ext: "png", width: 300, height: 400 }],
  ]);
