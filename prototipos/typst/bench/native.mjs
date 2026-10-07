// Native Typst (the same typst.ts 0.7.0 / Typst 0.14.2, compiled for the server) on the same books:
// the reference for a server-side Plan B and for the PDF.
import fs from "node:fs";
import { nativeCompiler } from "./node-lib.mjs";
import { novel } from "../src/novel.mjs";
const OUT = process.argv[2];
const rows = [];
for (const words of [50000, 100000, 200000]) {
  const { c, compile } = nativeCompiler();
  const book = novel(words, { imageEvery: 4 });
  let t = performance.now();
  const doc = compile(book);
  const first = performance.now() - t;
  t = performance.now();
  const map = c.query(doc, { selector: "<pagemap>", field: "value" })[0];
  const q = performance.now() - t;
  const edited = structuredClone(book);
  const mid = edited.chapters[Math.floor(edited.chapters.length / 2)];
  mid.blocks.find((b) => b.k === "p" && !b.first).s.push(["t", " Una frase nueva, escrita ahora, para ver cuánto cuesta recomponer."]);
  t = performance.now();
  const doc2 = compile(edited);
  const again = performance.now() - t;
  t = performance.now();
  const pdf = c.pdf(doc2);
  const pdfMs = performance.now() - t;
  fs.writeFileSync(`${OUT}/native-${words}.pdf`, pdf);
  t = performance.now();
  const vec = c.vector(doc2);
  const vecMs = performance.now() - t;
  rows.push({ words: book.words, chapters: book.chapters.length, pages: map.last, firstMs: Math.round(first), queryMs: Math.round(q), recomposeMs: Math.round(again), pdfMs: Math.round(pdfMs), pdfMB: +(pdf.length / 1048576).toFixed(2), vectorMs: Math.round(vecMs), vectorMB: +(vec.length / 1048576).toFixed(2), rssMB: Math.round(process.memoryUsage().rss / 1048576) });
  console.log(JSON.stringify(rows.at(-1)));
}
