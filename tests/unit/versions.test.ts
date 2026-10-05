import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { diffStats, diffText, type DiffOp } from "@/lib/diff";
import { crc32, zip } from "@/lib/zip";
import { backupName, backupTexts, imagePath, safeName, type BackupData } from "@/lib/backup";

const side = (ops: DiffOp[], kind: "before" | "after") =>
  ops.filter((o) => o.kind === "same" || o.kind === (kind === "before" ? "del" : "add")).map((o) => o.text).join("");

test("diffText: both texts can be rebuilt from the operations", () => {
  const pairs = [
    ["", ""],
    ["", "Nuevo."],
    ["Viejo.", ""],
    ["Uno.\n\nDos.\n\nTres.", "Uno.\n\nDos, cambiado.\n\nTres."],
    ["La casa era azul.\nY grande.", "La casa era roja.\nY grande.\nNueva línea."],
    ["a b c d e f", "a x c d y f z"],
  ];
  for (const [a, b] of pairs) {
    const ops = diffText(a, b);
    assert.equal(side(ops, "before"), a, JSON.stringify([a, b]));
    assert.equal(side(ops, "after"), b, JSON.stringify([a, b]));
  }
});

test("diffText: a change inside a paragraph is told word by word", () => {
  const ops = diffText("Uno.\n\nLa casa era azul y grande.\n\nTres.", "Uno.\n\nLa casa era roja y grande.\n\nTres.");
  assert.deepEqual(
    ops.filter((o) => o.kind !== "same"),
    [
      { kind: "del", text: "azul" },
      { kind: "add", text: "roja" },
    ],
  );
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1 });
});

test("diffText: a long chapter with one edit is fast; texts with nothing in common are whole blocks", () => {
  const para = (i: number) => `Párrafo ${i} con algunas palabras que se repiten en la novela.\n\n`;
  const a = Array.from({ length: 4000 }, (_, i) => para(i)).join("");
  const b = a.replace("Párrafo 2000 con", "Párrafo 2000, ahora, con");
  const t = Date.now();
  const ops = diffText(a, b);
  assert.ok(Date.now() - t < 1000, "fast");
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  const x = Array.from({ length: 6000 }, (_, i) => `a${i}\n`).join("");
  const y = Array.from({ length: 6000 }, (_, i) => `b${i}\n`).join("");
  const far = diffText(x, y);
  assert.equal(side(far, "after"), y);
  assert.equal(far.filter((o) => o.kind === "add").length, 1);
});

test("crc32 matches zlib", () => {
  for (const s of ["", "a", "Procesador · ñandú", "x".repeat(10_000)]) {
    const data = new TextEncoder().encode(s);
    assert.equal(crc32(data), zlib.crc32(data));
  }
});

/** Reads a stored ZIP through its central directory, as any unzip does. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  assert.equal(view.getUint32(endAt, true), 0x06054b50, "end of central directory");
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLen));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const data = bytes.slice(start, start + size);
    assert.equal(zlib.crc32(data), crc, `${name}: crc`);
    out.set(name, new TextDecoder().decode(data));
    at += 46 + nameLen;
  }
  return out;
}

test("zip: entries come back intact, with UTF-8 names", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const parts = zip([
    { name: "LEEME.txt", data: enc("hola") },
    { name: "capitulos/01 Capítulo 1 Ñandú.txt", data: enc("Texto *en cursiva*.") },
    { name: "vacío.txt", data: enc("") },
  ]);
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) bytes.set(p, (o += p.length) - p.length);
  const files = unzip(bytes);
  assert.deepEqual([...files.keys()], ["LEEME.txt", "capitulos/01 Capítulo 1 Ñandú.txt", "vacío.txt"]);
  assert.equal(files.get("capitulos/01 Capítulo 1 Ñandú.txt"), "Texto *en cursiva*.");
});

const IMG = "3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10";
const DATA: BackupData = {
  novel: { title: "Mi novela: 1/2", synopsis: "Una sinopsis." },
  chapters: [
    { id: "c1", title: "", content: `*Uno*.\n\n[[separador]]\n\n[[imagen:${IMG}]]` },
    { id: "c2", title: "El final", content: "Dos." },
  ],
  images: {
    manuscript: [{ id: IMG, asset_id: "a1b2c3d4-0000-4000-8000-000000000000", alt: "Un mapa", caption: "El valle", decorative: false }],
    files: [{ id: "a1b2c3d4-0000-4000-8000-000000000000", version: 1, file_name: "mapa del valle.png", original_type: "image/png" }],
  },
  exported_at: "2026-10-05T12:00:00.000Z",
};

test("backup: a readable novel, each chapter exactly as kept, and all the data", () => {
  const files = new Map(backupTexts(DATA).map((f) => [f.name, f.text]));
  assert.deepEqual([...files.keys()], ["LEEME.txt", "novela.md", "capitulos/1 Capítulo 1.txt", "capitulos/2 Capítulo 2 El final.txt", "procesador.json"]);
  const md = files.get("novela.md")!;
  assert.match(md, /^# Mi novela: 1\/2/);
  assert.match(md, /## Capítulo 1\n\n\*Uno\*\.\n\n\* \* \*\n\n!\[Un mapa\]\(imagenes\/mapa%20del%20valle%20\(a1b2c3d4\)\.png\)\n\n\*El valle\*/);
  assert.match(md, /## Capítulo 2: El final\n\nDos\./);
  assert.equal(files.get("capitulos/1 Capítulo 1.txt"), DATA.chapters[0].content, "the exact text, markers included");
  assert.deepEqual(JSON.parse(files.get("procesador.json")!), DATA);
  assert.equal(imagePath(DATA.images.files[0]), "imagenes/mapa del valle (a1b2c3d4).png");
  assert.equal(backupName(DATA), "Mi novela 1 2 - copia 2026-10-05.zip");
  assert.equal(backupName({ ...DATA, novel: { ...DATA.novel, title: "Valparaíso — Ñandú" } }), "Valparaiso - Nandu - copia 2026-10-05.zip");
  assert.equal(safeName('a/b\\c:*?"<>|.'), "a b c");
  assert.equal(safeName("   "), "sin título");
});
