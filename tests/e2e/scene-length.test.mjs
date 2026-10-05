// "Desarrollar escena" means dramatizing, not summarizing: the same literary base for every
// model, a length range (a target, not a quota), a short reminder only for Grok, and, when a
// Media/Larga scene comes out well below what was asked, a discreet "Ampliar" that is never
// automatic and develops the same scene (desktop and phone).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

const SHORT = "Juan dejó las llaves sobre la mesa. Elena no levantó la vista.\n\n—¿Café? —dijo él.";
let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Extensión" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: "Uno.\n\nDos.", revision: 0 });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const scene = (provider, extra = {}) =>
  call("/api/assist", "POST", {
    novelId: novel,
    chapterId,
    content: "Uno.\n\nDos.",
    cursor: 4,
    provider,
    mode: "scene",
    argument: "Juan y Elena discuten en la cocina.",
    length: "media",
    ...extra,
  });
/** System and user text as each provider receives them. */
function parts(entry) {
  const b = entry.body;
  // Claude gets the same text in separate blocks (for caching); joined as the others receive it.
  if (entry.provider === "anthropic") return { system: b.system.map((x) => x.text).join("\n\n"), user: b.messages[0].content };
  if (entry.provider === "openai") return { system: b.instructions, user: b.input };
  return { system: b.messages[0].content, user: b.messages[1].content };
}

test("los tres modelos reciben la misma base literaria y el rango; sólo Grok la nota", async () => {
  const seen = {};
  for (const provider of ["anthropic", "openai", "xai"]) {
    await clearAiLog();
    const r = await scene(provider);
    assert.ok(events(r.data).some((e) => e.type === "text"), provider);
    const entry = (await aiLog())[0];
    assert.equal(entry.provider, provider);
    seen[provider] = parts(entry);
  }
  for (const [provider, { system, user }] of Object.entries(seen)) {
    assert.match(system, /Desarrollar una escena es dramatizarla, no resumirla/, provider);
    assert.match(system, /Contención no es brevedad/, provider);
    assert.match(user, /Extensión: alrededor de 800–1\.000 palabras \(media\)\./, provider);
    assert.match(user, /Escribe la escena completa, desarrollada: alrededor de 800–1\.000 palabras\. Es una orientación, no una cuota/, provider);
  }
  assert.equal(seen.anthropic.system, seen.openai.system, "same instructions, word for word");
  assert.equal(seen.openai.system, seen.xai.system, "same instructions, word for word");
  assert.equal(seen.anthropic.user, seen.openai.user, "GPT and Claude: the same task");
  assert.match(seen.xai.user, /Importante: no resumas el argumento\. Escribe la escena entera en tiempo de escena, desarrollando cada momento que contiene, hasta alrededor de 800–1\.000 palabras\./);
  assert.equal(seen.xai.user.replace(/\n\nImportante: no resumas[^\n]*/, ""), seen.openai.user, "the note is Grok's only difference");
});

test("Ampliar (API): la escena escrita va como borrador, con el mismo contexto", async () => {
  await clearAiLog();
  const r = await scene("xai", { expand: SHORT });
  assert.ok(events(r.data).some((e) => e.type === "text" && e.text.includes("ESCENA-AMPLIADA")));
  const { user } = parts((await aiLog())[0]);
  assert.ok(user.includes(`<borrador>\n${SHORT}\n</borrador>`));
  assert.match(user, /Conserva todo lo que ocurre, en el mismo orden/);
  assert.match(user, /No añadas acontecimientos nuevos para ganar extensión/);
  assert.match(user, /<argumento>\nJuan y Elena discuten en la cocina\.\n<\/argumento>/);
  assert.doesNotMatch(user, /Importante: no resumas/, "the widening task says it already");
});

for (const device of [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  { name: "teléfono", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, mobile: true },
]) {
  async function open() {
    const ctx = await browser.newContext(device.context);
    await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
    await page.goto(`${BASE}/novela/${novel}`);
    const editor = page.locator("textarea.editor");
    await editor.waitFor();
    await editor.evaluate((el) => {
      el.focus();
      el.setSelectionRange(4, 4);
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    const press = (loc) => (device.mobile ? loc.tap() : loc.click());
    const panel = page.locator("aside.panel");
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
    await press(panel.getByRole("button", { name: "Escribir escena" }));
    return { ctx, page, editor, panel, press };
  }
  async function generate({ page, panel, press }, argument, length) {
    await page.getByPlaceholder(/Qué ocurre en la escena/).fill(argument);
    if (length) await panel.getByLabel("Extensión").selectOption(length);
    await press(panel.getByRole("button", { name: "Desarrollar escena" }));
    await panel.getByRole("button", { name: "Insertar en el cursor" }).waitFor();
  }

  test(`${device.name}: escena Media corta → aviso discreto; Ampliar sólo al pulsarlo, y conserva la escena`, async () => {
    const s = await open();
    await clearAiLog();
    await generate(s, "Juan y Elena discuten.", "media");
    const note = s.panel.locator(".length-note");
    await note.waitFor();
    assert.equal((await note.textContent()).trim(), "≈15 palabras de ~900 solicitadas · Ampliar");
    assert.equal(await s.panel.locator(".notice.error, .error").count(), 0, "not an error");
    // Nothing is asked again on its own.
    await s.page.waitForTimeout(800);
    assert.equal((await aiLog()).length, 1);

    await s.press(note.getByRole("button", { name: "Ampliar" }));
    await s.panel.getByText(/ESCENA-AMPLIADA/).waitFor();
    await s.panel.getByRole("button", { name: "Insertar en el cursor" }).waitFor();
    const log = await aiLog();
    assert.equal(log.length, 2);
    assert.ok(parts(log[1]).user.includes(`<borrador>\n${SHORT}\n</borrador>`), "the scene written is the draft");
    assert.equal(await note.count(), 0, "developed enough: no note");
    // The widened scene is the one inserted; the argument goes with it.
    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor" }));
    assert.ok((await s.editor.inputValue()).includes("ESCENA-AMPLIADA"));
    await s.ctx.close();
  });

  test(`${device.name}: sin aviso en Breve, en Libre ni cuando la escena está desarrollada`, async () => {
    const s = await open();
    for (const [argument, length] of [
      ["Juan llega.", "breve"],
      ["Juan llega.", "libre"],
      ["ESCENA-LARGA Juan llega.", "media"],
    ]) {
      await generate(s, argument, length);
      assert.equal(await s.panel.locator(".length-note").count(), 0, `${argument} ${length}`);
      await s.press(s.panel.getByRole("button", { name: "Limpiar" }));
    }
    await s.ctx.close();
  });
}
