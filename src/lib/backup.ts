/**
 * Copia de seguridad (docs/versiones.md): what goes into the ZIP, built from the data the
 * server returns (/api/novels/[id]/backup). The original files are added by the caller.
 *
 *   LEEME.txt              what each file is
 *   novela.md              the whole novel to read: italics as *así*, scene breaks, images
 *   capitulos/NN Título.txt  each chapter exactly as Procesador keeps it (to recover text)
 *   procesador.json        everything: novel, Guía, chapters, Memoria, reading, images
 *   imagenes/…             the original files, as uploaded
 */
import { chapterLabel } from "./ai/context";
import { MARKER_RE, SEPARATOR_RE } from "./manuscript";

export interface BackupData {
  novel: { title: string; synopsis: string };
  chapters: { id: string; title: string; content: string }[];
  images: {
    manuscript: { id: string; asset_id: string; alt: string; caption: string; decorative: boolean }[];
    files: { id: string; version: number; file_name: string; original_type: string }[];
  };
  exported_at: string;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };

/** A name any system accepts: no path separators or reserved characters, not too long. */
export function safeName(s: string, max = 60): string {
  return (
    s
      .normalize("NFC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .replace(/[. ]+$/, "") || "sin título"
  );
}

/** Where each original file goes in the ZIP. */
export function imagePath(file: BackupData["images"]["files"][number]): string {
  const ext = EXT[file.original_type] ?? "bin";
  const base = file.file_name ? safeName(file.file_name.replace(/\.[^.]+$/, ""), 40) : "imagen";
  return `imagenes/${base} (${file.id.slice(0, 8)}).${ext}`;
}

/** The text files of the backup (name → content). */
export function backupTexts(data: BackupData): { name: string; text: string }[] {
  const files = new Map(data.images.files.map((f) => [f.id, f]));
  const images = new Map(data.images.manuscript.map((m) => [m.id, m]));
  const pad = String(data.chapters.length).length;

  const readable = (content: string) =>
    content
      .replace(SEPARATOR_RE, "* * *")
      .replace(MARKER_RE, (_, id: string) => {
        const img = images.get(id.toLowerCase());
        const file = img && files.get(img.asset_id);
        if (!img || !file) return "[imagen no encontrada]";
        const alt = img.decorative ? "" : img.alt || img.caption;
        return `![${alt.replace(/[[\]]/g, "")}](${encodeURI(imagePath(file))})${img.caption ? `\n\n*${img.caption}*` : ""}`;
      });

  const novel = [
    `# ${data.novel.title}`,
    data.novel.synopsis.trim() ? `> ${data.novel.synopsis.trim().replace(/\n/g, "\n> ")}` : "",
    ...data.chapters.map((c, i) => `## ${chapterLabel(i, c.title)}\n\n${readable(c.content).trim()}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    {
      name: "LEEME.txt",
      text: [
        `Copia de seguridad de «${data.novel.title}», hecha con Procesador el ${new Date(data.exported_at).toLocaleString("es")}.`,
        "",
        "novela.md            La novela completa para leer (cursivas entre *asteriscos*, cambios de escena como * * *).",
        "capitulos/           Cada capítulo tal como lo guarda Procesador, para recuperar su texto exacto.",
        "procesador.json      Todos los datos: novela, Guía Maestra, capítulos, Memoria, lectura del Consejero e imágenes.",
        "imagenes/            Los archivos originales de las imágenes, tal como se subieron.",
        "",
      ].join("\n"),
    },
    { name: "novela.md", text: `${novel}\n` },
    ...data.chapters.map((c, i) => ({
      name: `capitulos/${String(i + 1).padStart(pad, "0")} ${safeName(chapterLabel(i, c.title))}.txt`,
      text: c.content,
    })),
    { name: "procesador.json", text: JSON.stringify(data, null, 2) },
  ];
}

/**
 * File name of the backup itself, in plain ASCII: some browsers drop a download name with
 * accents or other characters and save it as "download". The names inside the ZIP keep them.
 */
export function backupName(data: BackupData): string {
  const ascii = safeName(data.novel.title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "-");
  return `${ascii} - copia ${data.exported_at.slice(0, 10)}.zip`;
}
