// The Asistente on a desktop (docs/asistente-contexto.md): one navigation for Asistente |
// Consejero (the top bar), a top bar that never runs under the panel, the literary flow of
// «Escribir escena» with the model in «Opciones avanzadas», and long proposals read in large.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb, textEditor } from "./helpers.mjs";

let call, browser, novel, ch;
const PARA = (i) => `Héctor soltó una risa baja, pero no tocó el teléfono. Pilar tampoco (${i}).`;
const TEXT = Array.from({ length: 30 }, (_, i) => PARA(i)).join("\n\n");

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Una novela con un título bastante largo" })).data.id;
  ch = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${ch}`, "PATCH", { title: "La joven" });
  for (const t of ["El intento", "Confesiones"]) await call(`/api/novels/${novel}/chapters`, "POST", { title: t });
  for (const n of ["Pilar", "Héctor"]) await call(`/api/novels/${novel}/memory/characters`, "POST", { name: n });
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => browser?.close());

async function setText(content) {
  const { revision } = (await call(`/api/chapters/${ch}`)).data;
  assert.equal((await call(`/api/chapters/${ch}`, "PATCH", { content, revision })).status, 200);
}

async function open({ width = 1255, height = 839, nav = true, section = "assistant", plain = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  if (plain) await textEditor(ctx);
  await ctx.addInitScript(([n, nav, section]) => {
    localStorage.setItem("navOpen", nav ? "1" : "0");
    localStorage.setItem("panelOpen", "1");
    localStorage.setItem("panelSection", section);
    localStorage.setItem(`argument:${n}`, "");
  }, [novel, nav, section]);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator(plain ? "textarea.editor" : ".visual-editor .visual-text").waitFor();
  const panel = page.locator("aside.panel");
  await panel.waitFor();
  return { ctx, page, panel };
}

/** Nothing of the top bar beyond its column (it used to run under the Asistente's panel). */
async function topbarFits(page) {
  return page.evaluate(() => {
    const col = document.querySelector(".editor-col").getBoundingClientRect();
    const bar = document.querySelector(".topbar");
    const kids = [...bar.children].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    return { fits: bar.scrollWidth <= bar.clientWidth && kids.every((r) => r.right <= col.right + 0.5 && r.left >= col.left - 0.5), titles: [".title", ".chapter-title"].map((s) => document.querySelector(`.topbar ${s}`).getBoundingClientRect().width) };
  });
}

test("one navigation: Asistente | Consejero only in the top bar; the top bar never runs under the panel, at any desktop width", async () => {
  await setText(TEXT);
  for (const [width, height] of [[1000, 760], [1100, 800], [1255, 839], [1440, 900], [1920, 1080]]) {
    for (const nav of [true, false]) {
      const { ctx, page, panel } = await open({ width, height, nav });
      const fit = await topbarFits(page);
      assert.ok(fit.fits, `${width}px, chapters ${nav ? "open" : "closed"}: the top bar fits its column`);
      assert.ok(fit.titles.every((w) => w >= 30), `${width}px: the novel and chapter titles stay visible (${fit.titles})`);
      // Exactly one Asistente and one Consejero button in the page: the top bar's.
      assert.equal(await page.getByRole("button", { name: "Asistente", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Consejero", exact: true }).count(), 1);
      assert.equal(await panel.getByRole("button", { name: /^(Asistente|Consejero)$/ }).count(), 0);
      // The panel's header: its own tabs and Ocultar, nothing over the manuscript's column.
      const head = await panel.locator(".panel-head").boundingBox();
      const col = await page.locator(".editor-col").boundingBox();
      assert.ok(head.x >= col.x + col.width - 1, "the panel header is in the panel's column");
      await ctx.close();
    }
  }
  // The Consejero: the top bar switches; the panel shows the Consejero's own views.
  const { ctx, page, panel } = await open();
  await page.locator(".topbar").getByRole("button", { name: "Consejero", exact: true }).click();
  assert.equal(await panel.getAttribute("aria-label"), "Consejero");
  assert.ok(await panel.locator(".panel-head").getByRole("button", { name: "Consultar" }).isVisible());
  assert.ok(await panel.locator(".panel-head").getByRole("button", { name: "Ocultar" }).isVisible());
  // Its model selector stays where it was (the Consejero is not reorganized).
  assert.ok(await panel.locator('.controls label:has(> span:text-is("Modelo")) select').first().isVisible());
  assert.equal(await panel.locator("details.advanced").count(), 0);
  // Closed, and open again from the top bar.
  await panel.getByRole("button", { name: "Ocultar" }).click();
  assert.ok(await panel.isHidden());
  assert.ok((await topbarFits(page)).fits);
  await page.locator(".topbar").getByRole("button", { name: "Asistente", exact: true }).click();
  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  await ctx.close();
});

test("Escribir escena: argumento → dónde va → extensión → contexto → Desarrollar; the model in «Opciones avanzadas»; tokens discreet", async () => {
  await setText(TEXT);
  const { ctx, page, panel } = await open();
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  const top = async (loc) => (await loc.boundingBox()).y;
  const argument = panel.getByPlaceholder(/Qué ocurre en la escena/);
  const order = [
    await top(argument),
    await top(panel.locator("fieldset.scene-target")),
    await top(panel.getByLabel("Extensión")),
    await top(panel.getByLabel(/Leer toda la historia hasta aquí/)),
    await top(panel.getByRole("button", { name: "Desarrollar escena" })),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, `the literary order: ${order}`);
  // A short explanation that informal notes are enough.
  assert.match(await panel.locator(".field-help").innerText(), /Escríbelo como te salga/);
  // Empty argument: nothing to develop.
  assert.ok(await panel.getByRole("button", { name: "Desarrollar escena" }).isDisabled());
  await argument.fill("ya estaba todo preparado, ducha nueva, el cuarto inmenso, la cama king, los acolchados, solo faltaba comenzar con el trato");
  assert.ok(await panel.getByRole("button", { name: "Desarrollar escena" }).isEnabled());
  // A long argument stays readable and the button stays in the flow.
  await argument.fill("Una indicación larga. ".repeat(80));
  assert.ok(await panel.getByRole("button", { name: "Desarrollar escena" }).isEnabled());
  // The model: not in the main flow, still available.
  assert.equal(await panel.locator(".scene-controls").getByText("Modelo", { exact: true }).count(), 0);
  const advanced = panel.locator("details.advanced");
  assert.equal(await advanced.getAttribute("open"), null);
  assert.ok(!(await advanced.locator("select").isVisible()));
  await advanced.locator("summary").click();
  await advanced.getByLabel("Modelo").selectOption({ label: "GPT" });
  assert.equal(await advanced.getByLabel("Modelo").inputValue(), "openai");
  // «Leer toda la historia hasta aquí»: visible, with its explanation; the figures discreet.
  const read = panel.getByLabel(/Leer toda la historia hasta aquí/);
  assert.ok(await read.isVisible());
  assert.doesNotMatch(await panel.locator("label.check", { hasText: "Leer toda la historia" }).innerText(), /tokens/);
  assert.match(await panel.locator(".check-help").last().innerText(), /no lee toda la historia/);
  await read.check();
  assert.match(await panel.locator(".check-help").last().innerText(), /Lee los capítulos anteriores/);
  await panel.locator(".estimate").waitFor();
  assert.ok((await panel.locator(".estimate").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) <= 11);
  assert.ok(await panel.getByRole("button", { name: "Ver contexto" }).isVisible());
  await read.uncheck();
  await ctx.close();
});

test("a ~700-word scene: the answer comes to the top of the panel, its actions stay at hand, and it reads in large", async () => {
  await setText(TEXT);
  const { ctx, page, panel } = await open();
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await panel.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve a casa de madrugada ESCENA-LARGA");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  const insert = panel.getByRole("button", { name: "Insertar al final" });
  await insert.waitFor({ timeout: 30_000 });
  const p = await panel.boundingBox();
  const result = await panel.locator(".result").boundingBox();
  assert.ok(result.y - p.y < 120, `the answer near the top of the panel (${Math.round(result.y - p.y)} px)`);
  // The actions: Insertar, Otra versión, Descartar, inside the visible panel without scrolling.
  for (const name of ["Insertar al final", "Otra versión", "Descartar"]) {
    const b = await panel.getByRole("button", { name, exact: true }).boundingBox();
    assert.ok(b.y >= p.y && b.y + b.height <= p.y + p.height + 1, `${name} visible in the panel`);
  }
  // No small box with its own scroll inside the panel.
  const diff = panel.locator(".result .diff");
  assert.ok(await diff.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), "the proposal is not shut in a small scrolling box");
  // And at the bottom of the reading, the actions are still there (sticky).
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  const mid = await insert.boundingBox();
  assert.ok(mid.y + mid.height <= p.y + p.height + 1 && mid.y >= p.y, "Insertar reachable while reading");

  // «Abrir propuesta»: the scene as the book sets it, with the same actions.
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  const reader = page.getByRole("dialog", { name: "Propuesta de escena" });
  await reader.waitFor();
  assert.ok((await reader.locator(".reader-text p").count()) > 20, "paragraphs kept");
  // The manuscript's typography (the same as Lectura).
  assert.equal(await reader.locator(".reader-text").evaluate((el) => getComputedStyle(el).fontSize), await page.locator(".visual-editor").evaluate((el) => getComputedStyle(el).fontSize));
  assert.match(await reader.innerText(), /Se insertará al final del capítulo/);
  assert.match(await reader.innerText(), /≈\s?\d+ palabras/);
  const readerBox = await reader.boundingBox();
  assert.ok(readerBox.width >= 700, "a large surface");
  for (const name of ["Insertar al final", "Otra versión", "Descartar"]) assert.ok(await reader.getByRole("button", { name, exact: true }).isVisible(), name);
  // Back to the manuscript: nothing is lost.
  await reader.getByRole("button", { name: "Volver al manuscrito" }).click();
  assert.equal(await reader.count(), 0);
  assert.ok(await insert.isVisible(), "the proposal is still in the panel");
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Propuesta de escena" }).count(), 0);
  // Insert from the large view: at the end of the chapter, the rest intact.
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  await page.getByRole("dialog", { name: "Propuesta de escena" }).getByRole("button", { name: "Insertar al final" }).click();
  for (let i = 0; i < 50 && !(await call(`/api/chapters/${ch}`)).data.content.includes("ESCENA-DESARROLLADA"); i++) await page.waitForTimeout(200);
  const saved = (await call(`/api/chapters/${ch}`)).data.content;
  assert.ok(saved.startsWith(TEXT), "the chapter before it, intact");
  assert.ok(saved.slice(TEXT.length).includes("ESCENA-DESARROLLADA"), "the scene at the end");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Abrir propuesta" }).count(), 0, "the proposal did its job");
  await ctx.close();
});

test("short answer; Otra versión and Descartar, from the panel and from the large view", async () => {
  await setText(TEXT);
  const { ctx, page, panel } = await open();
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await panel.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan entra y se sienta.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar al final" }).waitFor({ timeout: 30_000 });
  // Otra versión from the large view: it closes, and a new proposal arrives in the panel.
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  await page.getByRole("dialog", { name: "Propuesta de escena" }).getByRole("button", { name: "Otra versión" }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await panel.getByRole("button", { name: "Insertar al final" }).waitFor({ timeout: 30_000 });
  // Descartar from the large view: the proposal goes, the argument stays.
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  await page.getByRole("dialog", { name: "Propuesta de escena" }).getByRole("button", { name: "Descartar" }).click();
  assert.equal(await panel.locator(".result").count(), 0);
  assert.equal(await panel.getByPlaceholder(/Qué ocurre en la escena/).inputValue(), "Juan entra y se sienta.");
  // And Descartar from the panel.
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Descartar" }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Descartar" }).click();
  assert.equal(await panel.locator(".result").count(), 0);
  assert.equal((await call(`/api/chapters/${ch}`)).data.content, TEXT, "nothing reached the manuscript");
  await ctx.close();
});

test("Editar selección: the fragment first; a proposal read in large with its changes; Reemplazar from there", async () => {
  await setText(TEXT);
  const { ctx, page, panel } = await open({ plain: true });
  await panel.getByRole("button", { name: "Editar selección" }).click();
  await page.locator("textarea.editor").evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 40);
  });
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  const quote = panel.locator("blockquote.quote");
  await panel.getByText("Fragmento seleccionado en el editor").waitFor();
  assert.ok((await quote.boundingBox()).y < (await panel.getByText("Personaje", { exact: true }).boundingBox()).y, "the fragment before the decisions");
  assert.ok(await panel.locator("details.advanced").isVisible());
  await panel.getByRole("button", { name: "Proponer cambios" }).click();
  await panel.getByRole("button", { name: "Reemplazar selección" }).waitFor({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Abrir propuesta" }).click();
  const reader = page.getByRole("dialog", { name: "Propuesta de cambios" });
  await reader.waitFor();
  assert.deepEqual(await reader.locator(".reader-tabs button").allInnerTexts(), ["Propuesta", "Cambios", "Tu texto"]);
  await reader.getByRole("button", { name: "Tu texto" }).click();
  assert.match(await reader.locator(".reader-text").innerText(), /Héctor soltó una risa baja/);
  await reader.getByRole("button", { name: "Cambios" }).click();
  assert.ok(await reader.locator(".diff").isVisible());
  await reader.getByRole("button", { name: "Reemplazar selección" }).click();
  for (let i = 0; i < 50 && (await call(`/api/chapters/${ch}`)).data.content === TEXT; i++) await page.waitForTimeout(200);
  assert.notEqual((await call(`/api/chapters/${ch}`)).data.content, TEXT, "replaced");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await ctx.close();
});
