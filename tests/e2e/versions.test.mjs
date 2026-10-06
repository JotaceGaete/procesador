// Versiones, papelera y copia de seguridad (docs/versiones.md): what the database keeps on
// its own, what the app keeps before replacing text (IA, restaurar, «Conservar la mía»),
// deleted chapters that come back with their history, and the backup ZIP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import fs from "node:fs";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb } from "./helpers.mjs";

let call, browser, novel, ch1;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Versiones" })).data.id;
  ch1 = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function setText(id, content) {
  const { revision } = (await call(`/api/chapters/${id}`)).data;
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  assert.equal(r.status, 200);
}
const versions = async (id) => (await call(`/api/chapters/${id}/versions`)).data;
const version = async (id) => (await call(`/api/versions/${id}`)).data;

test("API: the text before an edit is kept on its own; versions on demand, without repeats", async () => {
  await setText(ch1, "Primer texto.");
  assert.equal((await versions(ch1)).length, 0, "an empty chapter leaves no version");
  await setText(ch1, "Segundo texto.");
  const [auto] = await versions(ch1);
  assert.equal(auto.reason, "auto");
  assert.equal((await version(auto.id)).content, "Primer texto.");
  await setText(ch1, "Tercer texto.");
  assert.equal((await versions(ch1)).length, 1, "at most one automatic copy every half hour");

  const a = await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "ai", content: "Antes de la IA." });
  assert.equal(a.status, 201);
  const again = await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "ai", content: "Antes de la IA." });
  assert.equal(again.data.id, a.data.id, "the same text is not repeated");
  const manual = await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "manual", label: "Primer borrador" });
  const list = await versions(ch1);
  assert.deepEqual(list.map((v) => v.reason), ["manual", "ai", "auto"], "newest first");
  assert.equal(list[0].label, "Primer borrador");
  assert.equal((await version(manual.data.id)).content, "Tercer texto.", "without text: the saved one");
  assert.equal(list[0].content, undefined, "the list doesn't carry the texts");

  assert.equal((await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "auto" })).status, 400);
  assert.equal((await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "delete" })).status, 400);
  assert.equal((await call(`/api/versions/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test("API: before «Conservar la mía» the other device's text is kept", async () => {
  const live = (await call(`/api/chapters/${ch1}`)).data;
  await call(`/api/chapters/${ch1}`, "PATCH", { content: "Texto de otro dispositivo.", revision: live.revision });
  assert.equal((await call(`/api/chapters/${ch1}`, "PATCH", { content: "Mío.", revision: live.revision })).status, 409);
  await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "conflict" });
  const [kept] = await versions(ch1);
  assert.equal(kept.reason, "conflict");
  assert.equal((await version(kept.id)).content, "Texto de otro dispositivo.");
});

test("API: a deleted chapter goes to the trash and comes back at the end, with its history", async () => {
  const ch2 = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "La huida" })).data.id;
  await setText(ch2, "Huyeron de noche.");
  await call(`/api/chapters/${ch2}/versions`, "POST", { reason: "manual", label: "Antes de cortar" });
  assert.equal((await call(`/api/chapters/${ch2}`, "DELETE")).status, 204);
  assert.equal((await call(`/api/chapters/${ch2}`)).status, 404);
  const trash = (await call(`/api/novels/${novel}/trash`)).data;
  assert.equal(trash.length, 1);
  assert.equal(trash[0].title, "La huida");
  assert.equal(trash[0].words, 3);

  const back = await call(`/api/novels/${novel}/trash`, "POST", { sourceId: trash[0].source_chapter_id });
  assert.equal(back.status, 201);
  assert.equal(back.data.chapters.at(-1).id, back.data.id, "at the end");
  assert.equal((await call(`/api/chapters/${back.data.id}`)).data.content, "Huyeron de noche.");
  assert.deepEqual((await versions(back.data.id)).map((v) => v.reason), ["delete", "manual"]);
  assert.equal((await call(`/api/novels/${novel}/trash`)).data.length, 0);
  assert.equal((await call(`/api/novels/${novel}/trash`, "POST", { sourceId: trash[0].source_chapter_id })).status, 404);

  // The last chapter stays.
  const other = await client(await login())("/api/novels", "POST", { title: "Sola" });
  const only = (await call(`/api/novels/${other.data.id}`)).data.chapters[0].id;
  const r = await call(`/api/chapters/${only}`, "DELETE");
  assert.equal(r.status, 400);
  assert.match(r.data.error, /al menos un capítulo/);
  await call(`/api/novels/${other.data.id}`, "DELETE");
});

test("API: the backup carries the novel, its chapters and its memory", async () => {
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena" });
  const b = (await call(`/api/novels/${novel}/backup`)).data;
  assert.equal(b.format, "procesador-backup");
  assert.equal(b.novel.title, "Versiones");
  assert.deepEqual(b.chapters.map((c) => c.title), ["Capítulo 1", "La huida"]);
  assert.equal(b.memory.characters[0].name, "Elena");
  assert.deepEqual(b.images.files, []);
});

// ---------------------------------------------------------------- interface

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  return { ctx, page, editor };
}

const saved = async (id, expected) => {
  for (let i = 0; i < 60 && (await call(`/api/chapters/${id}`)).data.content !== expected; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(`/api/chapters/${id}`)).data.content, expected);
};

async function openNav(page) {
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
}

test("interface: save a named version, compare it, restore it, and undo the restore", async () => {
  await setText(ch1, "La casa era azul.");
  const { ctx, page, editor } = await open();
  await openNav(page);
  await page.getByRole("button", { name: "Versiones de este capítulo" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nombre de la versión").fill("Primer borrador");
  await dialog.getByRole("button", { name: "Guardar versión actual" }).click();
  await dialog.getByText("Versión guardada.").waitFor();
  await page.keyboard.press("Escape");

  await editor.fill("La casa era roja.");
  await saved(ch1, "La casa era roja.");
  await openNav(page);
  await page.getByRole("button", { name: "Versiones de este capítulo" }).click();
  // The newest «Primer borrador» (the API test saved another one before).
  await dialog.getByRole("button", { name: /Primer borrador/ }).first().click();
  assert.equal(await dialog.locator(".diff ins").innerText(), "azul.");
  assert.equal(await dialog.locator(".diff del").innerText(), "roja.");
  await dialog.getByRole("button", { name: "Restaurar esta versión" }).click();
  // The current text is kept first (a request), then the editor changes.
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value === "La casa era azul.");
  assert.ok(!(await dialog.isVisible()), "the window closes");
  await saved(ch1, "La casa era azul.");
  const restoreKept = (await versions(ch1)).find((v) => v.reason === "restore");
  assert.equal((await version(restoreKept.id)).content, "La casa era roja.", "the text it replaced is kept");

  await page.locator(".editor-notice.applied").getByRole("button", { name: "Deshacer" }).click();
  assert.equal(await editor.inputValue(), "La casa era roja.");
  await ctx.close();
});

test("interface: applying the AI keeps the text before it", async () => {
  await setText(ch1, "Antes de la escena.");
  const aiCount = async () => (await versions(ch1)).filter((v) => v.reason === "ai").length;
  const before = await aiCount();
  const { ctx, page, editor } = await open();
  const panel = page.locator("aside.panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().click();
  await editor.evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan llega.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar al final" }).click();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  assert.ok((await editor.inputValue()).includes("—¿Café? —dijo él."));
  for (let i = 0; i < 50 && (await aiCount()) === before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await aiCount(), before + 1, "a new 'ai' version");
  const ai = (await versions(ch1)).find((v) => v.reason === "ai");
  assert.equal((await version(ai.id)).content, "Antes de la escena.");
  await ctx.close();
});

test("interface: «Conservar la mía» keeps the other device's text as a version first", async () => {
  await setText(ch1, "Base.");
  const { ctx, page, editor } = await open();
  const live = (await call(`/api/chapters/${ch1}`)).data;
  await call(`/api/chapters/${ch1}`, "PATCH", { content: "Base, desde el teléfono.", revision: live.revision });
  await editor.press("Control+End");
  await page.keyboard.type(" Y aquí.");
  await page.waitForSelector(".save.conflict");
  await page.getByRole("button", { name: "Conservar la mía" }).click();
  await saved(ch1, "Base. Y aquí.");
  const kept = (await versions(ch1)).find((v) => v.reason === "conflict");
  assert.equal((await version(kept.id)).content, "Base, desde el teléfono.");
  await ctx.close();
});

test("interface: delete a chapter, recover it from the trash", async () => {
  const id = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Recuperable" })).data.id;
  await setText(id, "No me pierdas.");
  const { ctx, page, editor } = await open();
  await openNav(page);
  const row = page.locator("nav.chapters li", { hasText: "Recuperable" });
  await row.hover();
  await row.getByRole("button", { name: "Eliminar" }).click();
  await row.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Papelera" }).click();
  const dialog = page.getByRole("dialog", { name: "Papelera" });
  await dialog.getByText("Recuperable").waitFor();
  await dialog.getByRole("button", { name: "Recuperar" }).click();
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value === "No me pierdas.");
  assert.equal(await editor.inputValue(), "No me pierdas.");
  assert.match(await page.locator(".topbar .chapter-title").innerText(), /Recuperable/);
  await ctx.close();
});

/** The files of a stored ZIP, by name. */
function unzip(buf) {
  const files = new Map();
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
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

test("interface: the backup downloads a ZIP with the novel, each chapter and the data", async () => {
  await setText(ch1, "Leyó *Rayuela*.\n\n[[separador]]\n\nFin.");
  const { ctx, page } = await open();
  await page.locator(".topbar .title").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Descargar copia de seguridad" }).click(),
  ]);
  assert.match(download.suggestedFilename(), /^Versiones - copia \d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzip(fs.readFileSync(await download.path()));
  assert.ok(files.has("LEEME.txt") && files.has("novela.md") && files.has("procesador.json"));
  assert.match(files.get("novela.md").toString(), /## Capítulo 1\n\nLeyó \*Rayuela\*\.\n\n\* \* \*\n\nFin\./);
  assert.equal(files.get("capitulos/1 Capítulo 1.txt").toString(), "Leyó *Rayuela*.\n\n[[separador]]\n\nFin.");
  assert.equal(JSON.parse(files.get("procesador.json")).memory.characters[0].name, "Elena");
  await page.getByText("Copia descargada.").waitFor();
  await ctx.close();
});
