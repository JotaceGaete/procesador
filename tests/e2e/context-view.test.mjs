// "Ver contexto": the inventory of a request is built by the same code as the request, so
// what it lists is exactly what reaches the model, and nothing else. Checked against the
// request the (mock) provider really receives, and in the panel, on a desktop and a phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

const CH1 = "Capítulo uno. Pilar recordó el juicio y la tarde en que todo empezó. FINAL-DEL-UNO.";
const CH2 = "Anaís miró el mar desde la ventana.";
const ARGUMENT = "Pilar llega a El puerto y espera.";
const FACT_SENT = "Pilar perdió el juicio de 1990.";
const FACT_SUGGESTED = "Héctor tiene un hermano gemelo.";
const FACT_UNRELATED = "La iglesia ardió en invierno.";

let call, browser;
const s = {};

before(async () => {
  await resetDb();
  call = client(await login());
  s.novel = (await call("/api/novels", "POST", { title: "Contexto" })).data.id;
  await call(`/api/novels/${s.novel}`, "PATCH", {
    synopsis: "Una jueza vuelve al pueblo donde perdió su primer juicio.",
    guide: { genre: "Drama", person: "Tercera persona" },
  });
  s.ch1 = (await call(`/api/novels/${s.novel}`)).data.chapters[0].id;
  s.ch2 = (await call(`/api/novels/${s.novel}/chapters`, "POST", { title: "El regreso" })).data.id;
  for (const [id, content] of [[s.ch1, CH1], [s.ch2, CH2]]) {
    const { revision } = (await call(`/api/chapters/${id}`)).data;
    await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  }
  const add = async (kind, body) => (await call(`/api/novels/${s.novel}/memory/${kind}`, "POST", body)).data;
  s.pilar = await add("characters", { name: "Pilar", role: "jueza", knows: "Que el testigo mintió" });
  s.hector = await add("characters", { name: "Héctor" });
  s.anais = await add("characters", { name: "Anaís" });
  s.marta = await add("characters", { name: "Marta" });
  await add("places", { name: "El puerto", description: "Muelle viejo de madera." });
  await add("places", { name: "La iglesia" });
  await add("relationships", { from_id: s.pilar.id, to_id: s.hector.id, kind: "teme a" });
  await add("relationships", { from_id: s.marta.id, to_id: s.pilar.id, kind: "odia a" });
  await add("facts", { text: FACT_SENT, character_ids: [s.pilar.id] });
  await add("facts", { text: FACT_SUGGESTED, character_ids: [s.hector.id], status: "suggested" });
  await add("facts", { text: FACT_UNRELATED });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const scene = (extra = {}) => ({
  novelId: s.novel,
  chapterId: s.ch2,
  content: CH2,
  provider: "anthropic",
  mode: "scene",
  argument: ARGUMENT,
  cursor: CH2.length,
  characterIds: [s.hector.id],
  length: "breve",
  ...extra,
});
const byId = (sections) => Object.fromEntries(sections.map((x) => [x.id, x]));

test("escena: el inventario dice qué va y por qué; nada de lo que no va", async () => {
  const dry = (await call("/api/assist", "POST", { ...scene(), dryRun: true })).data;
  assert.deepEqual(
    dry.sections.map((x) => x.id),
    ["chapter", "previous", "guide", "characters", "places", "relationships", "facts", "argument"],
  );
  const sec = byId(dry.sections);
  assert.equal(sec.chapter.label, "Capítulo 2: El regreso");
  assert.match(sec.chapter.items[0].label, /antes del cursor/);
  assert.match(sec.previous.items[0].label, /^Capítulo 1: últimas/);
  assert.deepEqual(sec.guide.items.map((i) => i.label), ["Sinopsis", "Mundo", "Narración"]);
  assert.deepEqual(
    sec.characters.items.map((i) => [i.label, i.reason]),
    [
      ["Héctor", "elegido en «En escena»"],
      ["Pilar", "nombrado en el argumento"],
      ["Anaís", "nombrado en el texto anterior"],
    ],
  );
  assert.deepEqual(sec.places.items.map((i) => i.label), ["El puerto"]);
  assert.deepEqual(sec.relationships.items.map((i) => i.label), ["Pilar → teme a → Héctor"]);
  assert.deepEqual(sec.facts.items.map((i) => i.label), [FACT_SENT]);
  assert.equal(sec.argument.items[0].label, ARGUMENT);
  // The rest of the total is Procesador's own instructions, not shown as content.
  assert.ok(dry.instructions > 500);
  assert.equal(dry.sections.reduce((n, x) => n + x.tokens, 0) + dry.instructions, dry.total);
  assert.ok(!JSON.stringify(dry.sections).includes("Eres el escritor"), "no internal instructions");
});

test("escena: lo que recibe el modelo coincide con el inventario", async () => {
  await clearAiLog();
  const r = await call("/api/assist", "POST", scene());
  assert.ok(events(r.data).some((e) => e.type === "text"));
  const sent = (await aiLog())[0].body;
  const system = sent.system.map((b) => b.text).join("\n");
  const prompt = sent.messages[0].content;
  for (const name of ["Pilar", "Héctor", "Anaís"]) assert.match(system, new RegExp(`### ${name}`));
  assert.doesNotMatch(system, /### Marta/);
  assert.match(system, /Pilar → teme a → Héctor/);
  assert.doesNotMatch(system, /odia a/);
  assert.match(system, /### El puerto/);
  assert.doesNotMatch(system, /La iglesia/);
  assert.ok(system.includes(FACT_SENT));
  assert.ok(!system.includes(FACT_SUGGESTED) && !system.includes(FACT_UNRELATED));
  assert.match(system, /Una jueza vuelve al pueblo/);
  assert.ok(prompt.includes(ARGUMENT));
  assert.ok(prompt.includes("FINAL-DEL-UNO"), "the previous chapter's end, as listed");
  assert.ok(!system.includes("FINAL-DEL-UNO"), "no whole novel: it wasn't listed");
});

test("escena con toda la historia hasta aquí: aparece en el inventario y sólo entonces se envía", async () => {
  const dry = (await call("/api/assist", "POST", { ...scene({ includeManuscript: true }), dryRun: true })).data;
  const sec = byId(dry.sections);
  assert.equal(sec.manuscript.label, "La historia hasta aquí");
  assert.match(sec.manuscript.items[0].label, /^El capítulo 1 y el 2 hasta el cursor · ≈\d+ palabras$/);
  await clearAiLog();
  await call("/api/assist", "POST", scene({ includeManuscript: true }));
  const system = (await aiLog())[0].body.system.map((b) => b.text).join("\n");
  assert.ok(system.includes("FINAL-DEL-UNO"));
});

test("editar selección: el fragmento, y quién aparece en el texto", async () => {
  const dry = (
    await call("/api/assist", "POST", {
      novelId: s.novel,
      chapterId: s.ch2,
      content: CH2,
      mode: "edit",
      action: "redaccion",
      selectionStart: 0,
      selectionEnd: CH2.length,
      dryRun: true,
    })
  ).data;
  assert.deepEqual(dry.sections.map((x) => x.id), ["selection", "guide", "characters"]);
  assert.deepEqual(byId(dry.sections).characters.items.map((i) => [i.label, i.reason]), [["Anaís", "nombrado en el texto"]]);
});

for (const device of [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  { name: "teléfono", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, mobile: true },
]) {
  test(`${device.name}: «Ver contexto» lista lo que se enviará y se despliega`, async () => {
    const ctx = await browser.newContext(device.context);
    await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
    // Chapter 2 open, as if the author left it there.
    await ctx.addInitScript(([novel, ch]) => localStorage.setItem(`chapter:${novel}`, ch), [s.novel, s.ch2]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
    await page.goto(`${BASE}/novela/${s.novel}`);
    const press = (loc) => (device.mobile ? loc.tap() : loc.click());
    const editor = page.locator("textarea.editor");
    await editor.waitFor();
    assert.equal(await editor.inputValue(), CH2);
    await editor.evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    const panel = page.locator("aside.panel");
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
    await press(panel.getByRole("button", { name: "Escribir escena" }));

    // The checkbox says what being off means.
    await panel.getByText("Desactivada, la IA no lee toda la historia: trabaja sólo con el contexto seleccionado.").waitFor();
    await panel.getByLabel(/Leer toda la historia hasta aquí/).waitFor();

    await page.getByPlaceholder(/Qué ocurre en la escena/).fill(ARGUMENT);
    await press(panel.getByRole("checkbox", { name: "Héctor" }));
    const show = panel.getByRole("button", { name: "Ver contexto" });
    await show.waitFor();
    await press(show);
    const view = panel.getByRole("region", { name: "Contexto que recibirá la IA" });
    const settled = () => page.waitForFunction(() => document.querySelector(".context-view")?.getAttribute("aria-busy") === "false");
    await settled();
    await view.getByText("La IA tendrá en cuenta").waitFor();
    await view.getByText(/Personajes: Héctor, Pilar, Anaís/).waitFor();
    assert.equal(await view.getByText("Marta").count(), 0);
    await view.getByText("Tu argumento").waitFor();
    await view.getByText("No lee toda la historia hasta aquí: sólo lo que aparece en esta lista.").waitFor();
    assert.equal(await view.getByText(/Eres el escritor/).count(), 0);

    // Unfold the facts: the one that goes, not the suggested nor the unrelated one.
    const facts = view.locator('[data-section="facts"] details');
    assert.equal(await facts.evaluate((d) => d.open), false);
    await press(facts.locator("summary"));
    await facts.getByText(FACT_SENT).waitFor();
    assert.equal(await view.getByText(FACT_SUGGESTED).count(), 0);
    assert.equal(await view.getByText(FACT_UNRELATED).count(), 0);
    // Why each character is there.
    const characters = view.locator('[data-section="characters"]');
    await press(characters.locator("summary"));
    await characters.getByText("elegido en «En escena»").waitFor();
    await characters.getByText("nombrado en el argumento").waitFor();

    // Turning on the story so far: it appears in the list (fresh estimate), and the help changes.
    await press(panel.getByLabel(/Leer toda la historia hasta aquí/));
    await panel.getByText("Lee los capítulos anteriores y este hasta el cursor; nunca lo que viene después.").waitFor();
    await settled();
    await view.getByText(/La historia hasta aquí — El capítulo 1 y el 2 hasta el cursor/).waitFor();
    assert.equal(await view.getByText("No lee toda la historia hasta aquí: sólo lo que aparece en esta lista.").count(), 0);
    await ctx.close();
  });
}
