// Images of the book in the browser (Playwright/Chromium) against the real app,
// database, in-memory Storage and mock AI. Tests run in order and share one page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, client, login, png, resetDb, textEditor } from "./helpers.mjs";

let browser, ctx, page, call, cookie, novel, chapterId, erika, galleryAsset;

const MARKER = /\[\[imagen:([0-9a-f-]{36})\]\]/g;
const editor = () => page.locator("textarea.editor");
const card = () => page.locator(".image-card");
const markers = async () => [...(await editor().inputValue()).matchAll(MARKER)].map((m) => m[1]);
const book = async () => (await call(`/api/novels/${novel}`)).data;
const storedFiles = async () =>
  (await (await fetch(`${STACK}/__storage`)).json()).keys.filter((k) => k.startsWith(`novel-files/${novel}/`)).length;
const savedState = () =>
  page.waitForFunction(() => document.querySelector(".save")?.textContent === "Guardado", null, { timeout: 15_000 });
const file = (name, w, h) => ({ name, mimeType: "image/png", buffer: png(w, h) });
/** Polls the server until a condition holds (autosave runs a moment after typing). */
async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail("condition not met in time");
}
const imageNow = async (id) => (await book()).manuscriptImages.find((i) => i.id === id);
const b64 = (w, h) => png(w, h).toString("base64");

async function openPanel() {
  await page.getByRole("button", { name: "Imágenes", exact: true }).click();
  await page.getByRole("dialog", { name: "Imágenes del capítulo" }).waitFor();
}
async function goTo(index) {
  await openPanel();
  await page.locator(".chapter-images").first().getByRole("button", { name: "Ir" }).nth(index).click();
  // The cursor moves onto the image on the next frame: wait for the text to have it.
  await page.waitForFunction(() => document.activeElement?.matches("textarea.editor"));
  await card().waitFor();
}
async function cursorAtEnd() {
  await editor().evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}
/** Waits until every marker in the text has finished uploading (its card shows a thumbnail). */
const uploaded = (n) =>
  page.waitForFunction(
    (n) => document.querySelectorAll(".image-card-thumb").length > 0 && [...document.querySelector("textarea.editor").value.matchAll(/\[\[imagen:/g)].length === n,
    n,
    { timeout: 20_000 },
  );

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  novel = (await call("/api/novels", "POST", { title: "El puerto" })).data.id;
  chapterId = (await book()).chapters[0].id;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: "Primer párrafo.\n\nSegundo párrafo.", revision: 0 });
  erika = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Erika" })).data.id;
  // A gallery image for Erika, through the real upload flow.
  const ref = png(1200, 1500);
  const start = await call(`/api/novels/${novel}/assets`, "POST", { type: "image/png", bytes: ref.length });
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: ref });
  const form = new FormData();
  form.append("display", new Blob([png(60, 75)]));
  form.append("thumb", new Blob([png(30, 37)]));
  form.append("use", JSON.stringify({ kind: "character", character_id: erika }));
  const done = await (await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form })).json();
  galleryAsset = done.asset_id;

  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  await editor().waitFor();
});
after(() => browser?.close());

// ---------------------------------------------------------------- insert

test("insert with the button: the marker goes in at the cursor, the card opens, the image uploads", async () => {
  await cursorAtEnd();
  await openPanel();
  await page.locator('input[aria-label="Añadir imágenes al capítulo"]').setInputFiles([file("plano.png", 1600, 1000)]);
  await uploaded(1);
  const text = await editor().inputValue();
  assert.match(text, /^Primer párrafo\.\n\nSegundo párrafo\.\n\n\[\[imagen:[0-9a-f-]{36}\]\]$/, "its own paragraph, at the cursor");
  await until(async () => (await book()).manuscriptImages[0]?.chapter_id === chapterId);
  const [img] = (await book()).manuscriptImages;
  assert.equal(img.id, (await markers())[0]);
  assert.equal(img.chapter_id, chapterId);
  assert.equal(img.asset.width, 1600, "the original's size");
});

test("word count leaves markers out", async () => {
  await page.waitForFunction(() => document.querySelector(".words")?.textContent === "4 palabras");
});

test("card: alt text independent of the caption; decorative needs none; layout and width; resolution", async () => {
  await page.getByLabel(/^Texto alternativo/).fill("Plano de la casa");
  await page.getByLabel("Pie", { exact: true }).fill("La casa en 1972");
  await page.getByLabel("Crédito", { exact: true }).fill("Archivo familiar");
  await page.getByLabel("Crédito", { exact: true }).press("Enter");
  await card().locator('label:has(> span:text-is("Ancho")) select').selectOption("50");
  await card().getByText("Guardado").waitFor();
  let [img] = (await book()).manuscriptImages;
  assert.deepEqual([img.alt, img.caption, img.credit, img.width_pct], ["Plano de la casa", "La casa en 1972", "Archivo familiar", 50]);
  assert.match(await card().locator(".resolution").textContent(), /a 50 % de la caja de texto .* se imprimiría a 677 ppp/);

  await page.getByLabel(/Decorativa/).check();
  await page.waitForFunction(() => document.querySelector(".image-card-fields input")?.disabled === true);
  [img] = (await book()).manuscriptImages;
  assert.equal(img.decorative, true);
  await page.getByLabel(/Decorativa/).uncheck();
  await page.waitForFunction(() => document.querySelector(".image-card-fields input")?.disabled === false);
});

test("typing on an image's line starts a new paragraph instead of breaking the marker", async () => {
  await goTo(0);
  await page.keyboard.type("Nuevo");
  const text = await editor().inputValue();
  assert.match(text, /\]\]\n\nNuevo$/);
  assert.equal((await markers()).length, 1);
  for (let i = 0; i < 7; i++) await page.keyboard.press("Backspace");
  assert.match(await editor().inputValue(), /\]\]$/);
});

test("paste an image into the text", async () => {
  await cursorAtEnd();
  await editor().evaluate((el, data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "pegada.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64(800, 800));
  await uploaded(2);
  assert.equal((await markers()).length, 2);
});

test("drop an image onto the text", async () => {
  await cursorAtEnd();
  const dt = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], "arrastrada.png", { type: "image/png" }));
    return dt;
  }, b64(700, 500));
  await editor().dispatchEvent("dragover", { dataTransfer: dt });
  await editor().dispatchEvent("drop", { dataTransfer: dt });
  await uploaded(3);
  await until(async () => (await book()).manuscriptImages.filter((i) => i.chapter_id === chapterId).length === 3);
  const imgs = (await book()).manuscriptImages;
  assert.equal(imgs.length, 3);
  assert.ok(imgs.every((i) => i.chapter_id === chapterId));
});

// ---------------------------------------------------------------- remove, recover

test("remove from the chapter: kept, not placed; Ctrl+Z brings it back", async () => {
  const first = (await markers())[0];
  await goTo(0);
  await card().getByRole("button", { name: "Quitar del capítulo" }).click();
  assert.ok(!(await markers()).includes(first));
  await page.keyboard.press("Control+z");
  assert.ok((await markers()).includes(first));
});

test("remove, then recover from 'Sin colocar' with everything it had", async () => {
  const first = (await markers())[0];
  await goTo(0);
  await card().getByRole("button", { name: "Quitar del capítulo" }).click();
  await until(async () => (await imageNow(first)).chapter_id === null);
  await openPanel();
  const unplaced = page.locator(".chapter-images").nth(1);
  assert.match(await unplaced.textContent(), /La casa en 1972/);
  await unplaced.getByRole("button", { name: "Insertar aquí" }).click();
  assert.ok((await markers()).includes(first));
  await until(async () => (await imageNow(first)).chapter_id === chapterId);
  const img = await imageNow(first);
  assert.equal(img.credit, "Archivo familiar");
});

// ---------------------------------------------------------------- reading view

test("reading view: the chapter with its real images, caption and credit apart, width", async () => {
  await page.getByRole("button", { name: "Lectura", exact: true }).click();
  const figs = page.locator(".reading figure");
  assert.equal(await figs.count(), 3);
  assert.ok(!(await editor().isVisible()), "the text stays mounted but hidden");
  const plano = page.locator(".reading figure", { hasText: "La casa en 1972" });
  assert.match(await plano.locator("img").getAttribute("src"), /\/display\?v=1$/, "interface copy, not the original");
  assert.equal(await plano.locator(".fig-caption").textContent(), "La casa en 1972");
  assert.equal(await plano.locator(".fig-credit").textContent(), "Archivo familiar");
  assert.equal(await plano.evaluate((el) => el.style.width), "50%");
  assert.equal(await plano.locator("img").getAttribute("alt"), "Plano de la casa");
  assert.deepEqual(await page.locator(".reading p").allInnerTexts(), ["Primer párrafo.", "Segundo párrafo."]);
  await plano.locator("button").click();
  await card().waitFor();
  assert.ok(await editor().isVisible());
});

// ---------------------------------------------------------------- reuse & sharing

test("insert from a gallery: the same file, no copy stored", async () => {
  const files = await storedFiles();
  await cursorAtEnd();
  await openPanel();
  await page.getByRole("button", { name: "Desde las galerías" }).click();
  await page.locator(".thumbs.pick .thumb").first().click();
  await card().locator(".image-card-thumb").waitFor();
  assert.equal((await markers()).length, 4);
  assert.equal(await storedFiles(), files);
  const id = (await markers()).at(-1);
  const img = (await book()).manuscriptImages.find((i) => i.id === id);
  assert.equal(img.asset_id, galleryAsset);
});

test("shared file: the card asks where to replace; 'only this image' leaves the gallery's file", async () => {
  await card().getByRole("button", { name: "Reemplazar archivo…" }).click();
  const choice = card().locator(".replace-choice");
  await choice.waitFor();
  assert.match(await choice.textContent(), /Galería de Erika/);
  await choice.getByRole("button", { name: "Sólo en esta imagen" }).click();
  await page.locator('.image-card input[aria-label="Archivo de reemplazo"]').setInputFiles([file("retrato-libro.png", 1000, 1400)]);
  await card().getByText("Imagen reemplazada").waitFor({ timeout: 20_000 });
  const data = await book();
  const id = (await markers()).at(-1);
  assert.notEqual(data.manuscriptImages.find((i) => i.id === id).asset_id, galleryAsset);
  assert.equal(data.images.find((g) => g.character_id === erika).asset_id, galleryAsset);
});

// ---------------------------------------------------------------- assistant

/** From the last image to the end: one image and the paragraph after it. */
async function selectFromLastMarker() {
  await editor().evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.lastIndexOf("[[imagen:"), el.value.length);
  });
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowRight");
}

test("assistant: a rewrite keeps the images (restored from [IMAGEN n])", async () => {
  await cursorAtEnd();
  await page.keyboard.type("\n\nUn párrafo MANTEN-IMAGENES.");
  const before = await markers();
  if (!(await page.locator(".panel").isVisible())) await page.getByRole("button", { name: "Asistente" }).click();
  await page.getByRole("button", { name: "Editar selección" }).click();
  await selectFromLastMarker();
  await page.getByRole("button", { name: "Proponer cambios" }).click();
  await page.getByRole("button", { name: "Reemplazar selección" }).click();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  const text = await editor().inputValue();
  assert.match(text, new RegExp(`Primero la imagen\\.\\n\\n\\[\\[imagen:${before.at(-1)}\\]\\]\\n\\nY el texto reescrito\\.`));
  assert.deepEqual(new Set(await markers()), new Set(before), "every image still in the text");
  assert.ok(!text.includes("[IMAGEN"), "no placeholders left in the manuscript");
});

test("assistant: a rewrite that drops an image is not applied without asking", async () => {
  const before = await markers();
  await selectFromLastMarker();
  await page.getByRole("button", { name: "Proponer cambios" }).click();
  await page.getByRole("button", { name: "Reemplazar selección" }).click();
  await page.locator(".lost-images").waitFor();
  assert.deepEqual(await markers(), before, "nothing applied yet");
  await page.getByRole("button", { name: "Aplicar y colocar la imagen al final" }).click();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  const text = await editor().inputValue();
  assert.match(text, /Texto propuesto por el modelo\.\n\n\[\[imagen:/);
  assert.deepEqual(await markers(), before, "the image is still in the text");
});

// ---------------------------------------------------------------- mobile

test("mobile: every action reachable, card as a bottom sheet, reading view fits", async () => {
  await savedState();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await textEditor(phone);
  await phone.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const p = await phone.newPage();
  p.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await p.goto(`${BASE}/novela/${novel}`);
  await p.locator("textarea.editor").waitFor();
  const fits = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  for (const name of ["Imágenes", "Lectura", "Memoria", "Asistente"]) {
    assert.ok(await p.getByRole("button", { name, exact: true }).isVisible(), name);
  }
  assert.ok(await p.locator(".chapter-title").isVisible());
  assert.ok(await fits());

  await p.getByRole("button", { name: "Imágenes", exact: true }).click();
  await p.locator(".chapter-images").first().getByRole("button", { name: "Ir" }).first().click();
  const sheet = p.locator(".image-card");
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  assert.equal(Math.round(box.width), 390);
  assert.ok(Math.round(box.y + box.height) <= 844);
  assert.ok(await fits());

  await p.getByRole("button", { name: "Lectura", exact: true }).click();
  await p.locator(".reading figure img").first().waitFor();
  for (const fig of await p.locator(".reading figure").all()) {
    const b = await fig.boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390, "figures within the screen");
  }
  assert.ok(await fits());
  await phone.close();
});
