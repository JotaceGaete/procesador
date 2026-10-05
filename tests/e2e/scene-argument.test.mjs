// The argument of "Escribir escena" lives exactly as long as the scene it asks for:
// kept while generating and while the proposal is pending (to edit it or ask again),
// emptied only once the scene is inserted in the manuscript, kept if inserting fails or
// the proposal is discarded with «Limpiar». Same on a desktop and on a phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, resetDb } from "./helpers.mjs";

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
  novel = (await call("/api/novels", "POST", { title: "Argumentos" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function open(device) {
  const ctx = await browser.newContext(device.context);
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
  const argument = page.getByPlaceholder(/Qué ocurre en la escena/);
  const openScene = async () => {
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
    await press(panel.getByRole("button", { name: "Escribir escena" }));
    await argument.waitFor();
  };
  // The cursor after the first paragraph, where the scene goes.
  await editor.evaluate((el) => {
    el.focus();
    el.setSelectionRange(4, 4);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
  await openScene();
  await argument.fill("");
  return { ctx, page, editor, panel, press, argument, openScene };
}

async function generate({ panel, press, argument }) {
  await argument.fill(A);
  await press(panel.getByRole("button", { name: "Desarrollar escena" }));
  // Asking for it does not take the argument away…
  assert.equal(await argument.inputValue(), A);
  await panel.getByRole("button", { name: "Insertar en el cursor" }).waitFor();
  // …nor does the answer arriving: the proposal is pending, the argument still editable.
  assert.equal(await argument.inputValue(), A);
}

for (const device of DEVICES) {
  test(`${device.name}: argumento A → generar → insertar → argumento vacío, también al volver`, async () => {
    const s = await open(device);
    await generate(s);
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor" }));
    await s.page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
    assert.ok((await s.editor.inputValue()).includes("—dijo él."), "the scene is in the manuscript");
    assert.equal(await s.panel.locator(".result").count(), 0, "the used proposal is gone");
    assert.equal(await s.argument.inputValue(), "");
    // The manuscript keeps the focus, to go on writing after the scene.
    assert.ok(await s.editor.evaluate((el) => document.activeElement === el));
    if (device.mobile) assert.ok(!(await s.panel.isVisible()), "the sheet closed");

    // Coming back to Escribir escena: empty, with the cursor in it for the next one.
    if (!device.mobile) await s.press(s.panel.getByRole("button", { name: "Editar selección" }));
    await s.openScene();
    assert.equal(await s.argument.inputValue(), "");
    // (On a phone the tap's click comes a moment after the touch.)
    await s.page.waitForFunction(() => document.activeElement?.matches("label.argument textarea"), null, { timeout: 2000 });
    await s.page.keyboard.type("La siguiente escena.");
    assert.equal(await s.argument.inputValue(), "La siguiente escena.");

    // And the emptied argument is what a reload brings back (not the old one).
    await s.argument.fill("");
    await s.page.waitForTimeout(700);
    await s.page.reload();
    await s.editor.waitFor();
    await s.openScene();
    assert.equal(await s.argument.inputValue(), "");
    await s.ctx.close();
  });

  test(`${device.name}: argumento A → generar → la inserción falla → argumento A y propuesta intactos`, async () => {
    const s = await open(device);
    await generate(s);
    const before = await s.editor.inputValue();
    // The browser refuses the edit.
    await s.page.evaluate(() => {
      document.execCommand = () => {
        throw new Error("edición rechazada");
      };
    });
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor" }));
    await s.panel.getByText("No se pudo insertar la escena. Copia la propuesta y pégala a mano.").waitFor();
    assert.equal(await s.argument.inputValue(), A);
    assert.equal(await s.editor.inputValue(), before, "nothing half-inserted");
    assert.ok(await s.panel.isVisible(), "the panel stays open");
    assert.ok(await s.panel.getByRole("button", { name: "Insertar en el cursor" }).isVisible(), "the proposal stays");
    await s.ctx.close();
  });

  test(`${device.name}: «Limpiar» quita la propuesta y conserva el argumento para reformularlo`, async () => {
    const s = await open(device);
    await generate(s);
    await s.press(s.panel.getByRole("button", { name: "Limpiar" }));
    assert.equal(await s.panel.locator(".result").count(), 0);
    assert.equal(await s.argument.inputValue(), A);
    await s.ctx.close();
  });
}

test("escritorio: si el autor ya escribió otro argumento mientras tanto, insertar no se lo borra", async () => {
  const s = await open(DEVICES[0]);
  await generate(s);
  await s.argument.fill("Otra escena distinta.");
  await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor" }));
  await s.page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  assert.equal(await s.panel.locator(".result").count(), 0);
  assert.equal(await s.argument.inputValue(), "Otra escena distinta.");
  await s.ctx.close();
});
