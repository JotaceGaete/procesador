// PDF = the same composition: (1) every paragraph's first words are on the page the map says;
// (2) the PDF made in the browser (WASM) and the native one have the same text on every page.
import { execSync } from "node:child_process";
import { nativeCompiler } from "./node-lib.mjs";
import { novel } from "../src/novel.mjs";
const [wasmPdf, words] = [process.argv[2], Number(process.argv[3] ?? 200000)];
const { c, compile } = nativeCompiler();
// The page made the bench: run() composed the edited book; pdf() exported state.book (edited).
const book = novel(words, { imageEvery: 4 });
const mid = book.chapters[Math.floor(book.chapters.length / 2)];
mid.blocks.find((b) => b.k === "p" && !b.first).s.push(["t", " Una frase nueva, escrita ahora, para ver cuánto cuesta recomponer."]);
const doc = compile(book);
const map = c.query(doc, { selector: "<pagemap>", field: "value" })[0];
const nativePdf = wasmPdf.replace(/\.pdf$/, "-native.pdf");
(await import("node:fs")).writeFileSync(nativePdf, c.pdf(doc));
const pageText = (file, p) => execSync(`pdftotext -f ${p} -l ${p} ${file} -`).toString();
const norm = (s) => s.replace(/-\n/g, "").replace(/\s+/g, " ");
const byId = new Map(book.chapters.flatMap((ch) => ch.blocks.filter((b) => b.k === "p").map((b) => [b.id, b])));
let checked = 0, wrong = [];
for (const [i, [id, page]] of map.paragraphs.entries()) {
  if (i % 25) continue;
  const first = byId.get(id).s.filter(([k]) => k !== "n").map(([, t]) => t).join("").split(/\s+/).slice(0, 4).join(" ");
  checked++;
  if (!norm(pageText(wasmPdf, page)).includes(first)) wrong.push(`${id} p${page}: «${first}»`);
}
const pages = Number(execSync(`pdfinfo ${wasmPdf} | grep Pages`).toString().split(/\s+/)[1]);
let differ = 0;
for (let p = 1; p <= pages; p += 7) if (pageText(wasmPdf, p) !== pageText(nativePdf, p)) differ++;
console.log(JSON.stringify({ pages, mapLast: map.last, paragraphsChecked: checked, wrongPage: wrong.slice(0, 5), wrongCount: wrong.length, pagesCompared: Math.ceil(pages / 7), wasmVsNativeDiffer: differ }));
