// Character gallery in the browser (Playwright/Chromium) against the real app,
// database and in-memory Storage. Tests run in order and share one page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, png, resetDb } from "./helpers.mjs";

let browser, ctx, page, call, novel, erika, juan;
const assetRequests = [];
const dialogs = [];

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Memoria visual" })).data.id;
  const character = async (json) => (await call(`/api/novels/${novel}/memory/characters`, "POST", json)).data.id;
  erika = await character({ name: "Erika Müller", role: "Protagonista", age: "31 años", aliases: "La Alemana, Eri" });
  juan = await character({ name: "Juan", role: "Secundario" });

  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  page.on("request", (r) => r.url().includes("/api/assets/") && assetRequests.push(r.url()));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
});
after(() => browser?.close());

const gallery = async (id) => (await call(`/api/novels/${novel}`)).data.images.filter((i) => i.character_id === id);
const card = (name) => page.locator(".character-card", { hasText: name });
const thumbs = () => page.locator(".thumbs .thumb");
const viewer = () => page.locator(".viewer");
const fileInput = () => page.locator('input[type="file"][aria-label="Añadir imágenes"]');
const variants = () => assetRequests.map((u) => new URL(u).pathname.split("/").pop());

async function openMemory() {
  await page.getByRole("button", { name: "Memoria", exact: true }).click();
  await page.locator(".character-cards").waitFor();
}
async function openCharacter(name) {
  await card(name).click();
  await page.locator(".portrait").waitFor();
}
const file = (name, w, h) => ({ name, mimeType: "image/png", buffer: png(w, h) });

// ---------------------------------------------------------------- without images

test("no image: the cards show elegant initials, name, role and key facts; nothing is downloaded", async () => {
  await openMemory();
  assert.equal(await page.locator(".character-card").count(), 2);
  const e = card("Erika Müller");
  assert.equal((await e.locator(".avatar.initials").textContent()).trim(), "EM");
  assert.equal((await card("Juan").locator(".avatar.initials").textContent()).trim(), "J");
  assert.equal(await e.locator(".card-role").textContent(), "Protagonista");
  assert.equal(await e.locator(".card-facts").textContent(), "31 años · «La Alemana»");
  assert.equal(await page.locator(".character-cards img").count(), 0, "no generic placeholder image");
  const [h1, h2] = await page.locator(".avatar.initials").evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  assert.notEqual(h1, h2, "each character keeps its own tone");
  assert.deepEqual(assetRequests, []);
});

test("no image: the sheet shows the initials as its portrait and an empty Galería", async () => {
  await openCharacter("Erika Müller");
  assert.equal((await page.locator(".portrait .avatar.initials").textContent()).trim(), "EM");
  assert.ok(await page.getByText("Añadir imagen", { exact: true }).isVisible());
  assert.ok(await page.locator("summary", { hasText: "Galería" }).isVisible());
  assert.ok(await page.locator(".gallery-empty").isVisible());
  assert.equal(await thumbs().count(), 0);
});

// ---------------------------------------------------------------- upload

test("upload with the file picker: saved at once, first image is main, the original is kept", async () => {
  await fileInput().setInputFiles([file("retrato.png", 1200, 1500), file("vestido.png", 3000, 2000)]);
  await page.waitForFunction(() => document.querySelectorAll(".thumbs .thumb").length === 2, null, { timeout: 20_000 });
  assert.equal(await page.locator(".thumbs .badge").count(), 1);
  assert.equal(await thumbs().first().locator(".badge").count(), 1, "the first upload is the main image");
  const images = await gallery(erika);
  assert.equal(images.length, 2);
  assert.deepEqual(
    images.map((i) => [i.is_primary, i.asset.width, i.asset.height, i.asset.file_name]),
    [
      [true, 1200, 1500, "retrato.png"],
      [false, 3000, 2000, "vestido.png"],
    ],
    "originals kept at full size",
  );
  assert.equal(images[0].asset.derived_type, "image/webp", "derivatives made in the browser");
  // The portrait now shows the main image's thumbnail.
  assert.match(await page.locator(".portrait img").getAttribute("src"), /\/thumb\?v=1$/);
});

test("upload: no Guardar needed; closing the sheet asks nothing and the card shows the thumbnail", async () => {
  dialogs.length = 0;
  await page.getByRole("button", { name: "Volver" }).click();
  await page.locator(".character-cards").waitFor();
  assert.deepEqual(dialogs, [], "image changes never leave the sheet 'dirty'");
  const img = card("Erika Müller").locator("img");
  assert.match(await img.getAttribute("src"), /\/api\/assets\/[0-9a-f-]+\/thumb\?v=1$/);
  assert.equal(await img.getAttribute("loading"), "lazy");
  assert.equal(await card("Erika Müller").locator(".card-count").textContent(), "2 imágenes");
  assert.ok(await card("Juan").locator(".avatar.initials").isVisible(), "Juan still has no image");
});

test("drag and drop adds images to the gallery", async () => {
  await openCharacter("Erika Müller");
  const b64 = png(800, 600).toString("base64");
  const data = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "peinado.png", { type: "image/png" }));
    return dt;
  }, b64);
  const zone = page.getByTestId("gallery-dropzone");
  await zone.dispatchEvent("dragenter", { dataTransfer: data });
  await zone.dispatchEvent("drop", { dataTransfer: data });
  await page.waitForFunction(() => document.querySelectorAll(".thumbs .thumb").length === 3, null, { timeout: 20_000 });
  assert.equal((await gallery(erika)).length, 3);
});

test("unsupported files are refused with a message, nothing is uploaded", async () => {
  await fileInput().setInputFiles([{ name: "notas.txt", mimeType: "text/plain", buffer: Buffer.from("hola") }]);
  await page.locator(".gallery .error").waitFor();
  assert.match(await page.locator(".gallery .error").textContent(), /Formato no admitido/);
  assert.equal((await gallery(erika)).length, 3);
});

// ---------------------------------------------------------------- viewer

test("viewer: the enlarged display version (never the original) with its caption and stage label", async () => {
  await thumbs().nth(1).click();
  await viewer().waitFor();
  assert.equal(await viewer().locator(".viewer-count").textContent(), "2 / 3");
  const src = await viewer().locator(".viewer-stage img").getAttribute("src");
  assert.match(src, /\/display\?v=1$/);
  await page.getByLabel("Pie", { exact: true }).fill("Vestido del baile");
  await page.getByLabel("Etapa (etiqueta)", { exact: true }).fill("1982");
  await page.getByLabel("Etapa (etiqueta)", { exact: true }).press("Enter");
  await viewer().getByText("Guardado").waitFor();
  const img = (await gallery(erika))[1];
  assert.equal(img.caption, "Vestido del baile");
  assert.equal(img.stage_label, "1982");
  assert.ok(await viewer().isVisible(), "Enter saves the field without submitting the sheet");
  assert.match(await viewer().getByRole("link", { name: "Descargar original" }).getAttribute("href"), /\/original\?v=1$/);
});

test("viewer: set as main image, saved at once", async () => {
  await viewer().getByRole("button", { name: "Usar como principal" }).click();
  await viewer().locator(".primary-mark").waitFor();
  const images = await gallery(erika);
  assert.deepEqual(
    images.map((i) => i.is_primary),
    [false, true, false],
  );
  assert.match(await page.locator(".portrait img").getAttribute("alt"), /Vestido del baile/);
});

test("viewer: arrows move between images; reorder from the viewer is saved", async () => {
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".viewer-count")?.textContent === "3 / 3");
  const third = (await gallery(erika))[2].id;
  await viewer().getByRole("button", { name: "Mover antes" }).click();
  await page.waitForFunction(() => document.querySelector(".viewer-count")?.textContent === "2 / 3");
  let ids = (await gallery(erika)).map((i) => i.id);
  assert.equal(ids[1], third);
  await viewer().getByRole("button", { name: "Mover antes" }).click();
  await page.waitForFunction(() => document.querySelector(".viewer-count")?.textContent === "1 / 3");
  ids = (await gallery(erika)).map((i) => i.id);
  assert.equal(ids[0], third);
  assert.ok(await viewer().getByRole("button", { name: "Mover antes" }).isDisabled());
});

test("viewer: Escape closes the viewer, not the character sheet", async () => {
  await page.keyboard.press("Escape");
  await viewer().waitFor({ state: "detached" });
  assert.ok(await page.locator(".portrait").isVisible());
  // The grid follows the new order: the moved image first, the main one marked.
  const images = await gallery(erika);
  const order = await thumbs().evaluateAll((els) => els.map((el) => el.querySelector("img").getAttribute("src")));
  assert.deepEqual(
    order.map((src) => src.split("/")[3]),
    images.map((i) => i.asset_id),
  );
  assert.equal(await thumbs().nth(images.findIndex((i) => i.is_primary)).locator(".badge").count(), 1);
});

test("viewer: delete with confirmation; the next image becomes the main one", async () => {
  const before = await gallery(erika);
  const main = before.findIndex((i) => i.is_primary);
  await thumbs().nth(main).click();
  await viewer().waitFor();
  dialogs.length = 0;
  await viewer().getByRole("button", { name: "Eliminar" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".thumbs .thumb").length === 2);
  assert.match(dialogs[0], /Eliminar esta imagen/);
  const after = await gallery(erika);
  assert.equal(after.length, 2);
  assert.ok(!after.some((i) => i.id === before[main].id));
  assert.equal(after.filter((i) => i.is_primary).length, 1);
  await page.keyboard.press("Escape");
});

test("delete every image: back to the initials, in the sheet and on the card", async () => {
  // The viewer moves on to the next image after each deletion, and closes after the last one.
  await thumbs().first().click();
  for (let n = 2; n > 0; n--) {
    await viewer().getByRole("button", { name: "Eliminar" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".thumbs .thumb").length === n - 1, n);
  }
  await viewer().waitFor({ state: "detached" });
  assert.equal((await page.locator(".portrait .avatar.initials").textContent()).trim(), "EM");
  await page.getByRole("button", { name: "Volver" }).click();
  assert.equal((await card("Erika Müller").locator(".avatar.initials").textContent()).trim(), "EM");
  assert.equal(await card("Erika Müller").locator(".card-count").count(), 0);
});

test("only thumbnails and display versions were loaded; never an original", async () => {
  const seen = new Set(variants());
  assert.ok(seen.has("thumb") && seen.has("display"));
  assert.ok(!seen.has("original"));
});

// ---------------------------------------------------------------- limit

test("limit: with 40 images, adding is disabled and says why", async () => {
  await openCharacter("Juan");
  await fileInput().setInputFiles([file("juan.png", 400, 500)]);
  await page.waitForFunction(() => document.querySelectorAll(".thumbs .thumb").length === 1, null, { timeout: 20_000 });
  const assetId = (await gallery(juan))[0].asset_id;
  for (let i = 1; i < 40; i++) await call(`/api/characters/${juan}/images`, "POST", { asset_id: assetId });
  await page.reload();
  await page.locator("textarea.editor").waitFor();
  await openMemory();
  await openCharacter("Juan");
  assert.equal(await thumbs().count(), 40);
  assert.ok(await page.getByRole("button", { name: "Añadir imágenes" }).isDisabled());
  assert.ok(await page.getByText("Límite de 40 imágenes alcanzado.").isVisible());
  await page.keyboard.press("Escape");
});

// ---------------------------------------------------------------- mobile

test("mobile: two-column cards, full-screen viewer, nothing wider than the screen", async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await phone.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const p = await phone.newPage();
  p.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await p.goto(`${BASE}/novela/${novel}`);
  await p.locator("textarea.editor").waitFor();
  await p.getByRole("button", { name: "Memoria", exact: true }).click();
  const cards = p.locator(".character-cards");
  await cards.waitFor();
  const columns = await cards.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  assert.equal(columns, 2);
  const noOverflow = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(await noOverflow());

  await p.locator(".character-card", { hasText: "Juan" }).click();
  await p.locator(".thumbs .thumb").first().waitFor();
  const thumbColumns = await p.locator(".thumbs").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  assert.equal(thumbColumns, 3);
  assert.ok(await noOverflow());

  await p.locator(".thumbs .thumb").nth(1).click();
  const v = p.locator(".viewer");
  await v.waitFor();
  const box = await v.boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844], "full screen");
  await p.locator(".viewer-stage img").evaluate((img) => img.decode());
  const img = await p.locator(".viewer-stage img").boundingBox();
  assert.ok(img.width <= 390 && img.height > 0);
  const panel = await p.locator(".viewer-panel").boundingBox();
  assert.ok(panel.y + panel.height <= 844 + 1, "details and actions stay on screen");
  assert.ok(await p.getByRole("button", { name: "Usar como principal" }).isVisible());
  assert.ok(await noOverflow());
  await phone.close();
});
