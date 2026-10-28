// Estado narrativo por capítulo en la ficha del personaje, en el navegador
// (Playwright/Chromium) contra la app real y la base (docs/estado-narrativo.md).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb, textEditor } from "./helpers.mjs";

let browser, ctx, page, call, novel, pola, eduardo, cap1, cap2;
const dialogs = [];

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Estado narrativo" })).data.id;
  pola = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Pola" })).data.id;
  eduardo = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Eduardo Ruiz" })).data.id;
  await call(`/api/novels/${novel}/chapters`, "POST", { title: "El bus" });
  await call(`/api/novels/${novel}/chapters`, "POST", { title: "La plaza" });
  // Una novela nueva trae un capítulo vacío al principio: los buscamos por título.
  const outline = (await call(`/api/novels/${novel}`)).data.chapters;
  cap1 = outline.find((c) => c.title === "El bus").id;
  cap2 = outline.find((c) => c.title === "La plaza").id;

  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
});
after(() => browser?.close());

// La ficha del personaje tiene su propio «Guardar»: la sección de estados se acota aparte.
const section = () => page.locator(".group.static", { hasText: "Estado por capítulo" });
const states = () => section().getByRole("button", { name: /Guardar|Borrar|Cancelar/ });
const savedStates = async () => (await call(`/api/novels/${novel}/states`)).data;

test("la sección aparece en la ficha con una fila por capítulo, sin estado todavía", async () => {
  await page.getByRole("button", { name: "Memoria", exact: true }).click();
  await page.locator(".character-cards").waitFor();
  await page.locator(".character-card", { hasText: "Eduardo Ruiz" }).click();
  await page.getByText("Estado por capítulo", { exact: true }).waitFor();
  await section().getByRole("button", { name: /El bus/ }).waitFor();
  assert.equal(await section().getByRole("button", { name: /El bus/ }).count(), 1);
  assert.equal(await section().getByRole("button", { name: /La plaza/ }).count(), 1);
  assert.deepEqual(await savedStates(), []);
});

test("guardar el estado al terminar un capítulo lo deja como memoria aprobada", async () => {
  await section().getByRole("button", { name: /El bus/ }).click();
  await page.getByLabel("Dónde está").fill("Temuco");
  await page.getByLabel("Qué sabe").fill("que Pola viaja a Santiago");
  await section().getByRole("button", { name: "Guardar", exact: true }).click();
  await section().getByText(/Temuco/).first().waitFor();

  const rows = await savedStates();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].character_id, eduardo);
  assert.equal(rows[0].chapter_id, cap1);
  assert.equal(rows[0].location, "Temuco");
  assert.equal(rows[0].status, "approved");
  assert.equal(rows[0].alive, true);
});

test("un personaje muerto se marca y su fila lo dice", async () => {
  await section().getByRole("button", { name: /La plaza/ }).click();
  await page.getByLabel("Vive al terminar el capítulo").uncheck();
  await section().getByRole("button", { name: "Guardar", exact: true }).click();
  await section().getByText(/muerto\/a/).waitFor();
  const rows = await savedStates();
  const plaza = rows.find((r) => r.chapter_id === cap2);
  assert.equal(plaza.alive, false);
});

test("borrar el estado de un capítulo lo quita de la memoria", async () => {
  await section().getByRole("button", { name: /El bus/ }).click();
  await section().getByRole("button", { name: "Borrar", exact: true }).click();
  await section().getByText(/sin estado/).first().waitFor();
  const rows = await savedStates();
  assert.equal(rows.some((r) => r.chapter_id === cap1), false);
  assert.ok(dialogs.some((m) => m.includes("Borrar el estado")));
});

test("un personaje ajeno a la novela no se puede guardar por la API", async () => {
  const other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  const foreign = (await call(`/api/novels/${other}/memory/characters`, "POST", { name: "Ajena" })).data.id;
  const r = await call(`/api/novels/${novel}/states`, "PUT", { character_id: foreign, chapter_id: cap1, location: "X" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no pertenecen a esta novela/);
});
