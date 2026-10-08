// Argumento general, phase 2 (docs/consejero.md): the author's whole plot, secrets and planned
// ending in their own field (novels.plot). Saved, copied with the novel and in the backup; read
// by the Consejero (global view in the cached frame, the paragraphs that matter apart), never
// by the Asistente.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, browser, novel, ch;

const PREMISE = "Premisa: en un pueblo del sur, Pola y Héctor sostienen un matrimonio que ya no existe.";
const SECRET = "Pola y Eduardo se aman desde antes de la boda; nadie lo sabe y nadie lo sabrá hasta el final.";
const GERARDO = "Gerardo, primo de Héctor, llega en el capítulo 12 con la idea de quedarse con Pola, sin decirlo nunca.";
const ENDING = "Desenlace previsto: Eduardo muere; Pola deja a Héctor y se queda sola en el pueblo.";
const PLOT = [
  PREMISE,
  "## Primera parte",
  ...Array.from({ length: 50 }, (_, i) => `Tramo ${i + 1}. Lo que va pasando en el pueblo, con sus historias paralelas y los detalles que el autor no quiere olvidar en su argumento.`),
  SECRET,
  "## Segunda parte",
  GERARDO,
  ...Array.from({ length: 50 }, (_, i) => `Tramo ${i + 51}. Más del pueblo y de la lluvia, con la misma calma y los mismos lugares de siempre en el argumento.`),
  ENDING,
].join("\n\n");
const T1 = "Pola abrió el almacén temprano.";

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El pueblo" })).data.id;
  ch = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${ch}`, "PATCH", { content: T1, revision: 0 });
  await call(`/api/novels/${novel}`, "PATCH", { synopsis: "Un matrimonio en un pueblo del sur.", guide: { tone: "Melancólico" } });
  for (const name of ["Pola", "Héctor", "Gerardo"]) await call(`/api/novels/${novel}/memory/characters`, "POST", { name });
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

test("the writer keeps the Argumento general in its own section (from the chapter list), starting from the synopsis", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: "Argumento general" }).click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.locator(".tabs .on").innerText(), "Argumento general", "opens on its tab");
  await dialog.getByText(/Solo lo lee el Consejero/).waitFor();
  await dialog.getByRole("button", { name: "Empezar desde la sinopsis" }).click();
  const field = dialog.locator("textarea.plot");
  assert.equal(await field.inputValue(), "Un matrimonio en un pueblo del sur.");
  await field.fill(PLOT);
  await dialog.getByText(/de 100\.000 caracteres/).waitFor();
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await dialog.waitFor({ state: "detached" });
  const saved = (await call(`/api/novels/${novel}`)).data;
  assert.equal(saved.novel.plot, PLOT);
  assert.equal(saved.novel.synopsis, "Un matrimonio en un pueblo del sur.", "the synopsis stays as it was");
  await ctx.close();
});

test("API: limited to 100.000 characters; copied with the novel; in the backup", async () => {
  const long = (await call(`/api/novels/${novel}`, "PATCH", { plot: "x".repeat(100_050) })).data;
  assert.equal(long.plot.length, 100_000);
  await call(`/api/novels/${novel}`, "PATCH", { plot: PLOT });
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", {})).data.id;
  const copied = (await call(`/api/novels/${copy}`)).data;
  assert.equal(copied.novel.plot, PLOT);
  const backup = (await call(`/api/novels/${novel}/backup`)).data;
  assert.equal(backup.novel.plot, PLOT);
  await call(`/api/novels/${copy}`, "DELETE");
});

test("the Asistente never receives it (scene, rewrite, analysis, «Ver contexto»)", async () => {
  await clearAiLog();
  const scene = (extra = {}) =>
    call("/api/assist", "POST", { novelId: novel, chapterId: ch, content: T1, mode: "scene", argument: "Pola cierra el almacén.", length: "media", cursor: T1.length, provider: "anthropic", ...extra });
  await scene();
  await call("/api/assist", "POST", { novelId: novel, chapterId: ch, content: T1, mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: T1.length, provider: "anthropic" });
  await call("/api/assist", "POST", { novelId: novel, chapterId: ch, content: T1, mode: "edit", action: "consistencia", selectionStart: 0, selectionEnd: T1.length, provider: "anthropic" });
  const log = await aiLog();
  assert.equal(log.length, 3);
  for (const req of log) assert.doesNotMatch(JSON.stringify(req.body), /se aman desde antes de la boda|quedarse con Pola|Desenlace previsto|Primera parte/);
  const dry = (await scene({ dryRun: true })).data;
  assert.doesNotMatch(JSON.stringify(dry), /Argumento general|se aman desde antes/);
});

test("the Consejero: its global view first in the cached frame (premise, parts, ending), the paragraphs that matter apart", async () => {
  await clearAiLog();
  const list = events((await call("/api/advisor", "POST", { novelId: novel, chapterId: ch, content: T1, provider: "anthropic", mode: "conversar", question: "¿Cuándo entra Gerardo?" })).data);
  const req = (await aiLog()).at(-1).body;
  const frame = req.system[1].text;
  assert.match(frame, /## Plan del autor \(visión general; los detalles pertinentes van aparte\)\n[^\n]+\nArgumento general:\nPremisa: en un pueblo del sur/);
  assert.match(frame, /## Primera parte[\s\S]*## Segunda parte/, "its headings");
  assert.match(frame, /Desenlace previsto: Eduardo muere/, "its ending");
  assert.match(frame, /Sinopsis:\nUn matrimonio en un pueblo del sur\./, "the synopsis, after it");
  assert.ok(frame.length < 20_000, `the frame stays bounded (${frame.length})`);
  const prompt = req.messages[0].content;
  assert.match(prompt, /<plan-del-autor-detalles>\nArgumento general:\n[\s\S]*Gerardo, primo de Héctor, llega en el capítulo 12/, "the paragraph about Gerardo, whole");
  // The same frame next turn.
  await clearAiLog();
  const id = list.find((e) => e.type === "saved").conversationId;
  await call("/api/advisor", "POST", { novelId: novel, chapterId: ch, content: `${T1} Llovía.`, provider: "anthropic", mode: "conversar", question: "¿Y Pola?", conversationId: id });
  assert.equal((await aiLog()).at(-1).body.system[1].text, frame, "identical cached frame");
});
