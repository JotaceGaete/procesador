// Escribir escena es una conversación: se escribe lo que pasa (o un cambio), la IA responde en
// prosa dentro del hilo, «Rehacer» vuelve a escribir la última respuesta y «Guardar como
// capítulo» crea el capítulo y empieza una conversación nueva. Escritorio y teléfono.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb, textEditor } from "./helpers.mjs";

const TEXT = "Uno.\n\nDos.\n\nTres.";
const A = "Juan vuelve tarde. Elena finge dormir.";
const DEVICES = [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  {
    name: "teléfono",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    mobile: true,
  },
];

let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Conversación" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function open(device) {
  const ctx = await browser.newContext(device.context);
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: TEXT, revision });
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  const panel = page.locator("aside.panel");
  const press = (loc) => (device.mobile ? loc.tap() : loc.click());
  const message = page.getByLabel("Mensaje para la IA");
  if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
  await press(panel.getByRole("button", { name: "Escribir escena", exact: true }));
  await message.waitFor();
  return { ctx, page, panel, press, message };
}

test("escritorio: enviar → respuesta en el hilo → cambio → rehacer → guardar como capítulo empieza de cero", async () => {
  const s = await open(DEVICES[0]);
  const chaptersBefore = (await call(`/api/novels/${novel}`)).data.chapters.length;

  await s.message.fill(A);
  await s.panel.getByRole("button", { name: "Enviar", exact: true }).click();
  await s.panel.getByRole("button", { name: "Guardar como capítulo" }).waitFor();
  assert.equal(await s.message.inputValue(), "", "the message leaves the box");
  assert.ok(await s.panel.getByText(A).isVisible(), "the ask stays in the thread");

  // A follow-up is a new turn; only the last reply offers the actions.
  await s.message.fill("Más seco.");
  await s.panel.getByRole("button", { name: "Enviar", exact: true }).click();
  await s.panel.getByText("Más seco.").waitFor();
  await s.panel.getByRole("button", { name: "Guardar como capítulo" }).waitFor();
  assert.equal(await s.panel.getByRole("button", { name: "Guardar como capítulo" }).count(), 1);

  await s.panel.getByRole("button", { name: "Rehacer" }).click();
  await s.panel.getByRole("button", { name: "Guardar como capítulo" }).waitFor();

  await s.panel.getByRole("button", { name: "Guardar como capítulo" }).click();
  await s.panel.getByText("Más seco.").waitFor({ state: "detached" });
  const chaptersAfter = (await call(`/api/novels/${novel}`)).data.chapters.length;
  assert.equal(chaptersAfter, chaptersBefore + 1, "a new chapter was created");
  await s.ctx.close();
});
