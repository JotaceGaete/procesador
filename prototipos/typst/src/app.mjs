// PROTOTIPO (Fase 0, descartable): página de prueba de Typst en el navegador (también iPhone).
// Mide descarga, inicio, composición, recomposición de un capítulo, páginas y dibujo de páginas
// visibles; muestra el libro (doble página o una) y permite copiar los resultados.
import { createEngine } from "./engine.mjs";
import { novel } from "./novel.mjs";
import { composeByChapters, compareWithWhole } from "./chapters.mjs";

const VERSION = "typst.ts 0.7.0 (Typst 0.14.2)";
const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) || new URLSearchParams(location.search).get("wasm") === "local";
const CDN = "https://cdn.jsdelivr.net/npm/@myriaddreamin";
const WASM = local
  ? { compiler: "./vendor/typst_ts_web_compiler_bg.wasm", renderer: "./vendor/typst_ts_renderer_bg.wasm" }
  : {
      compiler: `${CDN}/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm`,
      renderer: `${CDN}/typst-ts-renderer@0.7.0/pkg/typst_ts_renderer_bg.wasm`,
    };

const $ = (s) => document.querySelector(s);
const log = [];
const results = { version: VERSION, userAgent: navigator.userAgent, screen: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`, wasm: local ? "local" : "jsdelivr", runs: [] };
function say(line) {
  log.push(line);
  $("#log").textContent = log.join("\n");
}
const fmt = (ms) => `${Math.round(ms).toLocaleString("es")} ms`;
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

function transfers() {
  const rows = performance.getEntriesByType("resource").filter((e) => /\.wasm|\.otf/.test(e.name));
  return rows.map((e) => ({ file: e.name.split("/").pop(), transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, ms: Math.round(e.duration) }));
}

let engine = null;
let state = null; // { book, pages, map }
let at = 0; // first visible page index

async function boot() {
  if (engine) return engine;
  say(`${VERSION} · WASM ${results.wasm}`);
  const t = performance.now();
  engine = await createEngine({ compilerWasm: WASM.compiler, rendererWasm: WASM.renderer, fontBase: "./fonts/" });
  const total = performance.now() - t;
  results.init = { totalMs: Math.round(total), compilerMs: Math.round(engine.init.compilerMs), rendererMs: Math.round(engine.init.rendererMs), downloads: transfers(), heapMB: heap() };
  const sum = results.init.downloads.reduce((n, d) => n + (d.transfer || d.encoded || 0), 0);
  say(`Inicio: ${fmt(total)} (compilador ${fmt(engine.init.compilerMs)}, renderizador ${fmt(engine.init.rendererMs)}) · descargado ${sum ? mb(sum) : "¿? (caché o sin datos)"}`);
  for (const d of results.init.downloads) say(`  ${d.file}: ${mb(d.transfer || d.encoded || 0)} transferido, ${mb(d.decoded)} descomprimido, ${d.ms} ms`);
  return engine;
}

async function run(words) {
  try {
    await boot();
    const book = novel(words, { imageEvery: 4 });
    say(`\n— ${words.toLocaleString("es")} palabras (${book.words.toLocaleString("es")} reales, ${book.chapters.length} capítulos)`);
    const first = await engine.compile(book);
    const pm = { map: first.map, ms: first.queryMs };
    const loaded = await engine.load(first.bytes);
    const r = {
      words: book.words,
      chapters: book.chapters.length,
      firstCompileMs: Math.round(first.ms),
      vectorExportMs: Math.round(first.exportMs),
      pagemapMs: Math.round(pm.ms),
      loadMs: Math.round(loaded.ms),
      pages: loaded.pages.length,
      vectorMB: +(first.bytes.length / 1048576).toFixed(2),
      heapMB: heap(),
    };
    say(`Primera composición: ${fmt(first.ms)} · ${r.pages} páginas · mapa párrafo→página ${fmt(pm.ms)} · exportar para el visor ${fmt(first.exportMs)} · cargar al visor ${fmt(loaded.ms)} · artefacto ${r.vectorMB} MB`);
    // Recomposición tras editar un solo capítulo (el del medio).
    const edited = structuredClone(book);
    const mid = edited.chapters[Math.floor(edited.chapters.length / 2)];
    const p = mid.blocks.find((b) => b.k === "p" && !b.first);
    p.s.push(["t", " Una frase nueva, escrita ahora, para ver cuánto cuesta recomponer."]);
    const second = await engine.compile(edited);
    const pm2 = { map: second.map, ms: second.queryMs };
    r.recomposeMs = Math.round(second.ms);
    r.recomposePagemapMs = Math.round(pm2.ms);
    say(`Recomponer tras editar el capítulo ${mid.n}: ${fmt(second.ms)} (+ mapa ${fmt(pm2.ms)})`);
    state = { book: edited, pages: (await engine.load(second.bytes)).pages, map: pm2.map };
    // Dibujar sólo las páginas visibles.
    at = Math.max(0, state.map.chapters[0].page - 1);
    const times = await show();
    r.renderVisibleMs = times;
    r.heapAfterMB = heap();
    say(`Dibujar las páginas visibles: ${times.map(fmt).join(" + ")}${r.heapAfterMB ? ` · memoria JS ${r.heapAfterMB} MB` : ""}`);
    results.runs.push(r);
    $("#nav").hidden = false;
  } catch (e) {
    say(`ERROR: ${e.message}`);
    results.runs.push({ words, error: String(e.message) });
  }
}

const spread = () => innerWidth >= 900;
async function show() {
  const stage = $("#stage");
  stage.innerHTML = "";
  if (!state) return [];
  const n = state.pages.length;
  // Doble página: la par a la izquierda y la impar a la derecha (la página 1 sola, a la derecha).
  let idx = [at];
  if (spread()) {
    const left = at % 2 === 1 ? at : at - 1; // índice 0 = página física 1 (derecha)
    idx = [left, left + 1].filter((i) => i >= -1);
  }
  const times = [];
  const box = stage.getBoundingClientRect();
  for (const i of idx) {
    const holder = document.createElement("div");
    holder.className = "page";
    stage.append(holder);
    if (i < 0 || i >= n) {
      holder.classList.add("empty");
      continue;
    }
    const info = state.pages[i];
    const scale = Math.min((box.width / idx.length - 24) / info.width, (innerHeight * 0.78) / info.height);
    const canvas = document.createElement("canvas");
    holder.append(canvas);
    times.push(await engine.renderPage(canvas, i, scale * devicePixelRatio, info));
    canvas.style.width = `${Math.round(info.width * scale)}px`;
    canvas.style.height = `${Math.round(info.height * scale)}px`;
  }
  const printed = state.map.chapters.find((c) => c.page - 1 <= at) ? "" : "";
  $("#where").textContent = `páginas físicas ${idx.filter((i) => i >= 0 && i < n).map((i) => i + 1).join("–")} de ${n}${printed}`;
  return times;
}
async function go(delta) {
  if (!state) return;
  const step = spread() ? 2 : 1;
  at = Math.min(state.pages.length - 1, Math.max(0, at + delta * step));
  const t = await show();
  say(`  página → ${t.map(fmt).join(" + ")}`);
}
async function find() {
  if (!state) return;
  const id = $("#para").value.trim();
  const hit = state.map.paragraphs.find(([pid]) => pid === id);
  if (!hit) return say(`  ${id}: no existe`);
  at = hit[1] - 1;
  await show();
  say(`  ${id} → página física ${hit[1]}`);
}

async function byChapters(words) {
  await boot();
  const book = novel(words, { imageEvery: 4 });
  const compileMap = async (b) => (await engine.compile(b)).map;
  const t0 = performance.now();
  const whole = await compileMap(book);
  const tw = performance.now() - t0;
  const t1 = performance.now();
  const by = await composeByChapters(book, compileMap);
  const tb = performance.now() - t1;
  const cmp = compareWithWhole(by, whole);
  say(`\nPor capítulos (${words.toLocaleString("es")}): ${cmp.ok ? "IGUAL al libro entero" : `DIFERENTE: ${cmp.problems.join("; ")}`} · ${by.total} páginas, ${by.blanks} en blanco · libro entero ${fmt(tw)}, por capítulos ${fmt(tb)}`);
  results.byChapters = { words, ok: cmp.ok, problems: cmp.problems, pages: by.total, blanks: by.blanks, wholeMs: Math.round(tw), byChapterMs: Math.round(tb) };
}

/**
 * The architecture as it would be used: each chapter composed on its own (cache per chapter).
 * Time to the first chapter on screen, time per chapter, and recomposing one edited chapter.
 */
async function chapterBench(words) {
  await boot();
  const book = novel(words, { imageEvery: 4 });
  const times = [];
  const compileMap = async (b) => {
    const t = performance.now();
    const out = await engine.compile(b);
    if (b.chapters.length === 1) times.push(performance.now() - t);
    return out.map;
  };
  const t0 = performance.now();
  // Time to first view: front matter skipped, chapter 1 alone.
  const firstChapter = await engine.compile({ ...book, front: false, chapters: [book.chapters[0]], firstPage: 1 });
  const loaded = await engine.load(firstChapter.bytes);
  const canvas = document.createElement("canvas");
  await engine.renderPage(canvas, 0, 2, loaded.pages[0]);
  const firstView = performance.now() - t0;
  times.length = 0;
  const t1 = performance.now();
  const by = await composeByChapters(book, compileMap);
  const all = performance.now() - t1;
  // Edit the middle chapter and compose only that one again.
  const k = Math.floor(book.chapters.length / 2);
  const edited = structuredClone(book.chapters[k]);
  edited.blocks.find((b) => b.k === "p" && !b.first).s.push(["t", " Una frase nueva, escrita ahora, para ver cuánto cuesta recomponer."]);
  const t2 = performance.now();
  const again = await engine.compile({ ...book, front: false, chapters: [edited], firstPage: by.chapters[k].start });
  const one = performance.now() - t2;
  const r = {
    words: book.words,
    chapters: book.chapters.length,
    pages: by.total,
    firstViewMs: Math.round(firstView),
    allChaptersMs: Math.round(all),
    perChapterAvgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    perChapterMaxMs: Math.round(Math.max(...times)),
    recomposeOneChapterMs: Math.round(one),
    recomposedPages: again.map.last,
    heapMB: heap(),
  };
  results.chapterBench = [...(results.chapterBench ?? []), r];
  say(`\nPor capítulos, ${words.toLocaleString("es")}: primer capítulo en pantalla ${fmt(r.firstViewMs)} · todos ${fmt(all)} (media ${fmt(r.perChapterAvgMs)}, máx. ${fmt(r.perChapterMaxMs)} por capítulo) · recomponer el capítulo editado ${fmt(one)} · ${r.pages} páginas`);
  return r;
}

async function pdf() {
  if (!state) return;
  const t = performance.now();
  const out = await engine.compile(state.book, "pdf");
  say(`PDF: ${fmt(performance.now() - t)} (composición ${fmt(out.ms)}, exportar ${fmt(out.exportMs)}) · ${mb(out.bytes.length)}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.bytes], { type: "application/pdf" }));
  a.download = "prototipo-typst.pdf";
  a.click();
  results.pdf = { ms: Math.round(performance.now() - t), bytes: out.bytes.length };
}

$("#b50").onclick = () => run(50000);
$("#b100").onclick = () => run(100000);
$("#b200").onclick = () => run(200000);
$("#chap").onclick = () => byChapters(50000);
$("#cb200").onclick = () => chapterBench(200000);
$("#pdf").onclick = pdf;
$("#prev").onclick = () => go(-1);
$("#next").onclick = () => go(1);
$("#go").onclick = find;
$("#copy").onclick = async () => {
  const text = JSON.stringify(results, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    say("Resultados copiados.");
  } catch {
    $("#log").textContent = text;
  }
};
addEventListener("keydown", (e) => (e.key === "ArrowRight" ? go(1) : e.key === "ArrowLeft" ? go(-1) : null));
let touch = null;
$("#stage").addEventListener("touchstart", (e) => (touch = e.touches[0].clientX), { passive: true });
$("#stage").addEventListener("touchend", (e) => {
  if (touch === null) return;
  const dx = e.changedTouches[0].clientX - touch;
  if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  touch = null;
});
// For the automated bench (Playwright): window.__proto.
window.__proto = { run, byChapters, chapterBench, pdf, go, results, state: () => state };
