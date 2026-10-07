// A/B: the same 200k book, header/footer logic as is vs. without the per-page queries.
import { nativeCompiler, TEMPLATE } from "./node-lib.mjs";
import { novel } from "../src/novel.mjs";
const words = Number(process.argv[2] ?? 200000);
const variants = {
  actual: TEMPLATE,
  sinMapa: TEMPLATE.replace(/\/\/ -{10,} mapa para la aplicación[\s\S]*$/, ""),
};
for (const [name, src] of Object.entries(variants)) {
  const { c } = nativeCompiler();
  const book = novel(words, { imageEvery: 4 });
  c.mapShadow(`${new URL("..", import.meta.url).pathname}book.json`, Buffer.from(JSON.stringify(book)));
  const t = performance.now();
  const r = c.compile({ mainFileContent: src });
  const e = r.takeError();
  if (e) { console.log(name, JSON.stringify(c.fetchDiagnostics(e)).slice(0, 300)); continue; }
  console.log(name, Math.round(performance.now() - t), "ms");
}
