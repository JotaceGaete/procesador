// Quick iteration with the native compiler (not the measurement).
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import fs from "node:fs";
import zlib from "node:zlib";
import { novel, IMAGE_SIZES } from "../src/novel.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FONTS = new URL("../../../public/prototipo-typst/fonts", import.meta.url).pathname;
function png(w, h, shade = 160) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(w, 0); hdr.writeUInt32BE(h, 4); hdr[8] = 8; hdr[9] = 0;
  const row = Buffer.alloc(w + 1); for (let x = 0; x < w; x++) row[x + 1] = shade + ((x >> 6) % 2) * 40;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", hdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const words = Number(process.argv[2] ?? 20000);
const c = NodeCompiler.create({ workspace: ROOT, fontArgs: [{ fontPaths: [FONTS] }] });
for (const [k, [w, h]] of Object.entries(IMAGE_SIZES)) c.mapShadow(`${ROOT}img/${k}.png`, png(w, h));
const b = novel(words, { imageEvery: Number(process.env.EVERY ?? 6), layout: { floatImages: process.env.FLOAT === "1" } });
c.mapShadow(`${ROOT}book.json`, Buffer.from(JSON.stringify(b)));
const src = fs.readFileSync(`${ROOT}/src/book.typ`, "utf8");
let t = performance.now();
const r = c.compile({ mainFileContent: src });
const err = r.takeError(); if (err) { console.log(c.fetchDiagnostics(err)); process.exit(1); }
const w = r.takeWarnings(); if (w) console.log("warnings", JSON.stringify(c.fetchDiagnostics(w)).slice(0, 2000));
const doc = r.result;
console.log("compile ms", Math.round(performance.now() - t), "words", b.words, "chapters", b.chapters.length);
t = performance.now();
const map = c.query(doc, { selector: "<pagemap>", field: "value" })[0];
console.log("query ms", Math.round(performance.now() - t), "paragraphs", map.paragraphs.length, "printed total", map.total);
console.log("chapters", JSON.stringify(map.chapters.slice(0, 6)), "images", JSON.stringify(map.images));
const pdf = c.pdf(doc);
fs.writeFileSync(process.argv[3] ?? "/tmp/claude-0/-home-user-saas/7226b8d8-cc51-5672-bfec-8a6de4f3993e/scratchpad/book.pdf", pdf);
console.log("pdf bytes", pdf.length);
