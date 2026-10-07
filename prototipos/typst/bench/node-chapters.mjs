import { nativeCompiler } from "./node-lib.mjs";
import { novel } from "../src/novel.mjs";
import { composeByChapters, compareWithWhole } from "../src/chapters.mjs";
const words = Number(process.argv[2] ?? 50000);
const { compileMap } = nativeCompiler();
for (const chapterStart of ["right", "next"]) {
  const book = novel(words, { layout: { chapterStart }, imageEvery: 2 });
  let t = performance.now();
  const whole = await compileMap(book);
  const tw = performance.now() - t;
  t = performance.now();
  const by = await composeByChapters(book, compileMap);
  const tb = performance.now() - t;
  const cmp = compareWithWhole(by, whole);
  console.log(chapterStart, `whole ${Math.round(tw)} ms, ${whole.last} pp · by chapter ${Math.round(tb)} ms, ${by.total} pp, blanks ${by.blanks}`, JSON.stringify(cmp));
}
