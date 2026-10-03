// Browser end to end (Playwright/Chromium) against the real app, database and mock AI.
// Tests run in order and share one page: a writing session from an empty library.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, resetDb } from "./helpers.mjs";

let browser, ctx, page, novelA, textBefore, call;

before(async () => {
  await resetDb();
  await clearAiLog();
  // Direct API checks go through Node's fetch: Playwright's request client doesn't
  // send the Secure session cookie to http://127.0.0.1 (the browser itself does).
  call = client(await login());
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
});
after(() => browser?.close());

const editor = () => page.locator("textarea.editor");
const savedState = () =>
  page.waitForFunction(() => document.querySelector(".save")?.textContent === "Guardado", null, { timeout: 10_000 });
const api = async (path) => (await call(path)).data;
const label = (text) => page.getByLabel(text, { exact: true });

async function openMemory(tab) {
  await page.getByRole("button", { name: "Memoria" }).click();
  if (tab) await page.getByRole("button", { name: tab }).click();
}

// ---------------------------------------------------------------- library → new novel

test("library: create a novel; it opens with the cursor in the editor", async () => {
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: "Nueva novela" }).click();
  await label("Título de la nueva novela").fill("Valparaíso, 1972");
  await page.getByRole("button", { name: "Crear" }).click();
  await page.waitForURL(/\/novela\//);
  novelA = page.url().split("/").pop();
  await editor().waitFor();
  assert.ok(await editor().evaluate((el) => el === document.activeElement));
});

test("autosave: typing is saved (Guardado) and reaches the database", async () => {
  await editor().type("Juan llegó de madrugada. Elena estaba despierta en la cocina.");
  await savedState();
  const { chapters } = await api(`/api/novels/${novelA}`);
  const ch = await api(`/api/chapters/${chapters[0].id}`);
  assert.equal(ch.content, "Juan llegó de madrugada. Elena estaba despierta en la cocina.");
});

// ---------------------------------------------------------------- memory & guide

test("memory: add characters, a relationship and a fact through the UI", async () => {
  for (const name of ["Juan", "Elena"]) {
    await openMemory();
    await page.getByRole("button", { name: "Añadir" }).click();
    await label("Nombre").fill(name);
    await page.getByRole("button", { name: "Guardar" }).click();
    await page.waitForSelector(".character-cards");
    await page.keyboard.press("Escape");
  }
  await openMemory();
  await page.getByRole("button", { name: /Elena/ }).click();
  await page.locator("summary", { hasText: "Voz" }).click();
  await label("Forma de hablar").fill("Seca. Nunca pregunta directamente.");
  await page.getByRole("button", { name: "Guardar" }).click();

  await page.getByRole("button", { name: "Relaciones" }).click();
  await page.getByRole("button", { name: "Añadir" }).click();
  await label("Personaje").selectOption({ label: "Elena" });
  await label("Relación").fill("desconfía de");
  await label("Con").selectOption({ label: "Juan" });
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForSelector("text=Elena → desconfía de → Juan");

  await page.getByRole("button", { name: "Hechos" }).click();
  await page.getByRole("button", { name: "Añadir" }).click();
  await label("Hecho").fill("Juan estuvo con Marta esa noche.");
  await page.locator("fieldset.checks label", { hasText: "Juan" }).locator("input").check();
  await label("Fecha o época narrativa").fill("agosto de 1972");
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForSelector("text=Juan estuvo con Marta esa noche.");
  await page.keyboard.press("Escape");

  const { memory } = await api(`/api/novels/${novelA}`);
  assert.equal(memory.characters.length, 2);
  assert.equal(memory.characters.find((c) => c.name === "Elena").voice, "Seca. Nunca pregunta directamente.");
  assert.equal(memory.relationships.length, 1);
  assert.equal(memory.facts[0].character_ids.length, 1);
});

test("Guía Maestra: fill fields, preview the master instructions, save", async () => {
  await page.locator(".topbar .title").click();
  await page.getByRole("button", { name: "Guía Maestra" }).click();
  await page.locator("summary", { hasText: "Narración" }).click();
  await label("Persona narrativa").fill("Tercera persona");
  await label("Tiempo verbal predominante").fill("Pasado");
  await page.locator("summary", { hasText: "Estilo" }).click();
  await label("Tono").fill("Seco, contenido");
  await page.locator("summary", { hasText: "Ver instrucciones maestras" }).click();
  assert.match(await page.locator("pre.compiled").innerText(), /Persona narrativa: Tercera persona/);
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForSelector(".modal", { state: "detached" });
  const { novel } = await api(`/api/novels/${novelA}`);
  assert.deepEqual(novel.guide, { person: "Tercera persona", tense: "Pasado", tone: "Seco, contenido" });
});

// ---------------------------------------------------------------- chapters

test("chapters: add one, write in it, switch back (each keeps its text)", async () => {
  await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: "+ Nuevo capítulo" }).click();
  await page.waitForFunction(() => document.querySelector(".chapter-title")?.textContent === "Capítulo 2");
  await editor().type("Capítulo dos: la mañana siguiente.");
  await page.locator(".chapter-name").first().click();
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value.startsWith("Juan llegó"));
});

test("chapters: the chapter being left is saved before switching", async () => {
  const { chapters } = await api(`/api/novels/${novelA}`);
  assert.equal((await api(`/api/chapters/${chapters[1].id}`)).content, "Capítulo dos: la mañana siguiente.");
});

test("chapters: reorder and rename", async () => {
  await page.locator(".chapters li").nth(1).getByRole("button", { name: "Subir" }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".chapter-name")[0]?.textContent.startsWith("Capítulo 1") &&
      document.querySelectorAll(".chapters li")[1]?.classList.contains("current"),
  );
  await page.locator(".chapters li.current").getByRole("button", { name: "Renombrar" }).click();
  await label("Título del capítulo").fill("La llegada");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Capítulo 2: La llegada");
  const { chapters } = await api(`/api/novels/${novelA}`);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ["Capítulo 2", "La llegada"],
  );
});

test("reopening restores the chapter and the cursor position", async () => {
  await editor().evaluate((el) => {
    el.focus();
    el.setSelectionRange(10, 10);
  });
  await page.locator(".topbar .title").click(); // editor blur saves the position
  await page.keyboard.press("Escape");
  await page.reload();
  await editor().waitFor();
  assert.equal(await page.locator(".chapter-title").innerText(), "Capítulo 2: La llegada");
  assert.equal(await editor().evaluate((el) => el.selectionStart), 10);
});

// ---------------------------------------------------------------- Desarrollar escena

test("Desarrollar escena: estimate shown, proposal only, request carries guide and memory", async () => {
  if (!(await page.locator(".panel").isVisible())) await page.locator(".topbar .link", { hasText: "Asistente" }).click();
  await page.getByRole("button", { name: "Escribir escena" }).click();
  await page
    .getByPlaceholder(/Qué ocurre en la escena/)
    .fill("Juan llega de madrugada. Elena sabe que estuvo con Marta, pero no quiere demostrarlo. Juan prepara café.");
  await page.locator("fieldset.checks label", { hasText: "Elena" }).locator("input").check();
  await page.waitForSelector(".estimate");
  assert.match(await page.locator(".estimate").innerText(), /Contexto de esta consulta: ≈/);

  await editor().evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  textBefore = await editor().inputValue();
  await clearAiLog();
  await page.getByRole("button", { name: "Desarrollar escena" }).click();
  await page.waitForSelector("text=Insertar en el cursor");
  assert.equal(await editor().inputValue(), textBefore, "the manuscript is untouched until the author inserts");

  const req = (await aiLog()).at(-1);
  const system = req.body.system.map((b) => b.text).join("\n");
  assert.equal(req.provider, "anthropic");
  assert.match(system, /El argumento del autor es la autoridad/);
  assert.match(system, /Tercera persona/);
  assert.match(system, /### Elena/);
  assert.match(system, /Juan estuvo con Marta/);
});

test("Desarrollar escena: insert at the cursor as new paragraphs; Ctrl+Z removes it", async () => {
  await page.getByRole("button", { name: "Insertar en el cursor" }).click();
  const after = await editor().inputValue();
  assert.ok(after.startsWith(textBefore));
  assert.ok(after.includes("\n\nJuan dejó las llaves sobre la mesa."));
  await page.keyboard.press("Control+z");
  assert.equal(await editor().inputValue(), textBefore);
});

// ---------------------------------------------------------------- editing a selection

test("edit: chosen provider answers; Original / Propuesta; replace; Ctrl+Z", async () => {
  await page.getByRole("button", { name: "Editar selección" }).click();
  await editor().evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 8);
  });
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.locator('.controls label:has(> span:text-is("Modelo")) select').selectOption({ label: "GPT" });
  await page.getByRole("button", { name: "Proponer cambios" }).click();
  await page.waitForSelector("text=Reemplazar selección");
  assert.equal((await aiLog()).at(-1).provider, "openai");
  assert.deepEqual(await page.locator(".compare h3").allInnerTexts(), ["Original", "Propuesta"]);

  const before = await editor().inputValue();
  await page.getByRole("button", { name: "Reemplazar selección" }).click();
  assert.ok((await editor().inputValue()).startsWith("Texto propuesto por el modelo."));
  await page.keyboard.press("Control+z");
  assert.equal(await editor().inputValue(), before);
});

test("edit: 'Probar con Grok' re-runs with another provider; Descartar clears", async () => {
  await page.getByRole("button", { name: "Grok" }).click();
  await page.waitForSelector("text=Reemplazar selección");
  assert.equal((await aiLog()).at(-1).provider, "xai");
  await page.getByRole("button", { name: "Descartar" }).click();
  assert.equal(await page.locator(".result").count(), 0);
});

// ---------------------------------------------------------------- conflicts

test("conflict: a save from another tab is never overwritten; 'Conservar la mía' keeps this tab's text", async () => {
  const { chapters } = await api(`/api/novels/${novelA}`);
  const cur = chapters[1];
  const live = await api(`/api/chapters/${cur.id}`);
  await call(`/api/chapters/${cur.id}`, "PATCH", { content: `${live.content} (otra pestaña)`, revision: live.revision });
  await editor().press("Control+End");
  await page.keyboard.type(" Y aquí.");
  await page.waitForSelector(".save.conflict", { timeout: 10_000 });
  assert.ok((await api(`/api/chapters/${cur.id}`)).content.endsWith("(otra pestaña)"));
  await page.getByRole("button", { name: "Conservar la mía" }).click();
  await savedState();
  assert.ok((await api(`/api/chapters/${cur.id}`)).content.endsWith("Y aquí."));
});

// ---------------------------------------------------------------- focus mode

test("focus mode: only text and cursor", async () => {
  await page.keyboard.press("Control+.");
  await page.mouse.move(700, 600);
  await page.waitForTimeout(400);
  assert.ok(!(await page.locator(".panel").isVisible()));
  assert.ok(!(await page.locator("nav.chapters").isVisible()));
  assert.equal(await page.locator(".topbar").evaluate((e) => getComputedStyle(e).opacity), "0");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator(".panel").isVisible());
});

// ---------------------------------------------------------------- isolation & library actions

test("isolation: a second novel starts empty, without the first one's memory", async () => {
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: "Nueva novela" }).click();
  await label("Título de la nueva novela").fill("Otra historia");
  await page.getByRole("button", { name: "Crear" }).click();
  await page.waitForURL(/\/novela\//);
  await editor().waitFor();
  assert.equal(await editor().inputValue(), "");
  await openMemory();
  assert.equal(await page.locator(".item-list, .character-cards").count(), 0);
  await page.keyboard.press("Escape");
});

test("library: rename, duplicate, delete with explicit confirmation", async () => {
  await page.goto(BASE + "/");
  await page.waitForSelector(".novel-list");
  const row = page.locator(".novel-list li", { hasText: "Otra historia" });
  await row.hover();
  await row.getByRole("button", { name: "Renombrar" }).click();
  await label("Nuevo título").fill("Otra historia (borrador)");
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.waitForSelector("text=Otra historia (borrador)");

  const rowA = page.locator(".novel-list li", { hasText: "Valparaíso, 1972" }).first();
  await rowA.hover();
  await rowA.getByRole("button", { name: "Duplicar" }).click();
  await page.waitForSelector("text=Valparaíso, 1972 (copia)");

  const copy = page.locator(".novel-list li", { hasText: "(copia)" });
  await copy.hover();
  await copy.getByRole("button", { name: "Eliminar" }).click();
  assert.ok(await page.locator(".confirm-delete").isVisible());
  await page.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("(copia)"));
  assert.equal(await page.locator(".novel-list li").count(), 2);
});

// ---------------------------------------------------------------- mobile

test("mobile: editor alone; chapter drawer closes on pick; assistant as a sheet; no horizontal scroll", async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await m.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const mp = await m.newPage();
  await mp.goto(`${BASE}/novela/${novelA}`);
  await mp.locator("textarea.editor").waitFor();
  assert.ok(!(await mp.locator(".panel").isVisible()));
  assert.ok(!(await mp.locator("nav.chapters").isVisible()));
  await mp.locator(".chapter-title").click();
  assert.ok(await mp.locator("nav.chapters").isVisible());
  await mp.locator(".chapter-name").first().click();
  await mp.waitForTimeout(400);
  assert.ok(!(await mp.locator("nav.chapters").isVisible()));
  await mp.getByRole("button", { name: "Asistente" }).click();
  await mp.getByRole("button", { name: "Escribir escena" }).click();
  assert.ok(await mp.locator(".panel").isVisible());
  assert.ok((await mp.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  await m.close();
});

// ---------------------------------------------------------------- long chapter

test("long chapter (~1M characters): typing stays fluid and autosave works", async () => {
  const { id } = (await call("/api/novels", "POST", { title: "Larga" })).data;
  const chId = (await api(`/api/novels/${id}`)).chapters[0].id;
  const para =
    "Llovía sobre la ciudad y Marta caminaba sin prisa, contando los portales como quien cuenta deudas que nunca va a pagar.";
  const content = Array.from({ length: 8500 }, () => para).join("\n\n");
  await call(`/api/chapters/${chId}`, "PATCH", { content, revision: 0 });
  await page.goto(`${BASE}/novela/${id}`);
  await editor().waitFor();
  // Median of three bursts of 20 keys, so one burst slowed down by the machine doesn't decide.
  const bursts = [];
  const keys = ["abcdefghijklmnopqrst", "ABCDEFGHIJKLMNOPQRST", "01234567890123456789"];
  for (const k of keys) {
    await editor().evaluate((el) => {
      el.focus();
      el.setSelectionRange(500_000, 500_000);
    });
    const t0 = Date.now();
    await page.keyboard.type(k, { delay: 0 });
    bursts.push((Date.now() - t0) / 20);
  }
  const perKey = [...bursts].sort((a, b) => a - b)[1];
  // Generous bound: headless Chromium without GPU; a plain textarea alone is ~28 ms here.
  assert.ok(perKey < 80, `${perKey.toFixed(1)} ms per keystroke (bursts: ${bursts.map((b) => b.toFixed(1)).join(", ")})`);
  await savedState();
  const saved = (await api(`/api/chapters/${chId}`)).content;
  for (const k of keys) assert.ok(saved.includes(k), k);
});
