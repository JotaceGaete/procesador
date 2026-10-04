// Temporary diagnostics: the build stamp (which code the page is running, and whether the
// server already has another) and the ?diag=1 overlay of the Asistente's state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb } from "./helpers.mjs";

const SHA = execSync("git rev-parse HEAD").toString().trim().slice(0, 7);
let call, browser, novel;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Diagnóstico" })).data.id;
  const chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: "Uno.\n\nDos.", revision });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}${path}`);
  return { ctx, page };
}

test("/api/version and the library footer name the build being run", async () => {
  const v = (await call("/api/version")).data;
  assert.equal(v.build, SHA);
  const { ctx, page } = await open("/");
  const stamp = page.locator(".library-foot .build-stamp");
  await stamp.waitFor();
  assert.match(await stamp.textContent(), new RegExp(`Versión ${SHA}`));
  assert.ok(!(await stamp.textContent()).includes("recarga"), "same build in page and server");
  await ctx.close();
});

test("a page running older code than the server says so", async () => {
  const { ctx, page } = await open("/");
  await page.route("**/api/version", (r) => r.fulfill({ json: { build: "0000000" } }));
  await page.reload();
  await page.locator(".build-stamp", { hasText: "el servidor ya tiene 0000000: recarga la página" }).waitFor();
  await ctx.close();
});

test("?diag=1: state of the panel, the clear after Insertar, and the origin of a tapped text", async () => {
  const { ctx, page } = await open(`/novela/${novel}?diag=1`);
  await page.locator("textarea.editor").waitFor();
  const panel = page.locator("aside.panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().click();
  const diag = panel.locator("pre.diag");
  await diag.waitFor();
  assert.match(await diag.textContent(), new RegExp(`build ${SHA}`));

  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar en el cursor" }).waitFor();
  assert.match(await diag.textContent(), /slot=assistant:scene/);
  assert.match(await diag.textContent(), /showResult=true parsed=true last=true/);
  assert.match(await diag.textContent(), /results: assistant:scene\(\d+ car\.\)/);
  // The result section says where it comes from.
  assert.equal(await panel.locator(".result").getAttribute("data-origin"), 'results["assistant:scene"] (showResult && parsed && last)');

  await panel.getByRole("button", { name: "Insertar en el cursor" }).click();
  await diag.filter({ hasText: "usada ok=true → clearResult(assistant:scene)" }).waitFor();
  assert.match(await diag.textContent(), /showResult=false parsed=false last=false/);
  assert.match(await diag.textContent(), /results: \(vacío\)/);
  assert.equal(await panel.locator(".result").count(), 0);

  // What stays in the panel is the argument draft, and the overlay says so when tapped.
  await page.getByPlaceholder(/Qué ocurre en la escena/).click();
  assert.match(await diag.textContent(), /toque: argument \(estado argument, localStorage argument:/);
  await ctx.close();

  // ?diag=0 turns it off for this browser.
  const again = await open(`/novela/${novel}?diag=0`);
  await again.page.locator("textarea.editor").waitFor();
  assert.equal(await again.page.locator("pre.diag").count(), 0);
  await again.ctx.close();
});
