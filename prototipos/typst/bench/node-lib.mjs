// Native compiler helpers (for checking the template and the by-chapter logic quickly).
import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import fs from "node:fs";
import zlib from "node:zlib";
import { IMAGE_SIZES } from "../src/novel.mjs";

export const ROOT = new URL("..", import.meta.url).pathname;
export const FONTS = new URL("../../../public/prototipo-typst/fonts", import.meta.url).pathname;
export const TEMPLATE = fs.readFileSync(`${ROOT}src/book.typ`, "utf8");

export function png(w, h, shade = 160) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(w, 0); hdr.writeUInt32BE(h, 4); hdr[8] = 8; hdr[9] = 0;
  const row = Buffer.alloc(w + 1); for (let x = 0; x < w; x++) row[x + 1] = shade + ((x >> 6) % 2) * 40;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", hdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function nativeCompiler() {
  const c = NodeCompiler.create({ workspace: ROOT, fontArgs: [{ fontPaths: [FONTS] }] });
  for (const [k, [w, h]] of Object.entries(IMAGE_SIZES)) c.mapShadow(`${ROOT}img/${k}.png`, png(w, h));
  const compile = (book) => {
    c.mapShadow(`${ROOT}book.json`, Buffer.from(JSON.stringify(book)));
    const r = c.compile({ mainFileContent: TEMPLATE });
    const err = r.takeError();
    if (err) throw new Error(JSON.stringify(c.fetchDiagnostics(err)));
    return r.result;
  };
  const compileMap = async (book) => c.query(compile(book), { selector: "<pagemap>", field: "value" })[0];
  return { c, compile, compileMap };
}
