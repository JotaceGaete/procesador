// Capítulos en reserva (docs/capitulos-reserva.md), end to end. The AI never reads a chapter in
// reserve unless the author opens it and asks, and then only that one; moving chapters keeps
// their text, images and versions; the reserve is in the backup and out of the book; the list
// in the browser, on a computer (arrows, drag and drop, «Mover») and on a phone.
//
// Every chapter in reserve carries unique words (RESERVA-…), and so does what was derived from
// one: a fact tied to it, its digest, a thread only it opened, a global summary that counted it.
// Each AI route is called and the mock's log is searched for those words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, png, resetDb, textEditor } from "./helpers.mjs";

let call, cookie, novel, browser;
const s = {};
const KEY = process.env.E2E_SERVICE_KEY;

const M1 = "Elena llegó al puerto de madrugada. MANUSCRITO-UNO.\n\nCABO: La carta de Marta.";
const M2 = "Elena abrió la carta en la cocina. MANUSCRITO-DOS. Juan escuchaba detrás de la puerta.";
const R1 = "Elena se casó con Juan en la capilla del cerro. RESERVA-ALFA. Una ballena varada en la playa.";
const R2 = "Elena murió en el invierno de 1990. RESERVA-BETA. La ballena volvió al mar.";
const LEAK = /RESERVA-[A-Z]+/g;

async function rest(table, row, method = "POST", query = "") {
  const res = await fetch(`${STACK}/rest/v1/${table}${query}`, {
    method,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: row === undefined ? undefined : JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}
const rows = (table, query) => rest(table, undefined, "GET", `?${query}`);

async function save(id, content) {
  const { revision } = (await call(`/api/chapters/${id}`)).data;
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.revision;
}
const outline = async (id = novel) => (await call(`/api/novels/${id}`)).data.chapters;
const ids = (list) => list.map((c) => c.id);
const leaks = async () => [...new Set(JSON.stringify(await aiLog()).match(LEAK) ?? [])];
/** Everything derived that the Consejero keeps for the novel: it must not change while reading a chapter in reserve. */
const derived = async () => ({
  digests: (await rows("chapter_digests", `novel_id=eq.${novel}&select=chapter_id,summary,updated_at&order=chapter_id`)),
  global: await rows("novel_digests", `novel_id=eq.${novel}&select=summary,based_on,updated_at`),
  threads: await rows("story_threads", `novel_id=eq.${novel}&select=id,title,status,opened_chapter_id&order=id`),
  facts: await rows("facts", `novel_id=eq.${novel}&select=id,text,chapter_id,status&order=id`),
});

const scene = (chapterId, content, extra = {}) =>
  call("/api/assist", "POST", { novelId: novel, chapterId, content, provider: "anthropic", mode: "scene", argument: "Elena vuelve a la casa.", cursor: content.length, length: "breve", ...extra });
const edit = (chapterId, content, extra = {}) =>
  call("/api/assist", "POST", { novelId: novel, chapterId, content, provider: "anthropic", mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: 20, ...extra });
const advise = (chapterId, content, extra = {}) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId, content, provider: "anthropic", ...extra });

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  novel = (await call("/api/novels", "POST", { title: "La capilla" })).data.id;
  s.m1 = (await outline())[0].id;
  s.m2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "La cocina" })).data.id;
  const r1 = await call(`/api/novels/${novel}/chapters`, "POST", { title: "La boda", reserved: true });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  s.r1 = r1.data.id;
  s.r2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "", reserved: true })).data.id;
  s.rev = {};
  for (const [id, text] of [[s.m1, M1], [s.m2, M2], [s.r1, R1], [s.r2, R2]]) s.rev[id] = await save(id, text);

  const elena = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena" })).data;
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Juan" });
  s.elena = elena.id;
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "Elena teme al mar desde niña.", chapter_id: s.m1 });
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "Elena se casa con Juan: RESERVA-HECHO.", chapter_id: s.r1 });
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "Elena muere: RESERVA-HECHO-BETA.", chapter_id: s.r2 });
  await call(`/api/chapters/${s.r1}/time`, "PUT", { when: { date: { year: 1985 } } });

  // The manuscript, read by the Consejero.
  for (const id of [s.m1, s.m2]) assert.equal((await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic" })).status, 200);
  // What could have been left from a chapter in reserve when it was in the manuscript: a digest
  // corrected by the author (kept on purpose), a thread only it opened, a global summary that counted it.
  await rest("chapter_digests", { chapter_id: s.r1, novel_id: novel, source_revision: s.rev[s.r1], summary: "RESERVA-FICHA: la boda.", author_edited: true, events: [{ text: "RESERVA-SUCESO", characters: [s.elena], quote: "" }] });
  await rest("story_threads", { novel_id: novel, title: "RESERVA-CABO de la boda", kind: "promise", confirmed: false, opened_chapter_id: s.r1 });
  await rest("novel_digests", { novel_id: novel, summary: "RESERVA-RESUMEN: la novela termina en boda.", based_on: { [s.m1]: s.rev[s.m1], [s.r1]: s.rev[s.r1] } });
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- the two groups

test("groups: the manuscript numbered by position, the reserve after it, unnumbered", async () => {
  const list = await outline();
  assert.deepEqual(ids(list), [s.m1, s.m2, s.r1, s.r2]);
  assert.deepEqual(list.map((c) => c.reserved), [false, false, true, true]);
  assert.deepEqual(list.map((c) => c.title), ["", "La cocina", "La boda", ""], "no number stored in the title");
  assert.equal((await call(`/api/chapters/${s.r1}`)).data.reserved, true);
});

// ---------------------------------------------------------------- isolation

test("isolation: writing a scene (with the whole manuscript) never reads the reserve", async () => {
  await clearAiLog();
  const r = await scene(s.m2, M2, { includeManuscript: true });
  assert.equal(r.status, 200);
  const log = await aiLog();
  assert.ok(log.length >= 1);
  assert.ok(JSON.stringify(log).includes("MANUSCRITO-UNO"), "the manuscript does go");
  assert.deepEqual(await leaks(), []);
});

test("isolation: editing with the assistant (with the manuscript) never reads the reserve", async () => {
  await clearAiLog();
  assert.equal((await edit(s.m2, M2, { includeManuscript: true })).status, 200);
  assert.equal((await edit(s.m2, M2, { action: "personaje", characterIds: [s.elena], selectionEnd: M2.length })).status, 200);
  assert.ok((await aiLog()).length >= 2);
  assert.deepEqual(await leaks(), []);
});

test("isolation: every Consejero action, a free question and the conversation never read the reserve", async () => {
  await clearAiLog();
  for (const action of ["analizar", "seguir", "repeticiones", "cabos", "coherencia", "personajes"]) {
    const r = await advise(s.m2, M2, { action });
    assert.equal(r.status, 200, `${action}: ${r.data}`);
  }
  await advise(s.m2, M2, { question: "¿Qué sabe Elena de la boda y de la ballena?" });
  await advise(s.m2, M2, { question: "¿Cómo sigue?", mode: "conversar" });
  assert.ok((await aiLog()).length >= 8);
  assert.deepEqual(await leaks(), []);
});

test("isolation: deep reading (passages, revelations, facts, threads, whole chapters) never reaches the reserve", async () => {
  await clearAiLog();
  const want = [
    { tipo: "pasajes", buscar: "ballena boda capilla" },
    { tipo: "pasajes", personaje: "Elena" },
    { tipo: "revelaciones" },
    { tipo: "hechos", personaje: "Elena" },
    { tipo: "personaje", nombre: "Elena" },
    { tipo: "cabo", titulo: "RESERVA-CABO de la boda" },
    { tipo: "ficha", capitulo: 3 },
    { tipo: "capitulo", capitulo: 3 },
  ];
  const r = await advise(s.m2, M2, { question: `¿Dónde aparece la ballena? PEDIR: ${JSON.stringify(want)}` });
  assert.equal(r.status, 200);
  const list = events(r.data);
  assert.ok(list.some((e) => e.type === "reading"), JSON.stringify(list.map((e) => e.type)));
  // The tool request itself names RESERVA-CABO (the author's question): look only at what came back.
  const material = (await aiLog()).map((l) => JSON.stringify(l.body).replace(/RESERVA-CABO de la boda/g, ""));
  assert.equal(material.join("").match(LEAK), null);
});

test("isolation: the chapter digest and the global summary only read the manuscript", async () => {
  await clearAiLog();
  assert.equal((await call(`/api/chapters/${s.m2}/digest`, "POST", { provider: "anthropic", force: true })).status, 200);
  assert.equal((await call(`/api/novels/${novel}/digest`, "POST", { provider: "anthropic" })).status, 204);
  const summary = (await rows("novel_digests", `novel_id=eq.${novel}`))[0];
  assert.deepEqual(Object.keys(summary.based_on).sort(), [s.m1, s.m2].sort(), "built from the manuscript's digests");
  assert.doesNotMatch(summary.summary, LEAK);
  assert.deepEqual(await leaks(), []);
});

test("isolation: a chapter in reserve is never digested (not by hand, not when leaving it)", async () => {
  await clearAiLog();
  const manual = await call(`/api/chapters/${s.r2}/digest`, "POST", { provider: "anthropic" });
  assert.equal(manual.status, 409);
  const auto = await call(`/api/chapters/${s.r2}/digest`, "POST", { provider: "anthropic", auto: true });
  assert.equal(auto.status, 200);
  assert.equal(auto.data.done, false);
  assert.deepEqual(await aiLog(), []);
  assert.deepEqual(await rows("chapter_digests", `chapter_id=eq.${s.r2}`), []);
});

test("isolation: the Crítico and the comparison read only the manuscript", async () => {
  await clearAiLog();
  const c = await call(`/api/chapters/${s.m2}/critiques`, "POST", { provider: "anthropic" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const cmp = await call(`/api/novels/${novel}/compare`, "POST", {
    provider: "anthropic",
    chapterId: s.m2,
    original: "Elena abrió la carta en la cocina.",
    proposal: "Elena rasgó la carta en la cocina.",
  });
  assert.ok(cmp.status < 300, JSON.stringify(cmp.data));
  assert.ok((await aiLog()).length >= 2);
  assert.deepEqual(await leaks(), []);
});

test("isolation: the overview, the chronology and the reading panel leave the reserve out", async () => {
  const overview = await call(`/api/novels/${novel}/advisor`, "POST", { chapterId: s.m2, content: M2 });
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.data.chapters.map((c) => c.id), [s.m1, s.m2]);
  assert.equal(JSON.stringify(overview.data).match(LEAK), null);
  const chrono = await call(`/api/novels/${novel}/chronology`);
  assert.equal(chrono.status, 200);
  assert.ok(!JSON.stringify(chrono.data).includes(s.r1), "the reserve's time mark is not on the timeline");
});

// ---------------------------------------------------------------- the author opens one and asks

test("explicit analysis: with a chapter in reserve open, the AI reads it and the manuscript, never another one", async () => {
  const before = await derived();
  await clearAiLog();
  const r = await advise(s.r1, R1, { action: "analizar" });
  assert.equal(r.status, 200, r.data);
  const saved = events(r.data).find((e) => e.type === "saved");
  s.conversation = saved.conversationId;
  await edit(s.r1, R1, { includeManuscript: true });
  await scene(s.r1, R1);
  assert.equal((await call(`/api/chapters/${s.r1}/critiques`, "POST", { provider: "anthropic" })).status, 200);
  const log = JSON.stringify(await aiLog());
  assert.ok(log.includes("RESERVA-ALFA"), "the open chapter goes");
  assert.ok(log.includes("Capítulo en reserva"), "labelled as such");
  assert.ok(log.includes("MANUSCRITO-UNO"), "the manuscript goes");
  assert.ok(!log.includes("RESERVA-BETA"), "never another chapter in reserve");
  assert.ok(!log.includes("RESERVA-HECHO-BETA"));
  // Nothing of the novel's reading changed: the analysis wrote to no memory.
  assert.deepEqual(await derived(), before);
});

test("explicit analysis: its conversation can't be continued from the manuscript (nor briefed)", async () => {
  await clearAiLog();
  const r = await advise(s.m2, M2, { question: "¿Y ahora?", conversationId: s.conversation });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  const brief = await call("/api/advisor", "POST", { novelId: novel, chapterId: s.m2, brief: true, conversationId: s.conversation, provider: "anthropic" });
  assert.equal(brief.status, 409);
  assert.deepEqual(await aiLog(), []);
  // From the chapter it was about, it goes on.
  assert.equal((await advise(s.r1, R1, { question: "¿Y ahora?", conversationId: s.conversation })).status, 200);
});

// ---------------------------------------------------------------- moving between groups

test("incorporate: into the manuscript at a chosen place; renumbered; text, images, versions and notes kept", async () => {
  // An image in the chapter in reserve, and a version of it.
  s.img = crypto.randomUUID();
  await save(s.r1, `${R1}\n\n[[imagen:${s.img}]]`);
  const start = await call(`/api/novels/${novel}/assets`, "POST", { file_name: "f", type: "image/png", bytes: png(80, 60).length });
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: png(80, 60) });
  const form = new FormData();
  form.append("display", new Blob([png(64, 48)]));
  form.append("thumb", new Blob([png(32, 24)]));
  form.append("use", JSON.stringify({ kind: "manuscript", id: s.img, alt: "La capilla" }));
  const done = await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(done.status, 201);
  assert.equal((await call(`/api/chapters/${s.r1}/versions`, "POST", { reason: "manual", label: "Antes de incorporarla" })).status, 201);
  const versionsBefore = (await call(`/api/chapters/${s.r1}/versions`)).data;
  const before = (await call(`/api/chapters/${s.r1}`)).data;

  const r = await call(`/api/chapters/${s.r1}/move`, "POST", { reserved: false, at: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(ids(r.data), [s.m1, s.r1, s.m2, s.r2]);
  assert.deepEqual(r.data.map((c) => c.reserved), [false, false, false, true]);
  const after = (await call(`/api/chapters/${s.r1}`)).data;
  assert.equal(after.content, before.content);
  assert.equal(after.title, "La boda");
  assert.equal(after.reserved, false);
  assert.equal((await call(`/api/novels/${novel}`)).data.manuscriptImages.find((i) => i.id === s.img).chapter_id, s.r1);
  assert.deepEqual((await call(`/api/chapters/${s.r1}/versions`)).data, versionsBefore);

  // Now it is chapter 2, for the AI too.
  await clearAiLog();
  await advise(s.m2, M2, { action: "analizar" });
  const log = JSON.stringify(await aiLog());
  assert.ok(log.includes("RESERVA-ALFA"));
  assert.ok(!log.includes("RESERVA-BETA"));
  assert.match(log, /<capitulo-actual numero=\\"3\\"/, "the open chapter moved from 2 to 3");
});

test("to the reserve: it leaves the AI's reading at once, and what was derived from it is invalidated", async () => {
  // The manuscript is read again (M1, R1 — now chapter 2 —, M2) and summarised.
  for (const id of [s.m1, s.r1, s.m2]) await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic", force: true });
  await call(`/api/novels/${novel}/digest`, "POST", { provider: "anthropic" });
  await rest("chapter_digests", { author_edited: false }, "PATCH", `?chapter_id=eq.${s.r1}`);
  assert.equal((await rows("chapter_digests", `novel_id=eq.${novel}`)).length, 3);

  const r = await call(`/api/chapters/${s.r1}/move`, "POST", { reserved: true, at: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.data), [s.m1, s.m2, s.r1, s.r2]);
  const digests = (await rows("chapter_digests", `novel_id=eq.${novel}&select=chapter_id`)).map((d) => d.chapter_id);
  assert.deepEqual(digests, [s.m1], "its digest and the next chapter's (which continued it) are gone");
  assert.deepEqual(await rows("novel_digests", `novel_id=eq.${novel}`), [], "the global summary that counted it is gone");
  assert.deepEqual(await rows("story_threads", `novel_id=eq.${novel}&title=like.RESERVA*`), [], "the unconfirmed thread only it opened");
  // The memory the author wrote stays; it just doesn't travel.
  assert.equal((await rows("facts", `novel_id=eq.${novel}&chapter_id=eq.${s.r1}`)).length, 1);

  await clearAiLog();
  await advise(s.m2, M2, { action: "analizar" });
  await scene(s.m2, M2, { includeManuscript: true });
  assert.deepEqual(await leaks(), []);
});

test("reorder inside a group and insert anywhere; positions stay 1…n in each group", async () => {
  const up = await call(`/api/chapters/${s.r2}/move`, "POST", { at: 1 });
  assert.deepEqual(ids(up.data), [s.m1, s.m2, s.r2, s.r1], "the reserve reordered, the manuscript untouched");
  const ins = await call(`/api/novels/${novel}/chapters`, "POST", { title: "Entre medio", at: 2 });
  assert.equal(ins.status, 201);
  s.mid = ins.data.id;
  assert.deepEqual(ids(ins.data.chapters), [s.m1, s.mid, s.m2, s.r2, s.r1]);
  const pos = await rows("chapters", `novel_id=eq.${novel}&select=id,position,reserved&order=reserved,position`);
  assert.deepEqual(pos.map((p) => [p.reserved, p.position]), [[false, 1], [false, 2], [false, 3], [true, 1], [true, 2]]);
  assert.equal((await call(`/api/chapters/${s.m2}/move`, "POST", { at: 0 })).status, 400);
  assert.equal((await call(`/api/chapters/${s.m2}/move`, "POST", { at: "x" })).status, 400);
});

test("the manuscript keeps at least one chapter", async () => {
  const other = (await call("/api/novels", "POST", { title: "Sola" })).data.id;
  const only = (await outline(other))[0].id;
  const r = await call(`/api/chapters/${only}/move`, "POST", { reserved: true });
  assert.ok(r.status >= 400, JSON.stringify(r.data));
  assert.equal((await outline(other))[0].reserved, false);
});

test("concurrent moves: no duplicated or lost position", async () => {
  await Promise.all([
    call(`/api/chapters/${s.m1}/move`, "POST", { reserved: true, at: 1 }),
    call(`/api/chapters/${s.r1}/move`, "POST", { reserved: false, at: 1 }),
    call(`/api/chapters/${s.r2}/move`, "POST", { reserved: false, at: 2 }),
    call(`/api/novels/${novel}/chapters`, "POST", { title: "Concurrente", reserved: true, at: 1 }),
  ]);
  const pos = await rows("chapters", `novel_id=eq.${novel}&select=id,position,reserved&order=reserved,position`);
  assert.equal(pos.length, 6);
  for (const group of [false, true]) {
    const p = pos.filter((x) => x.reserved === group).map((x) => x.position);
    assert.deepEqual(p, p.map((_, i) => i + 1), `group ${group}: ${JSON.stringify(pos)}`);
  }
});

// ---------------------------------------------------------------- backup and export

test("backup keeps the reserve, marked; the book's data excludes nothing the author wrote", async () => {
  const b = await call(`/api/novels/${novel}/backup`);
  assert.equal(b.status, 200);
  const reserved = b.data.chapters.filter((c) => c.reserved);
  assert.ok(reserved.length >= 1);
  assert.ok(b.data.chapters.findIndex((c) => c.reserved) > b.data.chapters.findLastIndex((c) => !c.reserved), "the reserve after the manuscript");
});

// ---------------------------------------------------------------- the list in the browser

async function freshNovel(title) {
  const id = (await call("/api/novels", "POST", { title })).data.id;
  const first = (await outline(id))[0].id;
  await call(`/api/chapters/${first}`, "PATCH", { title: "Uno" });
  for (const t of ["Dos", "Tres"]) await call(`/api/novels/${id}/chapters`, "POST", { title: t });
  await call(`/api/novels/${id}/chapters`, "POST", { title: "Guardado", reserved: true });
  return id;
}
const names = (page, group) =>
  page.locator(`section[aria-label="${group}"] .chapter-name`).evaluateAll((els) => els.map((e) => e.firstChild.textContent));
/** «Mover» fills its list when it is about to open: focus it, then choose. */
async function pick(select, value) {
  await select.focus();
  await select.selectOption(value);
}
const titles = async (id) => (await outline(id)).map((c) => `${c.reserved ? "R" : "M"}:${c.title}`);

test("computer: two sections; arrows, drag and drop and «Mover» reorder and move; it all persists", async () => {
  const id = await freshNovel("Escritorio");
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${id}`);
  await page.locator("textarea.editor").waitFor();
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();

  assert.deepEqual(await names(page, "Manuscrito"), ["Capítulo 1: Uno", "Capítulo 2: Dos", "Capítulo 3: Tres"]);
  assert.deepEqual(await names(page, "Capítulos en reserva"), ["Guardado"]);

  // Arrows.
  await page.locator('section[aria-label="Manuscrito"] li').nth(0).getByRole("button", { name: "Bajar" }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="Manuscrito"] .chapter-name')?.textContent.startsWith("Capítulo 1: Dos"));
  assert.deepEqual(await titles(id), ["M:Dos", "M:Uno", "M:Tres", "R:Guardado"]);

  // Drag the chapter in reserve to the top of the manuscript.
  const target = page.locator('section[aria-label="Manuscrito"] li').nth(0);
  await page.locator('section[aria-label="Capítulos en reserva"] li').nth(0).dragTo(target, { targetPosition: { x: 20, y: 3 } });
  await page.waitForFunction(() => document.querySelector('section[aria-label="Manuscrito"] .chapter-name')?.textContent.startsWith("Capítulo 1: Guardado"));
  assert.deepEqual(await titles(id), ["M:Guardado", "M:Dos", "M:Uno", "M:Tres"]);

  // «Mover»: to the reserve (after a confirmation), and a new chapter inserted after another.
  await pick(page.locator('section[aria-label="Manuscrito"] li').nth(3).getByLabel("Mover"), "reserve");
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Capítulos en reserva"] li').length === 1);
  await pick(page.locator('section[aria-label="Manuscrito"] li').nth(0).getByLabel("Mover"), "insert");
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Manuscrito"] li').length === 4);
  assert.deepEqual(await titles(id), ["M:Guardado", "M:", "M:Dos", "M:Uno", "R:Tres"]);
  assert.match(await page.locator(".chapter-title").innerText(), /Capítulo 2/, "the new chapter is open");

  // After a reload, the same.
  await page.reload();
  await page.locator("textarea.editor").waitFor();
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  assert.deepEqual(await names(page, "Manuscrito"), ["Capítulo 1: Guardado", "Capítulo 2", "Capítulo 3: Dos", "Capítulo 4: Uno"]);
  assert.deepEqual(await names(page, "Capítulos en reserva"), ["Tres"]);
  await ctx.close();
});

test("iPhone (emulated): no dragging; «Llevar al manuscrito» with the system picker; readable without zoom or sideways scroll", async () => {
  const id = await freshNovel("Teléfono");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${id}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".chapter-title").tap();
  await page.locator("nav.chapters").waitFor();

  const row = page.locator('section[aria-label="Capítulos en reserva"] li').nth(0);
  assert.equal(await row.getAttribute("draggable"), "false");
  const select = row.getByLabel("Llevar al manuscrito");
  assert.equal(await select.evaluate((e) => getComputedStyle(e).fontSize), "16px", "iOS doesn't zoom into it");
  await pick(select, "2");
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Manuscrito"] li').length === 4);
  assert.deepEqual(await titles(id), ["M:Uno", "M:Guardado", "M:Dos", "M:Tres"]);
  await page.locator('section[aria-label="Manuscrito"] li').nth(1).getByRole("button", { name: "Subir" }).tap();
  await page.waitForFunction(() => document.querySelector('section[aria-label="Manuscrito"] .chapter-name')?.textContent.startsWith("Capítulo 1: Guardado"));
  await pick(page.locator('section[aria-label="Manuscrito"] li').nth(0).getByLabel("Mover"), "reserve");
  await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Capítulos en reserva"] li').length === 1);
  assert.deepEqual(await titles(id), ["M:Uno", "M:Dos", "M:Tres", "R:Guardado"]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll");
  await ctx.close();
});
