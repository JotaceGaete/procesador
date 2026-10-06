// Editor visual, Fase A: the conversion report on real chapters (docs/editor-visual.md).
// Read-only: it never writes to the database or the files it reads.
//
//   npm run visual:report -- --zip "Mi novela - copia 2026-10-06.zip"   a backup from Procesador
//   npm run visual:report -- --supabase                                  every chapter and version
//                                         (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the env)
//   npm run visual:report -- --dir carpeta-con-txt
//   npm run visual:report -- --sample                                    the built-in sample
//
// Writes the report (Markdown) to stdout, or to --out file.md.
import fs from "node:fs";
import path from "node:path";
import { report, type Source } from "../src/lib/visual/report";
import { SAMPLE } from "./visual-sample";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

/** The files of a ZIP (Procesador's backups are stored, uncompressed). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("No es un ZIP");
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (method === 0) files.set(name, buf.subarray(start, start + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function fromSupabase(): Promise<Source[]> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY");
  const get = async (q: string) => {
    const out: Record<string, string>[] = [];
    for (let from = 0; ; from += 500) {
      const res = await fetch(`${url}/rest/v1/${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 499}` } });
      if (!res.ok) throw new Error(`${q}: ${res.status} ${await res.text()}`);
      const rows = (await res.json()) as Record<string, string>[];
      out.push(...rows);
      if (rows.length < 500) return out;
    }
  };
  const novels = new Map((await get("novels?select=id,title")).map((n) => [n.id, n.title]));
  const chapters = await get("chapters?select=id,novel_id,title,position,content&order=novel_id,position");
  const versions = await get("chapter_versions?select=id,novel_id,title,reason,created_at,content&order=created_at");
  return [
    ...chapters.map((c) => ({ label: `${novels.get(c.novel_id) ?? c.novel_id} · ${c.title || "sin título"}`, content: c.content })),
    ...versions.map((v) => ({ label: `${novels.get(v.novel_id) ?? v.novel_id} · versión «${v.reason}» de ${v.title || "sin título"} (${v.created_at.slice(0, 16)})`, content: v.content })),
  ];
}

async function main() {
  let sources: Source[];
  let origin: string;
  if (opt("--zip") !== undefined) {
    const file = opt("--zip")!;
    const json = unzip(fs.readFileSync(file)).get("procesador.json");
    if (!json) throw new Error("La copia no tiene procesador.json");
    const data = JSON.parse(json.toString("utf8")) as { novel: { title: string }; chapters: { title: string; content: string }[] };
    sources = data.chapters.map((c, i) => ({ label: `${data.novel.title} · ${i + 1}. ${c.title || "sin título"}`, content: c.content }));
    origin = `copia de seguridad ${path.basename(file)}`;
  } else if (args.includes("--supabase")) {
    sources = await fromSupabase();
    origin = "Supabase (capítulos y versiones, sólo lectura)";
  } else if (opt("--dir") !== undefined) {
    const dir = opt("--dir")!;
    sources = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".md"))
      .map((f) => ({ label: f, content: fs.readFileSync(path.join(dir, f), "utf8") }));
    origin = `carpeta ${dir}`;
  } else {
    sources = SAMPLE;
    origin = "muestra incluida (scripts/visual-sample.ts), no capítulos reales";
  }
  const md = report(sources, origin);
  if (opt("--out")) fs.writeFileSync(opt("--out")!, md);
  else process.stdout.write(`${md}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
