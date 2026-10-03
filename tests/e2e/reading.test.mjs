// Consejero, phase 2 (docs/consejero.md): chapter digests, threads and the global
// summary. API end to end with the mock AI (which builds its JSON from the request,
// with real quotes), then the "Cabos y lecturas" view in the browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, login, resetDb } from "./helpers.mjs";

let call, novel, other, ch, elena, juan, browser, page;
const s = {};

// Several paragraphs: a retouch of one of them is not a substantial change.
const FILLER = Array.from({ length: 6 }, (_, i) => `La casa seguía igual en la mañana número ${i}.`).join("\n\n");
const TEXT1 = `Elena encontró la carta en el cajón de su madre.\n\nCABO: La carta de Marta.\n\nJuan no sabía nada.\n\n${FILLER}`;
const TEXT2 = "Juan llegó tarde al puerto. CITA-INVENTADA. CIERRA: La carta de Marta. Elena lo esperaba.";
const TEXT3 = "Llovía sobre la casa vieja. JSON-ROTO. Nadie habló en toda la cena.";

const reading = async (id = novel) => (await call(`/api/novels/${id}/reading`)).data;
const chapterOf = async (id) => (await reading()).chapters.find((c) => c.id === id);
const digest = (id, extra = {}) => call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic", ...extra });
const save = async (id, content) => {
  const { revision } = (await call(`/api/chapters/${id}`)).data;
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  assert.equal(r.status, 200);
};
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  return res.json();
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "La carta" })).data.id;
  other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (const title of ["Dos", "Tres"]) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title })).data.id);
  for (const [i, t] of [TEXT1, TEXT2, TEXT3].entries()) await save(ch[i], t);
  elena = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", description: "Pelirroja y testaruda" })).data.id;
  juan = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Juan" })).data.id;
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- state without AI

test("reading: every chapter starts unread, with what reading it would cost; no AI involved", async () => {
  await clearAiLog();
  const r = await reading();
  assert.deepEqual(r.chapters.map((c) => c.status), ["missing", "missing", "missing"]);
  assert.ok(r.chapters.every((c) => c.estimate > 0 && c.digest === null));
  assert.equal(r.auto, true);
  assert.equal(r.novel, null);
  assert.deepEqual(r.threads, []);
  assert.equal((await aiLog()).length, 0);
});

// ---------------------------------------------------------------- chapter digest

test("digest: the cheap model reads the chapter; quotes are real and located; a possible thread appears", async () => {
  await clearAiLog();
  const r = await digest(ch[0]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { done: true, status: "current", unverified: 0 });

  const [sent] = await aiLog();
  assert.equal(sent.body.model, "claude-lector-e2e", "the analysis model, not the writing one");
  const prompt = sent.body.messages[0].content;
  assert.ok(prompt.includes(`[${elena}] Elena`), "characters by id");
  assert.ok(!prompt.includes("Pelirroja"), "never a copy of the Memory");

  const c = await chapterOf(ch[0]);
  assert.equal(c.status, "current");
  const e = c.digest.events[0];
  assert.equal(e.quote, "Elena encontró la carta en el cajón de");
  assert.equal(TEXT1.slice(e.at.start, e.at.end), e.quote);
  assert.deepEqual(new Set(e.characters), new Set([elena, juan]));
  assert.deepEqual(c.digest.presence.map((p) => p.kind), ["present", "present"]);

  const [thread] = (await reading()).threads;
  assert.equal(thread.title, "La carta de Marta");
  assert.equal(thread.confirmed, false, "a possible thread until the author confirms it");
  assert.equal(thread.origin, "advisor");
  assert.equal(thread.opened_chapter_id, ch[0]);
  assert.equal(c.digest.threads[0].thread, thread.id);
  s.thread = thread.id;

  const usage = await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.digest`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, "claude-lector-e2e");
});

test("digest: an invented quote is never stored as a quote; a later chapter closes the thread", async () => {
  const r = await digest(ch[1]);
  assert.equal(r.data.unverified, 1);
  const c = await chapterOf(ch[1]);
  const dubious = c.digest.events.find((e) => e.text === "Algo dudoso");
  assert.equal(dubious.quote, "");
  assert.equal(dubious.at, null);
  const t = (await reading()).threads.find((x) => x.id === s.thread);
  assert.deepEqual([t.status, t.closed_chapter_id, t.last_chapter_id], ["closed", ch[1], ch[1]]);
});

test("structured output: an invalid answer is retried once; twice invalid stores nothing", async () => {
  await clearAiLog();
  assert.equal((await digest(ch[2])).status, 200);
  const log = await aiLog();
  assert.equal(log.length, 2);
  assert.match(log[1].body.messages[0].content, /Tu respuesta anterior no era válida/);
  assert.equal((await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.digest`)).length, 4, "both attempts logged");

  await save(ch[2], "JSON-SIEMPRE-ROTO. Otra cosa distinta en este capítulo.");
  const bad = await digest(ch[2]);
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /No se guardó nada/);
  const c = await chapterOf(ch[2]);
  assert.ok(c.digest.summary.includes("Llovía"), "the previous digest is kept");
  assert.equal(c.status, "stale");
  await save(ch[2], TEXT3);
});

// ---------------------------------------------------------------- freshness and threads

test("freshness: a retouch keeps the digest; a rewrite makes it stale; re-reading reopens the thread", async () => {
  await save(ch[0], TEXT1.replace("número 3.", "número tres."));
  const touched = await chapterOf(ch[0]);
  assert.equal(touched.status, "touched");

  await save(ch[1], "Juan llegó tarde al puerto.\n\nElena ya no lo esperaba. Nadie habló de cartas.");
  assert.equal((await chapterOf(ch[1])).status, "stale");
  assert.equal((await digest(ch[1])).status, 200);
  const t = (await reading()).threads.find((x) => x.id === s.thread);
  assert.deepEqual([t.status, t.closed_chapter_id, t.last_chapter_id], ["open", null, ch[0]], "no chapter closes it now");
});

test("automatic reading: only on a substantial change, never over the author's corrections, and it can be turned off", async () => {
  await clearAiLog();
  assert.deepEqual((await digest(ch[0], { auto: true })).data, { done: false, reason: "sin cambios sustanciales" });
  const short = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Cuatro" })).data.id;
  await save(short, "Unas pocas palabras.");
  assert.deepEqual((await digest(short, { auto: true })).data, { done: false, reason: "capítulo breve" });
  await call(`/api/chapters/${short}`, "DELETE");

  await save(ch[2], Array.from({ length: 40 }, (_, i) => `Párrafo ${i} reescrito por completo con varias palabras.`).join("\n\n"));
  await call(`/api/novels/${novel}`, "PATCH", { auto_digest: false });
  assert.deepEqual((await digest(ch[2], { auto: true })).data, { done: false, reason: "automatización desactivada" });
  await call(`/api/novels/${novel}`, "PATCH", { auto_digest: true });
  assert.equal((await aiLog()).length, 0, "none of these reached the AI");
  assert.equal((await digest(ch[2], { auto: true })).data.done, true);
  assert.equal((await aiLog()).length, 1);
});

test("author's corrections prevail: kept from automatic re-reading, replaced only when asked", async () => {
  assert.equal((await call(`/api/chapters/${ch[2]}/digest`, "PATCH", { summary: "Mi propio resumen del capítulo." })).status, 204);
  let c = await chapterOf(ch[2]);
  assert.equal(c.digest.summary, "Mi propio resumen del capítulo.");
  assert.equal(c.digest.author_edited, true);
  assert.equal((await digest(ch[2])).status, 409, "asks before replacing it");

  await save(ch[2], TEXT3);
  assert.deepEqual((await digest(ch[2], { auto: true })).data, { done: false, reason: "ficha corregida por el autor" });
  assert.equal((await digest(ch[2], { force: true })).status, 200);
  c = await chapterOf(ch[2]);
  assert.equal(c.digest.author_edited, false);
  assert.equal((await call(`/api/chapters/${ch[2]}/digest`, "PATCH", { summary: " " })).status, 400);
});

test("threads: confirm, rename, author's status stays, merge moves references, delete removes them", async () => {
  let t = (await call(`/api/threads/${s.thread}`, "PATCH", { confirmed: true })).data;
  assert.equal(t.confirmed, true);
  t = (await call(`/api/threads/${s.thread}`, "PATCH", { title: "La carta" })).data;
  assert.equal(t.title, "La carta");
  t = (await call(`/api/threads/${s.thread}`, "PATCH", { status: "abandoned" })).data;
  assert.deepEqual([t.status, t.status_by], ["abandoned", "author"]);
  await digest(ch[0]); // re-reading doesn't change what the author decided
  assert.equal((await reading()).threads.find((x) => x.id === s.thread).status, "abandoned");
  t = (await call(`/api/threads/${s.thread}`, "PATCH", { status: null })).data;
  assert.deepEqual([t.status, t.status_by], ["open", "advisor"], "back to what the reading says");

  const mine = (await call(`/api/novels/${novel}/threads`, "POST", { title: "Secreto de familia", kind: "mystery" })).data;
  assert.deepEqual([mine.origin, mine.confirmed, mine.opened_chapter_id], ["author", true, null]);
  assert.equal((await call(`/api/novels/${novel}/threads`, "POST", { title: " " })).status, 400);
  assert.equal((await call(`/api/threads/${mine.id}`, "PATCH", { kind: "nope" })).status, 400);

  const merged = (await call(`/api/threads/${s.thread}/merge`, "POST", { into: mine.id })).data;
  assert.equal(merged.opened_chapter_id, ch[0], "it now has the merged thread's chapters");
  const c = await chapterOf(ch[0]);
  assert.deepEqual(c.digest.threads.map((x) => x.thread), [mine.id]);
  assert.ok(!(await reading()).threads.some((x) => x.id === s.thread));

  const foreign = (await call(`/api/novels/${other}/threads`, "POST", { title: "Ajeno" })).data;
  assert.equal((await call(`/api/threads/${mine.id}/merge`, "POST", { into: foreign.id })).status, 404, "never across novels");

  assert.equal((await call(`/api/threads/${mine.id}`, "DELETE")).status, 204);
  assert.deepEqual((await chapterOf(ch[0])).digest.threads, []);
  s.thread = null;
});

// ---------------------------------------------------------------- global summary

test("global summary: made from the digests, stale when one changes", async () => {
  await clearAiLog();
  assert.equal((await call(`/api/novels/${novel}/digest`, "POST", { provider: "anthropic" })).status, 204);
  const [sent] = await aiLog();
  assert.equal(sent.body.model, "claude-lector-e2e");
  assert.equal((sent.body.messages[0].content.match(/<ficha /g) ?? []).length, 3);
  assert.ok(!sent.body.messages[0].content.includes("<capitulo"), "not the text: the digests");
  let r = await reading();
  assert.equal(r.novel.status, "current");
  assert.match(r.novel.summary, /3 fichas/);

  await digest(ch[1]);
  r = await reading();
  assert.equal(r.novel.status, "stale");
  assert.equal((await call(`/api/novels/${other}/digest`, "POST", { provider: "anthropic" })).status, 400, "nothing read yet");
});

// ---------------------------------------------------------------- copy and delete

test("duplicate: digests, threads and summary copied with their own ids; still current", async () => {
  await save(ch[0], `${TEXT1}\n\nCABO: El viaje.`);
  await digest(ch[0]);
  await call(`/api/novels/${novel}/digest`, "POST", { provider: "anthropic" });
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", {})).data.id;
  const r = await reading(copy);
  assert.deepEqual(r.chapters.map((c) => c.status), ["current", "current", "current"]);
  assert.equal(r.novel.status, "current");
  const copied = r.threads.find((t) => t.title === "El viaje");
  assert.ok(copied);
  const orig = (await reading()).threads.find((t) => t.title === "El viaje");
  assert.notEqual(copied.id, orig.id);
  const first = r.chapters[0];
  const refs = first.digest.threads.map((t) => t.thread);
  assert.ok(refs.includes(copied.id), "references point to the copy's thread");
  assert.ok(refs.every((id) => r.threads.some((t) => t.id === id)), "and only to the copy's threads");
  assert.equal(copied.opened_chapter_id, first.id);
  const people = (await call(`/api/novels/${copy}`)).data.memory.characters.map((c) => c.id);
  assert.ok(first.digest.presence.every((p) => people.includes(p.character)), "characters of the copy");
  assert.equal((await rows("ai_usage", `novel_id=eq.${copy}`)).length, 0);
  await call(`/api/novels/${copy}`, "DELETE");
});

test("deleting a chapter deletes its digest; isolation between novels", async () => {
  const extra = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Borrable" })).data.id;
  await save(extra, "Marta habló con Elena en la estación durante horas.");
  await digest(extra);
  assert.equal((await rows("chapter_digests", `chapter_id=eq.${extra}`)).length, 1);
  await call(`/api/chapters/${extra}`, "DELETE");
  assert.equal((await rows("chapter_digests", `chapter_id=eq.${extra}`)).length, 0);
  assert.equal((await reading(other)).chapters.every((c) => c.digest === null), true);
});

// ---------------------------------------------------------------- panel

test("panel: Cabos y lecturas shows each chapter's state, reads what's pending, Ir goes to a quote", async () => {
  // Start over from unread chapters, with a thread to find.
  for (const id of ch) await fetch(`${STACK}/rest/v1/chapter_digests?chapter_id=eq.${id}`, {
    method: "DELETE",
    headers: { apikey: process.env.E2E_SERVICE_KEY, authorization: `Bearer ${process.env.E2E_SERVICE_KEY}` },
  });
  await save(ch[0], TEXT1);
  await save(ch[1], TEXT2);

  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  await page.getByRole("button", { name: "Cabos y lecturas" }).click();
  const view = page.locator(".advisor-reading");
  await view.locator(".digests > li").first().waitFor();
  assert.match(await view.locator(".reading-head").innerText(), /0 de 3/);
  assert.equal(await view.locator(".state-badge.missing").count(), 3);

  await clearAiLog();
  await view.getByRole("button", { name: /Actualizar la lectura \(3 cap\.\)/ }).click();
  await page.waitForFunction(() => /3 de 3 capítulos/.test(document.querySelector(".reading-head")?.textContent ?? ""), null, {
    timeout: 20_000,
  });
  const log = await aiLog();
  assert.equal(
    log.length,
    5,
    `three chapters (one retried), then the global summary: ${await view.locator(".reading-head").innerText()} ${JSON.stringify(log.map((x) => x.body.messages[0].content.slice(-200)))}`,
  );
  const thread = view.locator(".threads > li", { hasText: "La carta de Marta" });
  assert.match(await thread.innerText(), /posible cabo/);
  await thread.getByRole("button", { name: "Confirmar" }).click();
  await page.waitForFunction(() => !document.querySelector(".threads .possible"));

  // Ir from a quote in the second chapter's digest opens it and selects the quote.
  const second = view.locator(".digests > li").nth(1);
  await second.locator("summary", { hasText: "Ficha" }).click();
  assert.match(await second.innerText(), /sin cita verificable/, "the invented quote is shown as such");
  await second.locator("li", { hasText: "«Juan llegó tarde al puerto»" }).getByRole("button", { name: "Ir" }).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector("textarea.editor");
      return el && el.value.slice(el.selectionStart, el.selectionEnd) === "Juan llegó tarde al puerto";
    },
    null,
    { timeout: 15_000 },
  );
});

test("panel: leaving a chapter after rewriting it re-reads it in the background", async () => {
  // We are on the second chapter (Ir took us there).
  await clearAiLog();
  const editor = page.locator("textarea.editor");
  await editor.fill(Array.from({ length: 30 }, (_, i) => `Elena reescribe el párrafo ${i} con palabras nuevas.`).join("\n\n"));
  await page.locator(".topbar .chapter-title").click();
  await page.locator(".chapter-name", { hasText: "Tres" }).click();
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value.startsWith("Llovía"));
  const end = Date.now() + 15_000;
  while (Date.now() < end && !(await aiLog()).length) await new Promise((r) => setTimeout(r, 200));
  const log = await aiLog();
  assert.equal(log.length, 1);
  assert.match(log[0].body.messages[0].content, /Elena reescribe el párrafo 0/);
  assert.equal(log[0].body.model, "claude-lector-e2e");

  // A small edit, then leaving: no AI.
  await clearAiLog();
  await editor.press("End");
  await page.keyboard.type(" Fin.");
  await page.locator(".chapter-name", { hasText: "Dos" }).click();
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value.startsWith("Elena reescribe"));
  await page.waitForTimeout(1500);
  assert.equal((await aiLog()).length, 0);
});
