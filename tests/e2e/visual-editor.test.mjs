// Editor visual, Fase A (docs/editor-visual.md): the chapter as the book shows it, edited in
// place, behind a switch (?editor=visual), with `chapters.content` kept in today's format.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, png, resetDb } from "./helpers.mjs";

let call, cookie, browser, novel, chapterId;
const IMG = crypto.randomUUID();
const P1 = "Llegamos al puerto cuando ya no quedaba nadie en el muelle, y el viento traía olor a *sal* y a gasoil.";
const P2 = "—Siempre dices lo mismo —dije.";
const P3 = "A la mañana siguiente el barco ya no estaba.";
// The central fragment: paragraph → real image (with caption and credit) → paragraph → scene break → paragraph.
const CENTRAL = `${P1}\n\n[[imagen:${IMG}]]\n\n${P2}\n\n[[separador]]\n\n${P3}`;

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  novel = (await call("/api/novels", "POST", { title: "Visual" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapterId}`, "PATCH", { title: "El muelle" });
  await setText(CENTRAL);
  // A real image, placed by its marker, with caption and credit in manuscript_images.
  const file = png(1200, 800);
  const start = await call(`/api/novels/${novel}/assets`, "POST", { file_name: "puerto.png", type: "image/png", bytes: file.length });
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: file });
  const form = new FormData();
  form.append("display", new Blob([png(600, 400)]));
  form.append("thumb", new Blob([png(60, 40)]));
  form.append("use", JSON.stringify({ kind: "manuscript", id: IMG, alt: "El puerto al amanecer" }));
  const res = await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(res.status, 201, await res.text());
  assert.equal((await call(`/api/manuscript-images/${IMG}`, "PATCH", { caption: "El puerto al amanecer", credit: "Foto: Archivo familiar", width_pct: 75 })).status, 200);
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => browser?.close());
// A test that fails leaves its window open, and its autosave would write over the next test's
// text: every window still open is closed after each test.
const contexts = new Set();
afterEach(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  contexts.clear();
});

async function setText(content) {
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  const r = await call(`/api/chapters/${chapterId}`, "PATCH", { content, revision });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
const stored = async () => (await call(`/api/chapters/${chapterId}`)).data;
async function saved(check, what = "saved") {
  for (let i = 0; i < 80; i++) {
    if (check((await stored()).content)) return (await stored()).content;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}: ${JSON.stringify((await stored()).content)}`);
}

const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

async function open(context = DESKTOP, query = "?editor=visual") {
  const ctx = await browser.newContext(context);
  contexts.add(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}${query}`);
  const editor = page.locator(".visual-editor .visual-text");
  if (query.includes("visual")) await editor.waitFor();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return { ctx, page, editor, mod };
}

/** Where a piece of text is on screen: the box of one of its characters. */
async function charBox(page, text, which) {
  return page.evaluate(
    ([t, w]) => {
      const root = document.querySelector(".visual-text");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(t);
        if (i === -1) continue;
        const at = w === "first" ? i : i + t.length - 1;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + 1);
        r.startContainer.parentElement.scrollIntoView({ block: "center", behavior: "instant" });
        const b = r.getBoundingClientRect();
        return { x: b.left, y: b.top + b.height / 2, w: b.width };
      }
      throw new Error(`not found: ${t}`);
    },
    [text, which],
  );
}

/** The text of the caret's paragraph before and after the caret. */
const aroundCaret = (page) =>
  page.evaluate(() => {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return null;
    const p = s.anchorNode.nodeType === 1 ? s.anchorNode.closest("p") : s.anchorNode.parentElement.closest("p");
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p, 0);
    r.setEnd(s.anchorNode, s.anchorOffset);
    return { before: r.toString(), after: p.textContent.slice(r.toString().length) };
  });

/**
 * Clicks right after (or before) the first occurrence of `text`, as the author would, and checks
 * the caret landed there: the layout can still move while the page settles (the panel opening).
 */
async function clickAt(page, text, side) {
  for (let i = 0; i < 5; i++) {
    const b = await charBox(page, text, side === "after" ? "last" : "first");
    await page.mouse.click(side === "after" ? b.x + b.w - 0.5 : b.x + 0.5, b.y);
    await page.waitForTimeout(60);
    const at = await aroundCaret(page);
    if (at && (side === "after" ? at.before.endsWith(text) : at.after.startsWith(text))) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`could not put the caret ${side} ${text}`);
}
const caretAfter = (page, text) => clickAt(page, text, "after");
const caretBefore = (page, text) => clickAt(page, text, "before");

test("central: paragraph → real image → caption and credit → paragraph → scene break → paragraph, with nothing technical in sight", async () => {
  const { ctx, page, editor } = await open();
  const kinds = await editor.evaluate((el) => [...el.children].map((c) => c.tagName + (c.className ? `.${c.className.split(" ")[0]}` : "")));
  assert.deepEqual(kinds, ["P", "FIGURE.fig", "P", "HR.scene-break", "P"]);
  // The image is the real file, loaded, at its width, with caption and credit under it.
  const fig = editor.locator("figure");
  await fig.locator("img").evaluate((img) => img.decode());
  assert.ok(await fig.locator("img").evaluate((img) => img.naturalWidth > 0 && img.complete));
  assert.equal(await fig.locator("img").getAttribute("alt"), "El puerto al amanecer");
  assert.equal(await fig.locator(".fig-caption").innerText(), "El puerto al amanecer");
  assert.equal(await fig.locator(".fig-credit").innerText(), "Foto: Archivo familiar");
  // Italics are italics; the scene break is the ornament.
  assert.equal(await editor.locator("p em").innerText(), "sal");
  assert.match(await editor.locator("hr.scene-break").evaluate((el) => getComputedStyle(el, "::after").content), /\* \* \*/);
  // Nothing technical: no markers, no asterisks, anywhere in what the author sees.
  const visible = await page.locator(".visual-editor").innerText();
  assert.ok(!/\[\[|\]\]|imagen:|separador|\*/.test(visible), visible);
  // Book typography: the first paragraph, and the one after the image and after the break, without indent.
  const indents = await editor.locator("p").evaluateAll((ps) => ps.map((p) => parseFloat(getComputedStyle(p).textIndent) > 0));
  assert.deepEqual(indents, [false, false, false]);
  if (process.env.E2E_SHOTS) await page.locator(".visual-editor").screenshot({ path: `${process.env.E2E_SHOTS}/visual-escritorio.png` });
  // Opening the chapter changes nothing: no save.
  await page.waitForTimeout(1500);
  const after = await stored();
  assert.equal(after.content, CENTRAL);
  await ctx.close();
});

/** Selects from the start of `from` to the end of `to`: a click, then Shift+click (across blocks too). */
async function selectText(page, from, to) {
  await caretBefore(page, from);
  const z = await charBox(page, to, "last");
  await page.keyboard.down("Shift");
  await page.mouse.click(z.x + z.w - 0.5, z.y);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(60);
}

test("writing around the blocks: each edit changes its own line, the rest stays byte for byte", async () => {
  await setText(CENTRAL);
  const { ctx, page, editor } = await open();
  await caretAfter(page, "y a gasoil.");
  await page.keyboard.type(" Hacía frío.");
  await caretAfter(page, "lo mismo —dije.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Lorena me miró de costado.");
  // Right after the scene break: the start of the last paragraph.
  await caretBefore(page, "A la mañana");
  await page.keyboard.type("Entonces, ");
  const expected = `${P1} Hacía frío.\n\n[[imagen:${IMG}]]\n\n${P2}\n\nLorena me miró de costado.\n\n[[separador]]\n\nEntonces, ${P3}`;
  await saved((c) => c === expected, "edits around blocks");
  assert.equal(await editor.locator("figure").count(), 1);
  assert.equal(await editor.locator("hr").count(), 1);
  // Typing with the image selected never replaces it: the text goes in a new paragraph after it.
  await editor.locator("figure").click();
  assert.ok(await editor.locator("figure").evaluate((f) => f.classList.contains("ProseMirror-selectednode")));
  await page.locator(".image-card").waitFor();
  await page.keyboard.type("X");
  await saved((c) => c.includes(`[[imagen:${IMG}]]\n\nX\n\n${P2}`), "typing on a selected image");
  assert.equal(await editor.locator("figure").count(), 1);
  await ctx.close();
});

test("selection, deletion, undo and redo: an image and a scene break go and come back exactly", async () => {
  await setText(CENTRAL);
  const { ctx, page, editor, mod } = await open();
  const without = `${P1}\n\n${P2}\n\n[[separador]]\n\n${P3}`;
  await editor.locator("figure").click();
  await page.keyboard.press("Backspace");
  assert.equal(await editor.locator("figure").count(), 0);
  await saved((c) => c === without, "image deleted");
  await page.keyboard.press(`${mod}+z`);
  assert.equal(await editor.locator("figure").count(), 1);
  await saved((c) => c === CENTRAL, "undo restores it exactly");
  await page.keyboard.press(`${mod}+Shift+z`);
  assert.equal(await editor.locator("figure").count(), 0);
  await saved((c) => c === without, "redo");
  await page.keyboard.press(`${mod}+z`);
  await saved((c) => c === CENTRAL, "undo again");

  // The scene break: selected by a click, deleted with Delete, back with undo.
  await editor.locator("hr.scene-break").click();
  await page.keyboard.press("Delete");
  assert.equal(await editor.locator("hr").count(), 0);
  await saved((c) => c === `${P1}\n\n[[imagen:${IMG}]]\n\n${P2}\n\n${P3}`, "break deleted");
  await page.keyboard.press(`${mod}+z`);
  await saved((c) => c === CENTRAL, "break back");

  // A selection across the image, deleted as one step, and undone.
  await selectText(page, "nadie", "Siempre");
  await page.keyboard.press("Backspace");
  assert.equal(await editor.locator("figure").count(), 0);
  await saved((c) => c.startsWith("Llegamos al puerto cuando ya no quedaba  dices lo mismo") && !c.includes("imagen:"), "range across the image deleted");
  await page.keyboard.press(`${mod}+z`);
  await saved((c) => c === CENTRAL, "range back");
  await ctx.close();
});

test("italics: Ctrl/⌘+I and the bar's button, no asterisks in sight; a typed asterisk stays an asterisk", async () => {
  await setText(CENTRAL);
  const { ctx, page, editor, mod } = await open();
  await selectText(page, "puerto", "puerto");
  await page.keyboard.press(`${mod}+i`);
  await saved((c) => c.startsWith("Llegamos al *puerto* cuando"), "italic on");
  assert.deepEqual(await editor.locator("p").first().locator("em").allInnerTexts(), ["puerto", "sal"]);
  await selectText(page, "muelle", "muelle");
  await page.getByRole("button", { name: "Cursiva" }).click();
  await saved((c) => c.includes("en el *muelle*, y"), "italic with the button");
  await selectText(page, "puerto", "puerto");
  await page.keyboard.press(`${mod}+i`);
  await saved((c) => c.startsWith("Llegamos al puerto cuando"), "italic off");
  // A literal asterisk is written escaped, so it never becomes italics by accident.
  await caretAfter(page, "ya no estaba.");
  await page.keyboard.type(" 5 * 3 *no* es cursiva.");
  await saved((c) => c.endsWith("ya no estaba. 5 \\* 3 \\*no\\* es cursiva."), "literal asterisks");
  assert.match(await editor.locator("p").last().innerText(), /5 \* 3 \*no\* es cursiva\.$/);
  assert.equal(await editor.locator("p").last().locator("em").count(), 0);
  // The scene break button.
  await caretAfter(page, "—dije.");
  await page.getByRole("button", { name: "Separador de escena" }).click();
  assert.equal(await editor.locator("hr.scene-break").count(), 2);
  await saved((c) => c.includes(`${P2}\n\n[[separador]]\n\n[[separador]]`), "separator button");
  await ctx.close();
});

test("opening a chapter changes nothing, however it was typed (CRLF, invisible lines, odd spacing)", async () => {
  const odd = `\n  Uno con *cursiva* y \\* literal.  \r\n\r\n​\n[[SEPARADOR]]\t\n\n\nDos.\n﻿\n  [[imagen:${IMG.toUpperCase()}]]  \nTres **no** es cursiva.\n\n\n`;
  await setText(odd);
  const before = await stored();
  const { ctx, page, editor } = await open();
  assert.deepEqual(
    await editor.evaluate((el) => [...el.children].map((c) => c.tagName)),
    ["P", "HR", "P", "FIGURE", "P"],
  );
  assert.ok(!/\[\[|\\/.test(await page.locator(".visual-editor").innerText()));
  await page.waitForTimeout(1500);
  const after = await stored();
  assert.equal(after.content, odd);
  assert.equal(after.revision, before.revision, "not even saved");
  // One edit: only that line changes.
  await caretAfter(page, "Dos.");
  await page.keyboard.type(" Y más.");
  await saved((c) => c === odd.replace("\nDos.\n", "\nDos. Y más.\n"), "one line changed");
  await ctx.close();
});

test("Asistente on the visual editor: rewrite a selection, then a scene at the end; the rest untouched", async () => {
  await setText(CENTRAL);
  const { ctx, page, editor } = await open();
  const panel = page.locator("aside.panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().click();
  await panel.getByRole("button", { name: "Editar selección" }).click();
  await selectText(page, "—Siempre", "—dije.");
  await clearAiLog();
  await panel.getByRole("button", { name: "Proponer cambios" }).click();
  await panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();
  const sent = JSON.stringify((await aiLog())[0].body);
  assert.ok(sent.includes("—Siempre dices lo mismo —dije."), "the selection reached the model");
  await panel.getByRole("button", { name: "Reemplazar selección" }).click();
  const rewritten = CENTRAL.replace(P2, "Texto propuesto por el modelo.");
  await saved((c) => c === rewritten, "rewrite applied");
  await editor.getByText("Texto propuesto por el modelo.").waitFor();
  assert.equal(await editor.locator("figure").count(), 1);
  // The copy before the change (save_chapter_version doesn't repeat a text already kept, so it may
  // be an earlier row with the same text): the newest version holds the text as it was.
  const [latest] = (await call(`/api/chapters/${chapterId}/versions`)).data;
  assert.equal((await call(`/api/versions/${latest.id}`)).data.content, CENTRAL, "the copy before the change");

  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar al final" }).click();
  const content = await saved((c) => c.startsWith(rewritten) && c.length > rewritten.length + 10, "scene at the end");
  assert.ok(content.startsWith(`${rewritten}\n\n`), "its own paragraphs after the last one");
  assert.ok(!/\[\[|\*/.test(await page.locator(".visual-editor").innerText()));
  await ctx.close();
});

test("Consejero's «Ir», versions, word count and images on the visual editor", async () => {
  const text = `La lámpara temblaba sobre la mesa. Elena miró la *lámpara* sin decir nada.\n\n[[imagen:${IMG}]]\n\nFin.`;
  await setText(text);
  const { ctx, page, editor } = await open();
  // Word count: the same as the plain editor counts (markers and asterisks don't count).
  await page.locator(".topbar .words").filter({ hasText: /^14 palabras$/ }).waitFor();

  // «Ir» selects the quoted word in the visual editor (the Consejero works with offsets in the text).
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  await page.getByRole("button", { name: "Panorama" }).click();
  const lamp = page.locator(".overview .repetitions > li", { hasText: "«lámpara»" });
  await lamp.waitFor();
  await lamp.getByRole("button", { name: "Ir" }).nth(1).click();
  await page.waitForFunction(() => getSelection().toString() === "lámpara");

  // Versions: restore an older text; the editor shows it, and «Deshacer» brings ours back.
  await call(`/api/chapters/${chapterId}/versions`, "POST", { reason: "manual", label: "Antes" });
  await caretAfter(page, "Fin.");
  await page.keyboard.type(" Nuevo.");
  await saved((c) => c.endsWith("Fin. Nuevo."), "typed");
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: "Versiones de este capítulo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Antes/ }).first().click();
  await dialog.getByRole("button", { name: "Restaurar esta versión" }).click();
  await saved((c) => c === text, "restored");
  await editor.locator("p", { hasText: /^Fin\.$/ }).waitFor();
  await page.locator(".editor-notice.applied").getByRole("button", { name: "Deshacer" }).click();
  await saved((c) => c.endsWith("Fin. Nuevo."), "restore undone");

  // Images: the card follows the selected image; «Quitar del texto» takes the block out.
  await editor.locator("figure").click();
  const card = page.locator(".image-card");
  await card.waitFor();
  await card.getByRole("button", { name: /Quitar/ }).first().click();
  await saved((c) => !c.includes("[[imagen:"), "image taken out of the text");
  assert.equal(await editor.locator("figure").count(), 0);
  await ctx.close();
});

test("the switch: the plain editor stays the default; the visual one is opt-in and remembered", async () => {
  await setText(CENTRAL);
  const { ctx, page } = await open(DESKTOP, "?editor=texto");
  await page.locator("textarea.editor").waitFor();
  assert.equal(await page.locator(".visual-editor").count(), 0);
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: /Editor visual \(prueba\): no/ }).click();
  await page.locator(".visual-editor .visual-text figure").waitFor();
  // Remembered on this device: the address without ?editor= opens the visual editor.
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator(".visual-editor .visual-text").waitFor();
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: /Editor visual \(prueba\): sí/ }).click();
  await page.locator("textarea.editor").waitFor();
  assert.equal(await page.locator("textarea.editor").inputValue(), CENTRAL);
  await ctx.close();
});

test("phone: tap and type around the image and the break; no horizontal scroll", async () => {
  await setText(CENTRAL);
  const { ctx, page, editor } = await open(PHONE);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await editor.locator("p").nth(1).tap();
  await page.keyboard.press("End");
  await page.keyboard.type(" Otra vez.");
  await saved((c) => c.includes("—Siempre dices lo mismo —dije. Otra vez."), "typed on the phone");
  assert.equal(await editor.locator("figure").count(), 1);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/visual-telefono.png` });
  await ctx.close();
});

test("long chapter (~1M characters) in the visual editor: typing stays fluid and autosave works", async () => {
  const para = "Llovía sobre la ciudad y Marta caminaba sin prisa, contando los portales como quien cuenta deudas que nunca va a pagar.";
  const content = Array.from({ length: 8500 }, () => para).join("\n\n");
  await setText(content);
  const { ctx, page } = await open();
  const bursts = [];
  const keys = ["abcdefghijklmnopqrst", "ABCDEFGHIJKLMNOPQRST", "01234567890123456789"];
  for (const k of keys) {
    // The middle of the chapter, as in the plain editor's test.
    await page.evaluate(() => {
      const p = document.querySelectorAll(".visual-text > p")[4250];
      const r = document.createRange();
      r.setStart(p.firstChild, 40);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      p.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(200);
    const t0 = Date.now();
    await page.keyboard.type(k, { delay: 0 });
    bursts.push((Date.now() - t0) / 20);
  }
  const perKey = [...bursts].sort((a, b) => a - b)[1];
  console.log(`# visual 1MB: ${perKey.toFixed(1)} ms per keystroke (bursts: ${bursts.map((b) => b.toFixed(1)).join(", ")})`);
  assert.ok(perKey < 80, `${perKey.toFixed(1)} ms per keystroke (bursts: ${bursts.map((b) => b.toFixed(1)).join(", ")})`);
  const saved1 = await saved((c) => keys.every((k) => c.includes(k)), "long chapter saved");
  // Only the edited paragraph changed.
  const changed = saved1.split("\n\n").filter((p) => p !== para);
  assert.equal(changed.length, 1, "one paragraph");
  await ctx.close();
});

/** Pastes as the browser does: a paste event with text/plain and, optionally, text/html. */
async function paste(page, text, html) {
  await page.evaluate(
    ([t, h]) => {
      const data = new DataTransfer();
      data.setData("text/plain", t);
      if (h) data.setData("text/html", h);
      document.querySelector(".visual-text").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [text, html ?? null],
  );
}

test("paste: plain text in the manuscript format becomes blocks; HTML from Word keeps paragraphs and italics, drops the rest", async () => {
  await setText("Antes.");
  const { ctx, page, editor } = await open();
  await caretAfter(page, "Antes.");
  await paste(page, "\nPegado con *cursiva*.\n\n[[separador]]\n\nDespués del corte.");
  assert.deepEqual(await editor.evaluate((el) => [...el.children].map((c) => c.tagName)), ["P", "P", "HR", "P"]);
  await saved((c) => c === "Antes.\n\nPegado con *cursiva*.\n\n[[separador]]\n\nDespués del corte.", "plain paste");
  // As Word puts it on the clipboard: styled paragraphs, bold, a heading, a list.
  await caretAfter(page, "Después del corte.");
  await paste(
    page,
    "ignored",
    `<html><body><h1 style="font-size:20pt">Título de Word</h1><p class="MsoNormal" style="margin:0">Uno <b>negrita</b> y <i>cursiva</i>.</p><ul><li>Elemento</li></ul></body></html>`,
  );
  const content = await saved((c) => c.includes("cursiva*.") && c.includes("Elemento"), "html paste");
  assert.ok(content.includes("Uno negrita y *cursiva*."), content);
  assert.ok(!/<|>|\*\*/.test(content), "no tags, no bold");
  assert.ok(!/\[\[|\*/.test(await page.locator(".visual-editor").innerText()));
  await ctx.close();
});

test("Enter on an empty paragraph adds nothing: space between scenes comes from a scene break", async () => {
  await setText("Uno.");
  const { ctx, page, editor } = await open();
  await caretAfter(page, "Uno.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Dos.");
  await saved((c) => c === "Uno.\n\nDos.", "one new paragraph");
  assert.equal(await editor.locator("p").count(), 2);
  await ctx.close();
});

test("the conversion report runs on a real backup downloaded from Procesador", async () => {
  await setText(CENTRAL);
  const ctx = await browser.newContext({ ...DESKTOP, acceptDownloads: true });
  contexts.add(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/novela/${novel}?editor=visual`);
  await page.locator(".visual-editor .visual-text").waitFor();
  await page.locator(".topbar .title").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar copia de seguridad" }).click()]);
  const zip = await download.path();
  const { execFileSync } = await import("node:child_process");
  const md = execFileSync(process.execPath, ["--import", "tsx", "scripts/visual-roundtrip.ts", "--zip", zip], { encoding: "utf8" });
  assert.match(md, /idéntico, byte a byte \| 1 de 1 \|/);
  assert.match(md, /lo mismo que Lectura y la exportación \| 1 de 1 \|/);
  assert.match(md, /Párrafos \/ imágenes \/ separadores \| 3 \/ 1 \/ 1 \|/);
  await ctx.close();
});

// ---------------------------------------------------------------- activation on the phone
// The real problem on the iPhone: opening the link with ?editor=visual without a session went
// through the login, which dropped the query and went to the library; the novel then opened in
// the plain editor. These tests check the mounted editor in the DOM, not just that the page loads.

const IPHONE = {
  ...PHONE,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

/** What is really mounted: the visual editor (editable, with its blocks) and no textarea. */
async function assertVisualMounted(page, what) {
  const root = page.locator('[data-editor="visual"] .visual-text[contenteditable="true"]');
  await root.waitFor({ timeout: 15_000 });
  assert.equal(await page.locator("textarea.editor").count(), 0, `${what}: no plain editor`);
  assert.equal(await root.locator("figure").count(), 1, `${what}: the image block`);
  assert.equal(await root.locator("hr.scene-break").count(), 1, `${what}: the scene break`);
  assert.ok(!/\[\[|\*/.test(await page.locator(".visual-editor").innerText()), `${what}: nothing technical in sight`);
}

/** The version footer (novel window): which editor is mounted and the saved preference. */
async function footerDiag(page) {
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").tap();
  await page.getByRole("button", { name: "Novela, copia y exportación" }).tap();
  await page.locator(".modal-foot .build-stamp .editor-diag").waitFor();
  const text = await page.locator(".modal-foot .build-stamp").innerText();
  await page.keyboard.press("Escape");
  return text;
}

test("iPhone: the link with ?editor=visual, opened without a session, goes through the login and lands in the visual editor", async () => {
  await setText(CENTRAL);
  const ctx = await browser.newContext(IPHONE);
  contexts.add(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}?editor=visual`);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.locator("#password").fill(PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.pathname === `/novela/${novel}` && u.searchParams.get("editor") === "visual");
  await assertVisualMounted(page, "after the login");
  assert.match(await footerDiag(page), /editor visual · preferencia: visual/);
  // Remembered on this device: the novel without ?editor= (from the library) opens it again.
  await page.goto(`${BASE}/`);
  await page.getByText("Visual", { exact: true }).first().tap();
  await assertVisualMounted(page, "from the library");
});

test("iPhone: the switch in the chapter drawer turns it on, and it stays after reloading and changing chapter", async () => {
  await setText(CENTRAL);
  const other = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Otro" })).data.id;
  const { revision } = (await call(`/api/chapters/${other}`)).data;
  await call(`/api/chapters/${other}`, "PATCH", { content: CENTRAL, revision });
  const ctx = await browser.newContext(IPHONE);
  contexts.add(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  assert.match(await footerDiag(page), /editor de texto · preferencia: sin elegir/);
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").tap();
  await page.getByRole("button", { name: /Editor visual \(prueba\): no/ }).tap();
  await assertVisualMounted(page, "after the switch");
  await page.reload();
  await assertVisualMounted(page, "after reloading");
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").tap();
  await page.locator(".chapter-name", { hasText: "Otro" }).tap();
  await page.waitForFunction(() => /Otro/.test(document.querySelector(".topbar .chapter-title")?.textContent ?? ""));
  await assertVisualMounted(page, "in another chapter");
  assert.match(await footerDiag(page), /editor visual · preferencia: visual/);
  // And back to the plain editor with the same switch.
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").tap();
  await page.getByRole("button", { name: /Editor visual \(prueba\): sí/ }).tap();
  await page.locator("textarea.editor").waitFor();
  assert.equal(await page.locator(".visual-editor").count(), 0);
  await call(`/api/chapters/${other}`, "DELETE");
});
