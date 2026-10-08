// Consejero, phase 3 (docs/consejero.md): actions and free questions with context
// recipes, a deterministic planner, and observations whose quotes are verified against
// the manuscript. API with the mock AI, then the "Consultar" view in the browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, other, ch, elena, browser, page;

const T1 = "Elena juró que nunca había visto el mar.\n\nCABO: La carta de Marta.\n\nJuan guardó silencio toda la tarde.";
const T2 = "Juan llegó tarde al puerto.\n\nElena lo esperaba con la carta en la mano.";
// The open chapter, as the editor has it (not saved yet).
const LIVE =
  "Elena recordó los veranos en Cartagena, frente al mar.\n\nLa lámpara temblaba sobre la mesa. Afuera, la lámpara temblaba sobre la mesa del vecino.";

const cardsOf = (list) => list.find((e) => e.type === "observations");
const advise = (extra) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId: ch[2], content: LIVE, provider: "anthropic", ...extra });
async function usageRows(purpose) {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/ai_usage?novel_id=eq.${novel}&purpose=eq.${purpose}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  return res.json();
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El mar" })).data.id;
  other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (const title of ["Dos", "Tres"]) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title })).data.id);
  for (const [i, content] of [T1, T2, "Borrador."].entries()) await call(`/api/chapters/${ch[i]}`, "PATCH", { content, revision: 0 });
  elena = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", description: "Nació en Santiago." })).data.id;
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Juan" });
  await call(`/api/novels/${novel}`, "PATCH", { synopsis: "Elena descubre quién escribió la carta." });
  // Only chapter 1 has been read.
  await call(`/api/chapters/${ch[0]}/digest`, "POST", { provider: "anthropic" });
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- dry run

test("dry run: the context by levels, and the chapters it would like read first; no AI", async () => {
  await clearAiLog();
  const { status, data } = await advise({ action: "analizar", dryRun: true });
  assert.equal(status, 200, JSON.stringify(data));
  const labels = data.parts.map((p) => p.label);
  assert.equal(labels[0], "Marco: guía, mapa, resumen global y cabos");
  assert.ok(labels.includes("Capítulo 3: Tres completo"));
  assert.ok(labels.includes("Fichas: caps. 1"), labels.join(" | "));
  assert.equal(labels.at(-1), "1 capítulo sin ficha al día");
  assert.deepEqual(data.unread.map((u) => u.id), [ch[1]], "chapter 2, before the open one, was never read");
  assert.ok(data.unread[0].estimate > 0);
  assert.deepEqual(data.plan, { type: "plan", action: "analizar", label: "Analizar capítulo", detail: "", mode: "analizar" });
  assert.equal((await aiLog()).length, 0);
});

test("validation: an action or a question; known actions; the novel's own chapters", async () => {
  assert.equal((await advise({})).status, 400);
  assert.equal((await advise({ action: "escribir" })).status, 400);
  assert.equal((await advise({ action: "analizar", provider: "nope" })).status, 400);
  const foreign = await call("/api/advisor", "POST", { novelId: other, chapterId: ch[0], content: "", action: "analizar", provider: "anthropic" });
  assert.equal(foreign.status, 404);
});

// ---------------------------------------------------------------- an action

test("Analizar capítulo: the Consejero's model, a cached frame, the live chapter and the digests", async () => {
  await call(`/api/chapters/${ch[1]}/digest`, "POST", { provider: "anthropic" });
  await clearAiLog();
  const list = events((await advise({ action: "analizar" })).data);
  assert.deepEqual(list.slice(0, 2).map((e) => e.type), ["context", "plan"]);
  assert.deepEqual(list.slice(-2).map((e) => e.type), ["observations", "saved"], "the cards come last, then the exchange is stored");
  assert.ok(list.some((e) => e.type === "usage"));

  const [sent] = await aiLog();
  assert.equal(sent.body.model, "claude-consejero-e2e");
  assert.equal(sent.body.max_tokens, 4000, "quick advice is short");
  const [instructions, frame] = sent.body.system;
  assert.match(instructions.text, /Nunca escribas texto para el manuscrito/);
  assert.match(instructions.text, /Nunca inventes una cita/);
  assert.deepEqual(frame.cache_control, { type: "ephemeral" }, "the stable frame is cached");
  assert.match(frame.text, /## Plan del autor \(sinopsis\)\nElena descubre/);
  assert.match(frame.text, /## Mapa de la novela\n- Capítulo 1 · \d+ palabras · aparecen: Elena, Juan/);
  assert.match(frame.text, /## Cabos\n- «La carta de Marta»/);
  const prompt = sent.body.messages[0].content;
  assert.ok(prompt.includes(`<capitulo-actual numero="3" titulo="Tres">\n${LIVE}\n</capitulo-actual>`), "live, unsaved text");
  assert.match(prompt, /<ficha numero="1"[^>]*>/);
  assert.match(prompt, /<ficha numero="2"[^>]*>/);
  assert.ok(prompt.indexOf('<ficha numero="1"') < prompt.indexOf('<ficha numero="2"'), "in order");
  assert.match(prompt, /<datos>\nÚltima aparición de cada personaje/);
  assert.match(prompt, /<tarea>\nAnaliza Capítulo 3: Tres/);
  assert.equal((await usageRows("advise")).length, 1);
});

test("observations: verified quotes point at the text; an invented one is an impression; a misattributed one is moved", async () => {
  const list = events((await advise({ action: "analizar" })).data);
  const [ok, invented, moved] = cardsOf(list).items;
  assert.deepEqual([ok.verified, ok.refs[0].chapterId], [true, ch[2]]);
  assert.equal(LIVE.slice(ok.refs[0].at.start, ok.refs[0].at.end), ok.refs[0].quote);
  assert.equal(invented.verified, false);
  assert.deepEqual([invented.refs[0].verified, invented.refs[0].at], [false, null]);
  assert.equal(invented.confidence, "medium", "lowered from high");
  assert.deepEqual([moved.verified, moved.refs[0].chapterId], [true, ch[2]], "found in chapter 3, not where the model said");
});

test("¿Cómo continúo?: three paths as alternatives, never the continuation itself", async () => {
  await clearAiLog();
  const list = events((await advise({ action: "seguir" })).data);
  const alternatives = cardsOf(list).items.filter((o) => o.kind === "alternative");
  assert.equal(alternatives.length, 3);
  const prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /Propón exactamente 3 caminos distintos/);
  assert.match(prompt, /No escribas la escena ni la continuación/);
  assert.match(prompt, /Cabos abiertos y capítulos sin aparecer:\n- «La carta de Marta»: última vez en el 1, hace 2 capítulos/);
});

test("Repeticiones and Cabos: computed data and anchor passages go with the request", async () => {
  await clearAiLog();
  await advise({ action: "repeticiones" });
  let prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /Repeticiones en Capítulo 3: Tres \(frases y ecos de palabras cercanas\):\n- «lámpara temblaba sobre la mesa» ×2 \(cap\. 3\)/);

  await clearAiLog();
  await advise({ action: "cabos" });
  prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /<pasajes>[\s\S]*\[Capítulo 1\]\nCABO: La carta de Marta\./, "the paragraph of the thread's anchor");
});

test("free question: the planner's reading is shown; named chapters go complete; the selection is the focus", async () => {
  await clearAiLog();
  const list = events((await advise({ question: "¿Es coherente lo que sabe Elena del mar en el capítulo 1?" })).data);
  assert.deepEqual(list[1], { type: "plan", action: "coherencia", label: "Coherencia", detail: "personajes: Elena · capítulos: 1", mode: "analizar" });
  let prompt = (await aiLog())[0].body.messages[0].content;
  assert.ok(prompt.includes(`<capitulo numero="1" titulo="Capítulo 1">\n${T1}\n</capitulo>`), prompt.slice(0, 600));
  assert.match(prompt, /Pregunta del autor: ¿Es coherente lo que sabe Elena/);
  assert.match(prompt, /Nació en Santiago/, "the character's Memory, by reference");

  await clearAiLog();
  await advise({ action: "coherencia", selection: { start: 0, end: 20 } });
  prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /<seleccion capitulo="3">\nElena recordó los ve\n<\/seleccion>/);
  assert.doesNotMatch(prompt, /<capitulo-actual/);
});

test("broken observations: the text still arrives, the cards are reported as invalid", async () => {
  const list = events((await advise({ question: "OBS-ROTAS ¿funciona el ritmo?" })).data);
  assert.ok(list.some((e) => e.type === "text" && e.text.includes("Lectura del Consejero")));
  assert.deepEqual(cardsOf(list), { type: "observations", items: [], invalid: true });
});

// ---------------------------------------------------------------- panel

test("panel: Consultar runs an action; cards show their references; Ir selects the quote", async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[2]]);
  // These are Analizar's cards and actions: the panel opens in Analizar (Conversar is the default).
  await page.addInitScript((n) => localStorage.setItem(`advisorMode:${n}`, "analizar"), novel);
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  await editor.fill(LIVE);
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  await panel.getByRole("button", { name: "Analizar capítulo" }).click();
  const cards = panel.locator(".turn.advisor .observation");
  await cards.first().waitFor({ timeout: 15_000 });
  assert.equal(await cards.count(), 3);
  assert.match(await panel.locator(".turn.advisor .markdown").innerText(), /Lectura del Consejero/);
  assert.doesNotMatch(await panel.locator(".consult").innerText(), /<observaciones>|"kind"/, "no raw JSON on screen");
  assert.match(await cards.nth(1).innerText(), /Impresión: sin cita verificable/);
  assert.match(await panel.locator(".usage-line").innerText(), /Leyó: marco/);

  await editor.evaluate((el) => el.setSelectionRange(0, 0));
  await cards.first().getByRole("button", { name: "Ir" }).click();
  const selected = await editor.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  assert.equal(selected, "Elena recordó los veranos en Cartagena");
});

test("panel: a free question shows how it was understood", async () => {
  const panel = page.locator("aside.panel");
  await panel.getByRole("textbox", { name: "Pregunta al Consejero" }).fill("¿Qué cabos dejé sin resolver?");
  await panel.getByRole("button", { name: "Preguntar" }).click();
  await page.waitForFunction(() =>
    /Entendí la pregunta como: Cabos pendientes/.test([...document.querySelectorAll(".turn.advisor .plan")].at(-1)?.textContent ?? ""),
  );
});

test("panel: an alternative of ¿Cómo continúo? goes to the Asistente as a scene's argument", async () => {
  const panel = page.locator("aside.panel");
  await panel.getByRole("button", { name: "¿Cómo continúo?" }).click();
  const alt = panel.locator(".observation.obs-alternative").first();
  await alt.waitFor({ timeout: 15_000 });
  await alt.getByRole("button", { name: "Enviar al Asistente" }).click();
  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  const argument = await page.getByPlaceholder(/Qué ocurre en la escena/).inputValue();
  // What would happen and who: not the reasons, consequences or risks.
  assert.match(argument, /^Seguir el conflicto\. Seguir el conflicto: qué podría ocurrir\./);
  assert.doesNotMatch(argument, /Riesgos|Consecuencias/);
  assert.equal(await page.locator("textarea.editor").inputValue(), LIVE, "nothing written in the manuscript");
});

test("panel: chapters without a digest are read first, then it answers", async () => {
  // A new chapter before the open one, never read.
  await fetch(`${STACK}/rest/v1/chapter_digests?chapter_id=eq.${ch[1]}`, {
    method: "DELETE",
    headers: { apikey: process.env.E2E_SERVICE_KEY, authorization: `Bearer ${process.env.E2E_SERVICE_KEY}` },
  });
  const dry = (await advise({ action: "personajes", dryRun: true })).data;
  assert.deepEqual(dry.unread.map((u) => u.id), [ch[1]], JSON.stringify(dry));
  await clearAiLog();
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  await panel.getByRole("button", { name: "Consultar" }).click();
  // The conversation reloads when Consultar mounts: count its turns once it is there.
  await panel.locator(".turn.advisor").first().waitFor();
  const turns = await panel.locator(".turn.advisor").count();
  await panel.getByRole("button", { name: "Personajes" }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".turn.advisor").length > n, turns, { timeout: 15_000 });
  // The new turn shows at once («Pensando…»); the reading and the answer come right after it.
  const t0 = Date.now();
  let log = await aiLog();
  while (log.length < 2 && Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, 100));
    log = await aiLog();
  }
  assert.equal(log.length, 2, JSON.stringify(log.map((x) => x.body.system?.[0]?.text?.slice(0, 20))));
  assert.match(log[0].body.system[0].text, /<ficha-capitulo>/, "first, the missing digest");
  assert.match(log[1].body.system[0].text, /<consejero>/, "then the answer");
  assert.match(log[1].body.messages[0].content, /<ficha numero="2"/, "with that digest");
});
