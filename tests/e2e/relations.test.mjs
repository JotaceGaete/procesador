// Relaciones personalizadas (docs/relaciones.md): the common kinds, the ones already used in the
// novel, and «+ Crear relación personalizada». Stored in relationships.kind like any other kind;
// trivial duplicates (case, spacing, accents) reuse the form the novel already has.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, resetDb } from "./helpers.mjs";

let call, browser, novel, chapterId;
const people = {};

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Puerto viejo" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  for (const name of ["Naty", "Emily", "Ana", "Tomás"]) {
    people[name] = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name })).data;
  }
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => browser?.close());

const relationships = async () => (await call(`/api/novels/${novel}`)).data.memory.relationships;
const line = (r) => `${Object.values(people).find((p) => p.id === r.from_id).name} → ${r.kind} → ${Object.values(people).find((p) => p.id === r.to_id).name}`;

async function open(context) {
  const ctx = await browser.newContext(context);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator(".visual-editor .visual-text").waitFor();
  const label = (text) => page.getByLabel(text, { exact: true });
  const openRelations = async () => {
    await page.getByRole("button", { name: "Memoria" }).click();
    await page.getByRole("button", { name: "Relaciones" }).click();
  };
  return { ctx, page, label, openRelations };
}

test("UI: create a custom relationship, reuse it without typing, no trivial duplicates, edit it later", async () => {
  const { ctx, page, label, openRelations } = await open({ viewport: { width: 1280, height: 900 } });
  await openRelations();

  // The common kinds are still there, and the option to create one.
  await page.getByRole("button", { name: "Añadir" }).click();
  const kinds = await label("Relación").locator("option").allInnerTexts();
  for (const k of ["amigo de", "enemigo de", "desconfía de", "le debe a", "trabaja para", "le teme a", "+ Crear relación personalizada"]) assert.ok(kinds.includes(k), k);
  await label("Personaje").selectOption({ label: "Naty" });
  await label("Relación").selectOption({ label: "+ Crear relación personalizada" });
  await label("Relación personalizada").fill("Ex amante de");
  await label("Con").selectOption({ label: "Emily" });
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.getByText("Naty → Ex amante de → Emily").waitFor();

  // Reused from «Usadas en esta novela», without typing it again.
  await page.getByRole("button", { name: "Añadir" }).click();
  const used = page.locator('select[aria-label="Relación"] optgroup[label="Usadas en esta novela"] option');
  assert.deepEqual(await used.allInnerTexts(), ["Ex amante de"]);
  await label("Personaje").selectOption({ label: "Ana" });
  await label("Relación").selectOption({ label: "Ex amante de" });
  await label("Con").selectOption({ label: "Tomás" });
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.getByText("Ana → Ex amante de → Tomás").waitFor();

  // Typed again with other case, spacing and accents: the novel's form, said discreetly.
  await page.getByRole("button", { name: "Añadir" }).click();
  await label("Personaje").selectOption({ label: "Tomás" });
  await label("Relación").selectOption({ label: "+ Crear relación personalizada" });
  await label("Relación personalizada").fill("  ex  AMANTE  de ");
  await page.getByText("Ya existe como «Ex amante de»: se usará esa forma.").waitFor();
  await label("Con").selectOption({ label: "Naty" });
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.getByText("Tomás → Ex amante de → Naty").waitFor();
  // And a common one written without its accent: the common form.
  await page.getByRole("button", { name: "Añadir" }).click();
  await label("Personaje").selectOption({ label: "Emily" });
  await label("Relación").selectOption({ label: "+ Crear relación personalizada" });
  await label("Relación personalizada").fill("Desconfia de");
  await page.getByText("Ya existe como «desconfía de»: se usará esa forma.").waitFor();
  await label("Con").selectOption({ label: "Ana" });
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.getByText("Emily → desconfía de → Ana").waitFor();

  let rels = await relationships();
  assert.deepEqual(rels.map(line), ["Naty → Ex amante de → Emily", "Ana → Ex amante de → Tomás", "Tomás → Ex amante de → Naty", "Emily → desconfía de → Ana"]);

  // On both characters' cards.
  await page.getByRole("button", { name: "Personajes" }).click();
  for (const name of ["Naty", "Emily"]) {
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
    await page.locator(".group.static", { hasText: "Relaciones" }).getByText("Naty → Ex amante de → Emily").waitFor();
    await page.getByRole("button", { name: /Volver|←/ }).first().click();
  }

  // Edited later: a custom kind is shown as it is and can be changed to a new one.
  await page.getByRole("button", { name: "Relaciones" }).click();
  await page.getByRole("button", { name: /Naty → Ex amante de → Emily/ }).click();
  assert.equal(await label("Relación").inputValue(), "Ex amante de");
  await label("Relación").selectOption({ label: "+ Crear relación personalizada" });
  await label("Relación personalizada").fill("Protegida de");
  await page.getByRole("button", { name: "Guardar" }).click();
  await page.getByText("Naty → Protegida de → Emily").waitFor();
  rels = await relationships();
  assert.equal(rels.find((r) => r.from_id === people.Naty.id).kind, "Protegida de");
  // The old kind is still offered while another relationship uses it.
  await page.getByRole("button", { name: "Añadir" }).click();
  assert.deepEqual(await used.allInnerTexts(), ["Ex amante de", "Protegida de"]);
  await ctx.close();
});

test("API: the same rule on every path (create and edit); the text is kept as written", async () => {
  const post = (kind, from = "Ana", to = "Naty") =>
    call(`/api/novels/${novel}/memory/relationships`, "POST", { from_id: people[from].id, to_id: people[to].id, kind });
  const a = await post("  Socia   de ");
  assert.equal(a.status, 201);
  assert.equal(a.data.kind, "Socia de");
  assert.equal((await post("socia DE", "Emily", "Tomás")).data.kind, "Socia de");
  assert.equal((await post("EX AMANTE DE", "Emily", "Naty")).data.kind, "Ex amante de");
  // Editing: the form already used by another relationship.
  const edited = await call(`/api/memory/relationships/${a.data.id}`, "PATCH", { kind: "ex amánte de" });
  assert.equal(edited.data.kind, "Ex amante de");
  // Still required.
  assert.equal((await post("   ")).status, 400);
});

test("AI context, backup and duplicate: a custom kind travels like any other", async () => {
  const rels = await relationships();
  const custom = rels.find((r) => r.kind === "Ex amante de" && r.from_id === people.Ana.id);
  assert.ok(custom);

  // Asistente: the scene's memory block.
  const content = "Ana y Tomás cruzaron el puerto.";
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content, revision });
  await clearAiLog();
  const body = { novelId: novel, chapterId, content, provider: "anthropic", mode: "scene", argument: "Ana le reprocha a Tomás.", cursor: content.length, characterIds: [people.Ana.id, people.Tomás.id], length: "breve" };
  const dry = (await call("/api/assist", "POST", { ...body, dryRun: true })).data;
  assert.ok(dry.sections.find((s) => s.id === "relationships").items.some((i) => i.label === "Ana → Ex amante de → Tomás"));
  await call("/api/assist", "POST", body);
  const system = (await aiLog())[0].body.system.map((b) => b.text).join("\n");
  assert.ok(system.includes("- Ana → Ex amante de → Tomás"), system);

  // Backup.
  const backup = (await call(`/api/novels/${novel}/backup`)).data;
  assert.deepEqual(backup.memory.relationships.map((r) => r.kind).sort(), rels.map((r) => r.kind).sort());

  // Duplicate.
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST")).data.id;
  const copied = (await call(`/api/novels/${copy}`)).data.memory.relationships;
  assert.deepEqual(copied.map((r) => r.kind).sort(), rels.map((r) => r.kind).sort());
});

test("iPhone: the selector and the custom field fit the screen; creating one works by touch", async () => {
  const { ctx, page, label } = await open({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await page.getByRole("button", { name: "Memoria" }).tap();
  await page.getByRole("button", { name: "Relaciones" }).tap();
  await page.getByRole("button", { name: "Añadir" }).tap();
  await label("Personaje").selectOption({ label: "Tomás" });
  await label("Relación").selectOption({ label: "+ Crear relación personalizada" });
  await label("Relación personalizada").fill("Padrino de");
  await label("Con").selectOption({ label: "Ana" });
  const fits = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Relación"], [aria-label="Relación personalizada"]')].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.height >= 30;
    }) && document.documentElement.scrollWidth <= innerWidth,
  );
  assert.ok(fits, "no horizontal overflow");
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/relaciones-iphone.png` });
  await page.getByRole("button", { name: "Guardar" }).tap();
  await page.getByText("Tomás → Padrino de → Ana").waitFor();
  await ctx.close();
});
