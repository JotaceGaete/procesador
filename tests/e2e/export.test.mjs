// Exportación editorial (docs/exportacion.md): the book's data saved with the novel, copied
// when duplicating, and the three exports (DOCX manuscript, DOCX book, EPUB) downloaded from
// the interface, with the images as DOCX and EPUB carry them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, png, resetDb, textEditor } from "./helpers.mjs";

let call, cookie, browser, novel, ch1, ch2;
const s = {};

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  novel = (await call("/api/novels", "POST", { title: "La canción del puerto" })).data.id;
  ch1 = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  ch2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Capítulo 2" })).data.id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function save(chapterId, content) {
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  const r = await call(`/api/chapters/${chapterId}`, "PATCH", { content, revision });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

/** Full upload (start, signed PUT, complete) placed as a manuscript image. */
async function upload(file, type, use) {
  const start = await call(`/api/novels/${novel}/assets`, "POST", { file_name: use.name, type, bytes: file.length });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.equal((await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": type }, body: file })).status, 200);
  const form = new FormData();
  form.append("display", new Blob([png(64, 48)]));
  form.append("thumb", new Blob([png(32, 24)]));
  form.append("use", JSON.stringify({ kind: "manuscript", id: use.id, alt: use.alt ?? "" }));
  const res = await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data.manuscriptImage;
}

function unzip(buf) {
  const files = new Map();
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const data = buf.subarray(start, start + size);
    assert.equal(zlib.crc32(data), buf.readUInt32LE(at + 16), name);
    files.set(name, data);
    at += 46 + nameLen;
  }
  return files;
}

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  return { ctx, page };
}

test("API: the book's data is validated, saved with the novel and in the backup", async () => {
  const r = await call(`/api/novels/${novel}`, "PATCH", {
    book: { author: "Ana Pérez", isbn: "978-84-376-0494-7", language: "nada válido", layout: { trim: "a5", fontSize: 99 }, hack: 1 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.book.author, "Ana Pérez");
  assert.equal(r.data.book.language, "es");
  assert.equal(r.data.book.layout.trim, "a5");
  assert.equal(r.data.book.layout.fontSize, 16);
  assert.equal(r.data.book.hack, undefined);
  const { novel: n } = (await call(`/api/novels/${novel}`)).data;
  assert.equal(n.book.isbn, "978-84-376-0494-7");
  assert.equal((await call(`/api/novels/${novel}/backup`)).data.novel.book.author, "Ana Pérez");
});

test("API: a new novel has a complete, empty book", async () => {
  const other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  const { book } = (await call(`/api/novels/${other}`)).data.novel;
  assert.equal(book.author, "");
  assert.equal(book.coverAssetId, null);
  assert.equal(book.layout.trim, "6x9");
});

test("setup: chapters with italics, a scene break and two images (one PNG, one WebP made in the browser)", async () => {
  s.m1 = crypto.randomUUID();
  s.m2 = crypto.randomUUID();
  await save(ch1, `Elena leyó *Rayuela* de un tirón.\n\nSegundo párrafo.\n\n[[separador]]\n\nOtra escena.\n\n[[imagen:${s.m1}]]\n\nDespués.`);
  await save(ch2, `Un mapa.\n\n[[imagen:${s.m2}]]\n\nFin.`);
  s.png = await upload(png(800, 600), "image/png", { id: s.m1, name: "puerto.png", alt: "El puerto al amanecer" });

  const { ctx, page } = await open();
  const webp = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#336";
    g.fillRect(0, 0, 600, 900);
    const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await ctx.close();
  s.webp = await upload(Buffer.from(webp), "image/webp", { id: s.m2, name: "mapa.webp" });
  assert.deepEqual([s.webp.asset.width, s.webp.asset.height], [600, 900]);
});

test("interface: the Libro tab saves the data, shows the checks, and downloads the three exports", async () => {
  const { ctx, page } = await open();
  await page.locator(".topbar .title").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Libro", exact: true }).click();
  await dialog.getByLabel("Subtítulo").fill("Una novela");
  await dialog.getByLabel("ISBN").fill("978-84-376-0494-8");
  await dialog.getByText("El dígito de control del ISBN-13 no cuadra.").first().waitFor();
  await dialog.getByLabel("ISBN").fill("978-84-376-0494-7");
  await dialog.getByLabel("Dedicatoria").fill("A mi madre.");
  await dialog.getByLabel("Portada (EPUB)").selectOption({ label: "puerto.png (800 × 600)" });
  await dialog.getByText("Página del libro impreso").click();
  await dialog.getByLabel("Tamaño de página").selectOption("6x9");

  // The checks: never blocking.
  const checks = dialog.getByRole("list", { name: "Antes de exportar" });
  await checks.getByText(/«mapa\.webp» no tiene texto alternativo/).waitFor();
  assert.equal(await checks.getByText(/ISBN/).count(), 0);
  await dialog.getByText(/2 capítulos, ≈ \d+ palabras, 2 imágenes/).waitFor();

  const get = async (label) => {
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: label }).click()]);
    await dialog.getByText(/^Descargado: /).waitFor();
    // E2E_EXPORT_DIR keeps the files, to open them or check them with epubcheck and LibreOffice.
    if (process.env.E2E_EXPORT_DIR) await download.saveAs(`${process.env.E2E_EXPORT_DIR}/${download.suggestedFilename()}`);
    return { name: download.suggestedFilename(), files: unzip(fs.readFileSync(await download.path())) };
  };

  const man = await get("DOCX · Manuscrito");
  assert.equal(man.name, "La cancion del puerto - manuscrito.docx");
  const manDoc = man.files.get("word/document.xml").toString();
  assert.match(manDoc, /<w:pgSz w:w="11906" w:h="16838"\/>/, "A4");
  assert.match(manDoc, /<w:i\/><\/w:rPr><w:t xml:space="preserve">Rayuela<\/w:t>/);
  assert.match(man.files.get("word/headerodd.xml").toString(), /Pérez \/ LA CANCIÓN DEL PUERTO \//);

  const lib = await get("DOCX · Libro");
  assert.equal(lib.name, "La cancion del puerto - libro.docx");
  const libDoc = lib.files.get("word/document.xml").toString();
  assert.match(libDoc, /<w:pgSz w:w="8640" w:h="12960"\/>/, "6 × 9 in, chosen in the tab before saving");
  assert.match(libDoc, /A mi madre\./);
  assert.match(libDoc, /ISBN: 978-84-376-0494-7/);
  const media = [...lib.files.keys()].filter((k) => k.startsWith("word/media/")).sort();
  assert.deepEqual(media, ["word/media/image1.png", "word/media/image2.jpeg"], "the PNG as uploaded, the WebP as JPEG");
  const jpeg = lib.files.get("word/media/image2.jpeg");
  assert.equal(jpeg.readUInt16BE(0), 0xffd8, "a real JPEG");
  assert.ok(lib.files.get("word/media/image1.png").equals(png(800, 600)), "byte for byte");

  const book = await get("EPUB");
  assert.equal(book.name, "La cancion del puerto - libro.epub");
  assert.equal(book.files.get("mimetype").toString(), "application/epub+zip");
  const opf = book.files.get("OEBPS/content.opf").toString();
  assert.match(opf, /urn:isbn:9788437604947/);
  assert.match(opf, /<dc:creator>Ana Pérez<\/dc:creator>/);
  assert.match(opf, /<dc:title>La canción del puerto<\/dc:title>/);
  assert.match(opf, /href="images\/image1\.png" media-type="image\/png" properties="cover-image"/);
  assert.match(opf, /href="images\/image2\.jpg" media-type="image\/jpeg"/);
  assert.match(book.files.get("OEBPS/chapter-001.xhtml").toString(), /alt="El puerto al amanecer"/);

  // Saved with «Guardar», with the rest of the novel.
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await dialog.waitFor({ state: "detached" });
  const saved = (await call(`/api/novels/${novel}`)).data.novel.book;
  assert.deepEqual([saved.subtitle, saved.dedication, saved.coverAssetId, saved.layout.trim], ["Una novela", "A mi madre.", s.png.asset_id, "6x9"]);
  await ctx.close();
});

test("duplicating the novel copies the book, with the cover pointing to the copy's file", async () => {
  const r = await call(`/api/novels/${novel}/duplicate`, "POST", { title: "Copia" });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data));
  const copy = (await call(`/api/novels/${r.data.id}`)).data;
  assert.equal(copy.novel.book.isbn, "978-84-376-0494-7");
  assert.notEqual(copy.novel.book.coverAssetId, s.png.asset_id);
  const coverUse = copy.manuscriptImages.find((m) => m.asset_id === copy.novel.book.coverAssetId);
  assert.ok(coverUse, "the cover is the copy's own file");
});

test("mobile: the Libro tab fits and exports", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  // The title is hidden on a phone: the novel opens from the chapter list.
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: "Novela, copia y exportación" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Libro", exact: true }).click();
  const button = dialog.getByRole("button", { name: "EPUB" });
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "inside the screen");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal scroll");
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  assert.match(download.suggestedFilename(), /\.epub$/);
  await ctx.close();
});
