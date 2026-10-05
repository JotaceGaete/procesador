// Dónde va una escena (docs/asistente-contexto.md §11): al final del capítulo por defecto,
// sin depender del cursor; en el cursor sólo si el autor lo elige, con la posición fijada.
// Mover el cursor mientras la propuesta espera nunca cambia el destino que muestra.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, resetDb } from "./helpers.mjs";

const SCENE = "Juan dejó las llaves sobre la mesa. Elena no levantó la vista.\n\n—¿Café? —dijo él.";
const TEXT = "Primer párrafo.\n\nPÁRRAFO-INTERMEDIO que no debe tocarse.\n\nÚltimo párrafo del capítulo.";
const MIDDLE = TEXT.indexOf("PÁRRAFO-INTERMEDIO") + 5; // inside a word, as an accidental click leaves it
let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Destino" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const DEVICES = [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  {
    name: "teléfono",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    mobile: true,
  },
];

async function open(device, text = TEXT) {
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: text, revision });
  const ctx = await browser.newContext(device.context);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  const press = (loc) => (device.mobile ? loc.tap() : loc.click());
  const panel = page.locator("aside.panel");
  const caret = (at) =>
    editor.evaluate((el, p) => {
      el.focus();
      el.setSelectionRange(p, p);
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    }, at);
  const generate = async (where) => {
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
    await press(panel.getByRole("button", { name: "Escribir escena" }));
    if (where) await press(panel.getByRole("radio", { name: where }));
    await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
    await clearAiLog();
    await press(panel.getByRole("button", { name: "Desarrollar escena" }));
    await panel.getByLabel("La escena en su lugar").waitFor();
  };
  const inserted = () => page.locator("section.result").waitFor({ state: "detached" });
  const saved = async (expected) => {
    for (let i = 0; i < 60 && (await call(`/api/chapters/${chapterId}`)).data.content !== expected; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call(`/api/chapters/${chapterId}`)).data.content, expected);
  };
  return { ctx, page, editor, press, panel, caret, generate, inserted, saved };
}

for (const device of DEVICES) {
  test(`${device.name}: cursor accidentalmente en mitad del capítulo → Desarrollar escena → Insertar al final → al final, el texto intermedio intacto`, async () => {
    const s = await open(device);
    await s.caret(MIDDLE);
    await s.generate();
    // The scene was written to continue the chapter's end, not the middle.
    const prompt = (await aiLog())[0].body.messages[0].content;
    assert.ok(prompt.includes("Último párrafo del capítulo.") && !prompt.includes("<despues>"), "written for the end");
    await s.panel.getByText("Se insertará al final del capítulo").waitFor();
    assert.match(await s.panel.getByLabel("La escena en su lugar").innerText(), /Último párrafo del capítulo\.\s+Juan dejó las llaves[\s\S]*—dijo él\.$/);

    await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
    await s.inserted();
    const expected = `${TEXT}\n\n${SCENE}`;
    assert.equal(await s.editor.inputValue(), expected, "at the end, everything before it untouched");
    await s.saved(expected);
    await s.ctx.close();
  });

  test(`${device.name}: generar → mover el cursor → Insertar al final → sigue al final`, async () => {
    const s = await open(device);
    await s.caret(TEXT.length);
    await s.generate();
    await s.caret(MIDDLE);
    await s.page.keyboard.press("ArrowRight"); // a real move, as the author would
    await s.panel.getByText("Se insertará al final del capítulo").waitFor();
    await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
    await s.inserted();
    assert.equal(await s.editor.inputValue(), `${TEXT}\n\n${SCENE}`);
    await s.ctx.close();
  });

  test(`${device.name}: al final de un capítulo que acaba en separador o en blanco, la escena va en su propio párrafo`, async () => {
    const s = await open(device, "Texto.\n\n[[separador]]\n\n\n  ");
    await s.generate();
    await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
    await s.inserted();
    assert.equal(await s.editor.inputValue(), `Texto.\n\n[[separador]]\n\n${SCENE}`);
    await s.ctx.close();
  });

  test(`${device.name}: «En el cursor» fija la posición: moverlo no la cambia; «Fijar en la posición actual» sí`, async () => {
    const s = await open(device);
    const fixed = TEXT.indexOf("\n\nPÁRRAFO-INTERMEDIO");
    await s.caret(fixed);
    await s.generate("En el cursor");
    await s.panel.getByText("Se insertará en la posición actual").waitFor();
    const preview = s.panel.getByLabel("La escena en su lugar");
    assert.match(await preview.innerText(), /^Primer párrafo\.\s+Juan dejó[\s\S]+—dijo él\.\s+PÁRRAFO-INTERMEDIO/);
    // The cursor goes elsewhere: the destination shown stays.
    await s.caret(TEXT.length);
    await s.page.keyboard.press("ArrowLeft");
    assert.match(await preview.innerText(), /^Primer párrafo\.\s+Juan dejó/);
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor", exact: true }));
    await s.inserted();
    assert.equal(await s.editor.inputValue(), `Primer párrafo.\n\n${SCENE}\n\nPÁRRAFO-INTERMEDIO que no debe tocarse.\n\nÚltimo párrafo del capítulo.`);
    await s.ctx.close();
  });

  test(`${device.name}: con destino al final, «Insertar en el cursor…» muestra antes el lugar y sólo entonces inserta`, async () => {
    const s = await open(device);
    await s.generate();
    const fixed = TEXT.indexOf("\n\nÚltimo");
    await s.caret(fixed);
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor…" }));
    assert.equal(await s.editor.inputValue(), TEXT, "nothing inserted yet");
    await s.panel.getByText("Se insertará en la posición actual").waitFor();
    assert.match(await s.panel.getByLabel("La escena en su lugar").innerText(), /no debe tocarse\.\s+Juan dejó[\s\S]+—dijo él\.\s+Último párrafo/);
    // Changing one's mind: back to the end.
    await s.press(s.panel.getByRole("button", { name: "Insertar al final en su lugar" }));
    await s.panel.getByText("Se insertará al final del capítulo").waitFor();
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor…" }));
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor", exact: true }));
    await s.inserted();
    assert.equal(await s.editor.inputValue(), `Primer párrafo.\n\nPÁRRAFO-INTERMEDIO que no debe tocarse.\n\n${SCENE}\n\nÚltimo párrafo del capítulo.`);
    await s.ctx.close();
  });
}

test("si la copia previa falla, la escena no se inserta y la propuesta se queda; si el lugar fijado desaparece, tampoco", async () => {
  const s = await open(DEVICES[0]);
  await s.generate();
  await s.page.route("**/api/chapters/*/versions", (r) => r.abort());
  await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
  await s.panel.getByRole("alert").getByText(/no se ha aplicado nada/).waitFor();
  assert.equal(await s.editor.inputValue(), TEXT);
  await s.page.unroute("**/api/chapters/*/versions");

  // A fixed place whose surroundings the author then rewrites: not found, nothing inserted.
  await s.caret(TEXT.indexOf("\n\nÚltimo"));
  await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor…" }));
  await s.editor.fill("Todo el capítulo reescrito de otra manera.");
  await s.panel.getByText(/El texto alrededor del lugar fijado cambió/).waitFor();
  assert.ok(await s.panel.getByRole("button", { name: "Insertar en el cursor", exact: true }).isDisabled());
  // The end is always there.
  await s.press(s.panel.getByRole("button", { name: "Insertar al final en su lugar" }));
  await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
  await s.inserted();
  assert.equal(await s.editor.inputValue(), `Todo el capítulo reescrito de otra manera.\n\n${SCENE}`);
  await s.ctx.close();
});
