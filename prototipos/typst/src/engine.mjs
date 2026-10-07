// PROTOTIPO (Fase 0, descartable): Typst en el navegador (WebAssembly) para componer el libro.
// Un compilador (typst.ts → Typst 0.14) y un renderizador que dibuja páginas sueltas en <canvas>.
import { createTypstCompiler, createTypstRenderer, loadFonts } from "@myriaddreamin/typst.ts";
import TEMPLATE from "./book.typ";
import { IMAGE_SIZES } from "./novel.mjs";

export const FONT_FILES = ["LibertinusSerif-Regular.otf", "LibertinusSerif-Italic.otf", "LibertinusSerif-Semibold.otf", "LibertinusSerif-Bold.otf"];
const enc = new TextEncoder();
const now = () => performance.now();

/** Striped PNG files for the synthetic images (made in the browser, never uploaded). */
async function makeImages() {
  const out = {};
  for (const [name, [w, h]] of Object.entries(IMAGE_SIZES)) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    for (let x = 0; x < w; x += 64) {
      ctx.fillStyle = (x / 64) % 2 ? "#b9b1a6" : "#8d857b";
      ctx.fillRect(x, 0, 64, h);
    }
    ctx.fillStyle = "#3b2f25";
    ctx.font = `${Math.round(w / 12)}px serif`;
    ctx.fillText(name, w / 10, h / 2);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    out[name] = new Uint8Array(await blob.arrayBuffer());
  }
  return out;
}

export async function createEngine({ compilerWasm, rendererWasm, fontBase }) {
  const t0 = now();
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => compilerWasm,
    // Only our fonts: never the default ones from a CDN, never the system's.
    beforeBuild: [loadFonts(FONT_FILES.map((f) => `${fontBase}${f}`), { assets: false })],
  });
  const tCompiler = now() - t0;
  const t1 = now();
  const renderer = createTypstRenderer();
  await renderer.init({ getModule: () => rendererWasm });
  const tRenderer = now() - t1;
  const images = await makeImages();
  for (const [name, bytes] of Object.entries(images)) compiler.mapShadow(`/img/${name}.png`, bytes);
  compiler.addSource("/main.typ", TEMPLATE);

  // A long-lived render session (the documented pattern: keep the callback pending).
  let session = null;
  let release = null;
  const ready = new Promise((resolve) => {
    renderer.runWithSession(async (s) => {
      session = s;
      resolve();
      await new Promise((r) => (release = r));
    });
  });
  await ready;

  /**
   * Compile, read the page map and export, all in one snapshot of the world. (typst.ts 0.7.0:
   * `compiler.query()` takes a fresh, uncompiled snapshot and parses its JSON twice; this is the
   * way that works, and it doesn't compile twice.)
   */
  async function compile(book, format = "vector") {
    compiler.mapShadow("/book.json", enc.encode(JSON.stringify(book)));
    return compiler.runWithWorld({ mainFilePath: "/main.typ" }, async (world) => {
      let t = now();
      const res = await world.compile({ diagnostics: "full" });
      const ms = now() - t;
      if (res?.diagnostics?.some?.((d) => d.severity === "error" || d.severity === 1))
        throw new Error(JSON.stringify(res.diagnostics.slice(0, 3)));
      t = now();
      const map = (await world.query({ selector: "<pagemap>", field: "value" }))[0];
      const queryMs = now() - t;
      t = now();
      const art = format === "pdf" ? world.pdf({ diagnostics: "full" }) : world.vector({ diagnostics: "full" });
      const exportMs = now() - t;
      const bytes = art?.result ?? art;
      if (!(bytes instanceof Uint8Array)) throw new Error(`sin artefacto: ${JSON.stringify(art?.diagnostics ?? art).slice(0, 300)}`);
      return { bytes, map, ms, queryMs, exportMs };
    });
  }
  async function load(vector) {
    const t = now();
    renderer.manipulateData({ renderSession: session, action: "reset", data: vector });
    const pages = session.retrievePagesInfo();
    return { pages, ms: now() - t };
  }
  /** Draws one page (and only that one) into a canvas, at `pixelPerPt` device pixels per point. */
  async function renderPage(canvas, pageOffset, pixelPerPt, info) {
    const t = now();
    canvas.width = Math.ceil(info.width * pixelPerPt);
    canvas.height = Math.ceil(info.height * pixelPerPt);
    const ctx = canvas.getContext("2d");
    await renderer.renderCanvas({ renderSession: session, canvas: ctx, pageOffset, pixelPerPt, backgroundColor: "#ffffff", dataSelection: { body: true } });
    return now() - t;
  }
  return { compile, load, renderPage, init: { compilerMs: tCompiler, rendererMs: tRenderer }, dispose: () => release?.() };
}
