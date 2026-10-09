// Bloqueo + reserva juntos (docs/integracion-bloqueo-reserva.md), end to end. A chapter can be
// locked and in reserve at once: the lock protects its text and title wherever it is, never its
// place; the reserve keeps it out of what the AI reads unless the author opens it; and a lock
// never stops the AI from reading a chapter, only from changing it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, browser;
const s = {};

const M1 = "Elena llegó al puerto. MANUSCRITO-UNO.";
const M2 = "Elena abrió la carta. CANDADO-MANUSCRITO. Juan escuchaba.";
const R1 = "Elena se casó en la capilla. CANDADO-RESERVA. Una ballena.";
const R2 = "Elena murió en invierno. RESERVA-SUELTA.";

const chapter = async (id) => (await call(`/api/chapters/${id}`)).data;
const outline = async () => (await call(`/api/novels/${novel}`)).data.chapters;
const flags = async () => (await outline()).map((c) => `${c.title}|${c.reserved ? "R" : "M"}${c.locked ? "🔒" : ""}`);
const lock = (id, locked = true) => call(`/api/chapters/${id}`, "PATCH", { locked });
const move = (id, body) => call(`/api/chapters/${id}/move`, "POST", body);
const log = async () => JSON.stringify(await aiLog());
const advise = (chapterId, content, extra = {}) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId, content, provider: "anthropic", ...extra });
const edit = (chapterId, content, extra = {}) =>
  call("/api/assist", "POST", { novelId: novel, chapterId, content, provider: "anthropic", mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: 20, ...extra });
async function save(id, content) {
  const { revision } = await chapter(id);
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
/** What must never change on a locked chapter, whatever happens to it. */
const sealed = async (id) => {
  const c = await chapter(id);
  return `${c.title}|${c.content}|${c.revision}`;
};

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Candado y reserva" })).data.id;
  s.m1 = (await outline())[0].id;
  await call(`/api/chapters/${s.m1}`, "PATCH", { title: "Puerto" });
  s.m2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Carta" })).data.id;
  s.r1 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Boda", reserved: true })).data.id;
  s.r2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Invierno", reserved: true })).data.id;
  for (const [id, text] of [[s.m1, M1], [s.m2, M2], [s.r1, R1], [s.r2, R2]]) await save(id, text);
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

test("the outline carries both: locked and reserved, for every chapter", async () => {
  assert.equal((await lock(s.m2)).status, 200);
  assert.equal((await lock(s.r1)).status, 200);
  assert.deepEqual(await flags(), ["Puerto|M", "Carta|M🔒", "Boda|R🔒", "Invierno|R"]);
  const c = await chapter(s.r1);
  assert.equal(c.locked, true);
  assert.equal(c.reserved, true);
});

test("a locked chapter changes place and group; its text, title and revision never change", async () => {
  const before = await sealed(s.m2);
  let r = await move(s.m2, { at: 1 }); // up, inside the manuscript
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.map((c) => c.id).slice(0, 2), [s.m2, s.m1]);
  r = await move(s.m2, { reserved: true, at: null }); // to the reserve
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(await flags(), ["Puerto|M", "Boda|R🔒", "Invierno|R", "Carta|R🔒"]);
  r = await move(s.m2, { reserved: false, at: 2 }); // back, after Puerto
  assert.equal(r.status, 200);
  assert.deepEqual(await flags(), ["Puerto|M", "Carta|M🔒", "Boda|R🔒", "Invierno|R"]);
  assert.equal(await sealed(s.m2), before);
  r = await move(s.r1, { at: 2 }); // inside the reserve, locked too
  assert.equal(r.status, 200);
  assert.deepEqual(await flags(), ["Puerto|M", "Carta|M🔒", "Invierno|R", "Boda|R🔒"]);
});

test("in the reserve, the lock still refuses text, title and the trash (423)", async () => {
  const before = await sealed(s.r1);
  const { revision } = await chapter(s.r1);
  for (const body of [{ content: "Otro texto", revision }, { title: "Otro título" }]) {
    const r = await call(`/api/chapters/${s.r1}`, "PATCH", body);
    assert.equal(r.status, 423, JSON.stringify(body));
  }
  assert.equal((await call(`/api/chapters/${s.r1}`, "DELETE")).status, 423);
  assert.equal((await call(`/api/chapters/${s.r1}/versions`, "POST", { reason: "ai" })).status, 423, "no copy before an AI change either");
  assert.equal(await sealed(s.r1), before);
});

test("the AI reads a locked chapter of the manuscript; a locked chapter in reserve only when it is the open one", async () => {
  // From the first chapter, with the whole manuscript: the locked one after it goes too.
  await clearAiLog();
  assert.equal((await edit(s.m1, M1, { includeManuscript: true })).status, 200);
  let l = await log();
  assert.ok(l.includes("CANDADO-MANUSCRITO"), "locked, in the manuscript: read");
  assert.ok(!l.includes("CANDADO-RESERVA"), "locked, in reserve, not open: never read");
  assert.ok(!l.includes("RESERVA-SUELTA"));

  // Open and analysed (the Consejero, the Asistente and the Crítico): read, and never changed.
  const before = await sealed(s.r1);
  await clearAiLog();
  assert.equal((await advise(s.r1, R1, { action: "analizar" })).status, 200);
  assert.equal((await edit(s.r1, R1, { includeManuscript: true })).status, 200, "a proposal is prepared; applying it is what the lock refuses");
  assert.equal((await call(`/api/chapters/${s.r1}/critiques`, "POST", { provider: "anthropic" })).status, 200);
  l = await log();
  assert.ok(l.includes("CANDADO-RESERVA"), "the open chapter goes");
  assert.ok(l.includes("CANDADO-MANUSCRITO"), "and the manuscript");
  assert.ok(!l.includes("RESERVA-SUELTA"), "never another chapter in reserve");
  assert.equal(await sealed(s.r1), before, "analysing never changes a locked chapter");

  // The Consejero reads a locked chapter of the manuscript for the novel's memory too.
  const d = await call(`/api/chapters/${s.m2}/digest`, "POST", { provider: "anthropic", force: true });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  // A chapter in reserve is never digested, locked or not.
  assert.equal((await call(`/api/chapters/${s.r1}/digest`, "POST", { provider: "anthropic" })).status, 409);
});

test("a locked chapter's conversation in the reserve doesn't travel to the manuscript", async () => {
  const r = await advise(s.r1, R1, { action: "analizar" });
  const id = events(r.data).find((e) => e.type === "saved").conversationId;
  await clearAiLog();
  assert.equal((await advise(s.m1, M1, { question: "¿Y ahora?", conversationId: id })).status, 409);
  assert.deepEqual(await aiLog(), []);
});

test("unlock, trash and restore from the reserve: back in the reserve, unlocked, same text", async () => {
  assert.equal((await lock(s.r1, false)).status, 200);
  assert.equal((await call(`/api/chapters/${s.r1}`, "DELETE")).status, 204);
  const r = await call(`/api/novels/${novel}/trash`, "POST", { sourceId: s.r1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const back = (await outline()).find((c) => c.title === "Boda");
  assert.equal(back.reserved, true);
  assert.equal(back.locked, false);
  assert.equal((await chapter(back.id)).content, R1);
  s.r1 = back.id;
});

test("duplicating the novel keeps each group; the copy starts unlocked", async () => {
  const r = await call(`/api/novels/${novel}/duplicate`, "POST");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const copy = (await call(`/api/novels/${r.data.id}`)).data.chapters;
  assert.deepEqual(copy.map((c) => `${c.title}|${c.reserved ? "R" : "M"}${c.locked ? "🔒" : ""}`), ["Puerto|M", "Carta|M", "Invierno|R", "Boda|R"]);
});

test("iPhone (emulated): a locked chapter shows its lock, moves with «Mover» to the reserve and back, stays read-only, no zoom", async () => {
  // Carta (locked) is chapter 2 of the manuscript; open it.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await textEditor(ctx);
  await ctx.addInitScript((v) => localStorage.setItem(`chapter:${v.novel}`, v.id), { novel, id: s.m2 });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  try {
    await page.goto(`${BASE}/novela/${novel}`);
    const editor = page.locator("textarea.editor");
    await editor.waitFor();
    await page.locator(".topbar .lock-toggle.on").waitFor();
    assert.equal(await editor.evaluate((el) => el.readOnly), true);

    await page.locator(".chapter-title").tap();
    const nav = page.locator("nav.chapters");
    await nav.waitFor();
    const row = nav.locator('section[aria-label="Manuscrito"] li').nth(1);
    await row.locator(".chapter-lock").waitFor();
    assert.equal(await row.getByRole("button", { name: "Renombrar" }).count(), 0);
    assert.equal(await row.getByRole("button", { name: "Eliminar" }).count(), 0);
    assert.equal(await row.getAttribute("draggable"), "false", "no dragging on a phone");
    const select = row.getByLabel("Mover");
    assert.equal(await select.evaluate((e) => getComputedStyle(e).fontSize), "16px", "iOS doesn't zoom into it");
    assert.equal(await row.getByRole("button", { name: "Subir" }).isDisabled(), false, "the arrows work on a locked chapter");

    await select.focus();
    await select.selectOption("reserve");
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Capítulos en reserva"] .chapter-lock').length === 1);
    assert.deepEqual(await flags(), ["Puerto|M", "Invierno|R", "Boda|R", "Carta|R🔒"]);
    const back = nav.locator('section[aria-label="Capítulos en reserva"] li').nth(2);
    await back.getByLabel("Llevar al manuscrito").focus();
    await back.getByLabel("Llevar al manuscrito").selectOption("1");
    await page.waitForFunction(() => document.querySelector('section[aria-label="Manuscrito"] .chapter-name')?.textContent.includes("Carta"));
    assert.deepEqual(await flags(), ["Carta|M🔒", "Puerto|M", "Invierno|R", "Boda|R"]);

    // Still the open chapter, still locked and read-only after moving; the page never zoomed.
    if (await nav.isVisible()) await page.locator(".chapter-title").first().tap().catch(() => {});
    await page.locator(".topbar .lock-toggle.on").waitFor();
    assert.equal(await editor.evaluate((el) => el.readOnly), true);
    assert.equal(await editor.inputValue(), M2);
    assert.equal(await page.evaluate(() => window.visualViewport?.scale ?? 1), 1, "no zoom");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll");
  } finally {
    await ctx.close();
  }
});
