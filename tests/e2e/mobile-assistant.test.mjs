// The Asistente on a phone: real mobile emulation (isMobile, touch, device pixel ratio),
// at the widths of today's phones, with taps instead of clicks. Layout measurements, and
// the cycle generar → revisar → insertar/reemplazar → limpiar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb } from "./helpers.mjs";

const PHONES = [
  { name: "360 × 740", width: 360, height: 740 },
  { name: "390 × 844", width: 390, height: 844 },
  { name: "430 × 932", width: 430, height: 932 },
];
const TEXT = Array.from({ length: 14 }, (_, i) => `Párrafo ${i}: Elena miró por la ventana mientras la lluvia caía sobre el puerto.`).join("\n\n");
const REWRITE = "Texto propuesto por el modelo.";

let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "En el teléfono" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena" });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function phone({ width, height }, init) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  // Fresh text for each phone, at revision whatever it is now.
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: TEXT, revision });
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  return { ctx, page, editor: page.locator("textarea.editor"), panel: page.locator("aside.panel") };
}
const openAssistant = async (page) => {
  await page.getByRole("button", { name: "Asistente", exact: true }).first().tap();
  await page.locator("aside.panel").waitFor();
};
async function select(page, editor, start, end) {
  await editor.evaluate((el, [a, b]) => {
    el.focus();
    el.setSelectionRange(a, b);
  }, [start, end]);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
}
const box = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, height: r.height, left: r.left };
});
const px = (loc, prop) => loc.evaluate((el, p) => parseFloat(getComputedStyle(el)[p]), prop);

// ---------------------------------------------------------------- layout

for (const size of PHONES) {
  test(`${size.name}: a compact sheet; the manuscript stays the main thing on screen`, async () => {
    const { ctx, page, editor, panel } = await phone(size);
    await openAssistant(page);
    await select(page, editor, 0, 60);
    const sheet = await box(panel);
    assert.ok(sheet.height <= size.height * 0.6 + 1, `sheet ${sheet.height}px of ${size.height}`);
    assert.ok(sheet.top >= size.height * 0.4 - 1, "at least 40 % of the screen is manuscript");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll");

    // Character and model share a row.
    const character = await box(panel.getByRole("combobox").nth(0));
    const model = await box(panel.getByRole("combobox").nth(1));
    assert.ok(Math.abs(character.top - model.top) < 2 && model.left > character.left, "Personaje y Modelo en una fila");
    // Smaller controls, readable text; fields at 16 px so iOS doesn't zoom on focus.
    assert.equal(await px(panel.locator(".tabs button").first(), "fontSize"), 13);
    assert.equal(await px(panel.locator(".actions button").first(), "fontSize"), 13);
    assert.equal(await px(panel.getByRole("combobox").first(), "fontSize"), 16);
    assert.equal(await px(panel.getByRole("button", { name: "Proponer cambios" }), "fontSize"), 14);
    assert.ok((await box(panel.getByRole("button", { name: "Proponer cambios" }))).height >= 32, "a comfortable tap target");
    // The selected fragment is shown, never squeezed to a sliver.
    assert.ok((await box(panel.locator("blockquote.quote"))).height > 18);

    // The answer: 14 px text, 15 px for the proposal; the sheet scrolls to it.
    await panel.getByRole("button", { name: "Proponer cambios" }).tap();
    await panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();
    assert.equal(await px(panel.locator(".result"), "fontSize"), 14);
    // The comparison before applying (docs/asistente-contexto.md §9): prose at 15 px.
    assert.equal(await px(panel.locator(".compare .diff").last(), "fontSize"), 15);
    const result = await box(panel.locator(".result"));
    const sheetNow = await box(panel);
    assert.ok(result.top >= sheetNow.top && result.top < sheetNow.top + 80, `the answer at the top of the sheet (${result.top - sheetNow.top}px), not below the controls`);
    assert.ok((await box(panel.locator("blockquote.quote"))).height > 18, "the fragment keeps its size with an answer below");
    // While it scrolls, the header (and Ocultar) stays reachable.
    await panel.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const hide = await box(panel.getByRole("button", { name: "Ocultar" }));
    assert.ok(hide.top >= (await box(panel)).top - 1, "Ocultar visible");
    // The page itself doesn't scroll under the sheet.
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).overscrollBehaviorY), "contain");
    assert.equal(await px(page.locator(".argument textarea").or(page.locator("textarea.editor")).last(), "fontSize") >= 16, true);
    await ctx.close();
  });
}

test("390: the on-screen keyboard (iOS visualViewport) never covers the sheet", async () => {
  // A stand-in for iOS's visualViewport: the keyboard takes the bottom 340 px.
  const { ctx, page, panel } = await phone(PHONES[1], () => {
    const vv = new EventTarget();
    Object.assign(vv, { height: window.innerHeight, offsetTop: 0, width: window.innerWidth, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv });
    window.__keyboard = (h) => {
      vv.height = window.innerHeight - h;
      vv.dispatchEvent(new Event("resize"));
    };
  });
  await openAssistant(page);
  await panel.getByRole("button", { name: "Escribir escena" }).tap();
  const argument = page.getByPlaceholder(/Qué ocurre en la escena/);
  assert.equal(await px(argument, "fontSize"), 16, "no zoom when it gets the focus");
  await argument.tap();
  await page.evaluate(() => window.__keyboard(340));
  await page.waitForTimeout(50);
  const sheet = await box(panel);
  const visible = 844 - 340;
  assert.ok(sheet.bottom <= visible + 1, `sheet bottom ${sheet.bottom} above the keyboard (${visible})`);
  assert.ok(sheet.top >= 0, "and fits in what is left");
  await page.evaluate(() => window.__keyboard(0));
  await page.waitForTimeout(50);
  assert.ok((await box(panel)).bottom >= 843, "back down when the keyboard goes");
  await ctx.close();
});

// ---------------------------------------------------------------- generar → revisar → usar → limpiar

test("390: Reemplazar → the proposal leaves, the sheet closes, the cursor ends the new text; Deshacer restores", async () => {
  const { ctx, page, editor, panel } = await phone(PHONES[1]);
  await openAssistant(page);
  const first = TEXT.indexOf("\n\n");
  await select(page, editor, 0, first);
  await panel.getByRole("button", { name: "Proponer cambios" }).tap();
  await panel.getByRole("button", { name: "Reemplazar selección" }).tap();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).

  assert.ok((await editor.inputValue()).startsWith(`${REWRITE}\n\nPárrafo 1`));
  assert.ok(!(await panel.isVisible()), "the sheet closes: the manuscript is in view");
  assert.deepEqual(
    await editor.evaluate((el) => [document.activeElement === el, el.selectionStart, el.selectionEnd]),
    [true, REWRITE.length, REWRITE.length],
    "focus in the manuscript, cursor right after the new text",
  );
  const toast = page.locator(".editor-notice.applied");
  assert.match(await toast.innerText(), /Reemplazado en el manuscrito\. Deshacer/);
  assert.ok(!(await toast.locator(".kbd-hint").isVisible()), "no keyboard shortcut hint on a phone");
  // The confirmation sits at the bottom: not over the line where the cursor is, nor the top bar.
  const t = await box(toast);
  assert.ok(t.top > (await box(page.locator(".topbar"))).bottom && t.bottom <= 844 - 12 + 1);
  // Reopened, the Asistente has no leftover proposal.
  await openAssistant(page);
  assert.equal(await panel.locator(".result").count(), 0);
  // Deshacer: the same undo history as Ctrl/⌘+Z.
  await toast.getByRole("button", { name: "Deshacer" }).tap();
  assert.equal(await editor.inputValue(), TEXT);
  await ctx.close();
});

test("360: Insertar una escena → cursor at the end of the scene, ready to keep writing; Ctrl+Z still undoes it", async () => {
  // (Ctrl+Z here stands for whatever undo the phone's keyboard offers: the same history.)
  const { ctx, page, editor, panel } = await phone(PHONES[0]);
  await editor.evaluate((el) => {
    el.focus();
    const at = el.value.indexOf("\n\nPárrafo 3");
    el.setSelectionRange(at, at);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  await openAssistant(page);
  await panel.getByRole("button", { name: "Escribir escena" }).tap();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
  // Deliberately at the cursor (docs/asistente-contexto.md §11): the position is fixed now.
  await panel.getByRole("radio", { name: "En el cursor" }).tap();
  await panel.getByRole("button", { name: "Desarrollar escena" }).tap();
  await panel.getByRole("button", { name: "Insertar en el cursor", exact: true }).tap();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  const value = await editor.inputValue();
  const end = value.indexOf("—dijo él.") + "—dijo él.".length;
  assert.ok(value.slice(end).startsWith("\n\nPárrafo 3"), "the scene in its own paragraphs, before the next one");
  assert.deepEqual(await editor.evaluate((el) => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, end, end]);
  assert.ok(!(await panel.isVisible()));
  // Clearing the card left the undo history intact: undo, redo.
  await page.keyboard.press("Control+z");
  assert.equal(await editor.inputValue(), TEXT);
  await page.keyboard.press("Control+Shift+z");
  assert.equal(await editor.inputValue(), value);
  // And the author keeps writing right where the scene ends.
  await editor.evaluate((el, at) => el.setSelectionRange(at, at), end);
  await page.keyboard.type(" Y siguió escribiendo.");
  assert.ok((await editor.inputValue()).includes("—dijo él. Y siguió escribiendo.\n\nPárrafo 3"));
  await ctx.close();
});

test("430: if Reemplazar fails, the proposal stays (with the reason); Limpiar clears it by hand", async () => {
  const { ctx, page, editor, panel } = await phone(PHONES[2]);
  await openAssistant(page);
  await select(page, editor, 0, 40);
  await panel.getByRole("button", { name: "Proponer cambios" }).tap();
  await panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();
  // The original fragment disappears from the text before using the proposal.
  await editor.evaluate((el) => {
    el.focus();
    el.select();
  });
  await page.keyboard.type("Otro texto completamente distinto.");
  await panel.getByRole("button", { name: "Reemplazar selección" }).tap();
  await panel.getByText("El fragmento original ya no está en el texto").waitFor();
  assert.ok(await panel.locator(".compare").isVisible(), "the proposal is still there to copy");
  assert.equal(await editor.inputValue(), "Otro texto completamente distinto.");
  await panel.getByRole("button", { name: "Limpiar" }).tap();
  assert.equal(await panel.locator(".result").count(), 0);
  assert.ok(await panel.isVisible(), "Limpiar doesn't close the sheet");
  await ctx.close();
});

test("390: two pending proposals: using one never clears the other", async () => {
  const { ctx, page, editor, panel } = await phone(PHONES[1]);
  await openAssistant(page);
  await select(page, editor, 0, 40);
  await panel.getByRole("button", { name: "Proponer cambios" }).tap();
  await panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();

  // A scene in the other tab, used.
  await panel.getByRole("button", { name: "Escribir escena" }).tap();
  assert.equal(await panel.locator(".result").count(), 0, "each tab shows its own");
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).tap();
  await panel.getByRole("button", { name: "Insertar al final" }).tap();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  assert.ok((await editor.inputValue()).includes("Juan dejó las llaves"));

  // The rewrite, never used, is still waiting.
  await openAssistant(page);
  await panel.getByRole("button", { name: "Editar selección" }).tap();
  assert.ok(await panel.getByRole("button", { name: "Reemplazar selección" }).isVisible());
  await panel.getByRole("button", { name: "Escribir escena" }).tap();
  assert.equal(await panel.locator(".result").count(), 0, "the used scene is gone");
  // Limpiar in one tab leaves the other alone.
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Otra escena.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).tap();
  await panel.getByRole("button", { name: "Insertar al final" }).waitFor();
  await panel.getByRole("button", { name: "Editar selección" }).tap();
  await panel.getByRole("button", { name: "Limpiar" }).tap();
  await panel.getByRole("button", { name: "Escribir escena" }).tap();
  assert.ok(await panel.getByRole("button", { name: "Insertar al final" }).isVisible());
  await ctx.close();
});
