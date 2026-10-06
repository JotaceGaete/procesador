// Fase 2 (docs/asistente-contexto.md): ignorancia temporal al escribir una escena, «Ver
// contexto» de la petición real, y comparar antes de aplicar (con copia previa, también en
// el teléfono).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

const SECRET = "REVELACION-20";
let call, browser, novel, ch, elena, pedro;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Misterio" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (let i = 2; i <= 20; i++) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: `Parte ${i}` })).data.id);
  const text = (i) =>
    i === 5
      ? "Elena llega al puerto. ANTES-DEL-CURSOR.\n\nPOSTERIOR-AL-CURSOR: Elena encuentra la carta."
      : i === 20
        ? `${SECRET}: Elena descubre que es hija de Pedro. FIN-20.`
        : `CAP-${i}: Elena y Pedro siguen en el pueblo.`;
  for (let i = 1; i <= 20; i++) assert.equal((await call(`/api/chapters/${ch[i - 1]}`, "PATCH", { content: text(i), revision: 0 })).status, 200);
  elena = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", role: "Protagonista", secrets: "Esconde las cartas." })).data.id;
  pedro = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Pedro", role: "El padre ausente" })).data.id;
  // Approved facts: one of chapter 3 (with its time), the secret of chapter 20.
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "Elena perdió a su madre.", chapter_id: ch[2], story_time: "Invierno de 1971", character_ids: [elena] });
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: `${SECRET} hecho: Elena es hija de Pedro.`, chapter_id: ch[19], character_ids: [elena, pedro] });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const chapter5 = "Elena llega al puerto. ANTES-DEL-CURSOR.\n\nPOSTERIOR-AL-CURSOR: Elena encuentra la carta.";
const cursor5 = chapter5.indexOf("\n\nPOSTERIOR");
const scene = (extra = {}) => ({
  novelId: novel,
  chapterId: ch[4],
  content: chapter5,
  mode: "scene",
  argument: "Elena y Pedro hablan en el muelle.",
  cursor: cursor5,
  provider: "anthropic",
  ...extra,
});
const sentText = (r) => JSON.stringify(r.body);

test("capítulo 5 + revelación sólo en el 20 → «Leer toda la historia hasta aquí» → Desarrollar escena: ni el capítulo 20 ni la revelación llegan al modelo", async () => {
  await clearAiLog();
  const res = await call("/api/assist", "POST", scene({ includeManuscript: true }));
  assert.equal(res.status, 200);
  const [request] = await aiLog();
  const all = sentText(request);
  for (let i = 1; i <= 4; i++) assert.ok(all.includes(`CAP-${i}:`), `chapter ${i} is there`);
  assert.ok(all.includes("ANTES-DEL-CURSOR"), "chapter 5 up to the cursor");
  for (const never of [SECRET, "FIN-20", "hija de Pedro", "POSTERIOR-AL-CURSOR", "encuentra la carta", "CAP-6:", "CAP-19:", "Capítulo 6", "Capítulo 20"])
    assert.ok(!all.includes(never), `never sent: ${never}`);
  // The real request says what it sent, and it is that.
  const context = events(res.data).find((e) => e.type === "context");
  const sections = Object.fromEntries(context.sent.sections.map((s) => [s.id, s]));
  assert.equal(sections.manuscript.label, "La historia hasta aquí");
  assert.match(sections.manuscript.items[0].label, /^Los capítulos 1 a 4 y el 5 hasta el cursor/);
  assert.ok(!JSON.stringify(context.sent).includes(SECRET));
  assert.ok(context.sent.notices.some((n) => /1 hecho de un capítulo posterior no se envía/.test(n)));
});

test("sin la historia completa tampoco: el hecho del capítulo 20 no se envía, ni marcado como posterior", async () => {
  await clearAiLog();
  await call("/api/assist", "POST", scene());
  const all = sentText((await aiLog())[0]);
  assert.ok(!all.includes(SECRET) && !all.includes("hija de Pedro"));
  assert.ok(!all.includes("posterior al capítulo actual"));
  assert.ok(all.includes("Elena perdió a su madre."), "earlier facts still go");
  assert.ok(all.includes("Invierno de 1971"));
  // Editing (a consistency check) still sees later facts, marked as such: it's not writing ahead.
  const dry = (
    await call("/api/assist", "POST", {
      ...scene(),
      mode: "edit",
      action: "consistencia",
      selectionStart: 0,
      selectionEnd: 22,
      dryRun: true,
    })
  ).data;
  const facts = dry.sections.find((s) => s.id === "facts");
  assert.ok(facts.items.some((f) => f.label.includes(SECRET) && /posterior/.test(f.note)));
});

test("Ver contexto: el modelo elegido cuenta en el dry-run, la ficha muestra su contenido, el hecho su tiempo", async () => {
  const dry = async (provider) => (await call("/api/assist", "POST", { ...scene({ characterIds: [elena] }), provider, dryRun: true })).data;
  const claude = await dry("anthropic");
  const grok = await dry("xai");
  assert.ok(grok.instructions > claude.instructions, "Grok's own block is in the estimate");
  const sections = Object.fromEntries(claude.sections.map((s) => [s.id, s]));
  const elenaItem = sections.characters.items.find((i) => i.label === "Elena");
  assert.equal(elenaItem.detail, "Rol: Protagonista\nSecretos: Esconde las cartas.");
  assert.match(sections.facts.items.find((f) => f.label === "Elena perdió a su madre.").note, /Invierno de 1971/);
  assert.ok(!sections.facts.items.some((f) => f.label.includes(SECRET)));
});

test("Ampliar: la escena a ampliar aparece en lo que se envió", async () => {
  const res = await call("/api/assist", "POST", scene({ expand: "Juan entró despacio y dejó las llaves." }));
  const context = events(res.data).find((e) => e.type === "context");
  const draft = context.sent.sections.find((s) => s.id === "draft");
  assert.equal(draft.label, "La escena a ampliar");
  assert.match(draft.items[0].label, /≈7 palabras/);
});

// ---------------------------------------------------------------- interface

const DEVICES = [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  {
    name: "teléfono",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    mobile: true,
  },
];

async function open(device, chapterId) {
  const ctx = await browser.newContext(device.context);
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  await ctx.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, chapterId]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  const press = (loc) => (device.mobile ? loc.tap() : loc.click());
  const panel = page.locator("aside.panel");
  const openPanel = async () => {
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
  };
  const select = (start, end) =>
    editor.evaluate(
      (el, [s, e]) => {
        el.focus();
        el.setSelectionRange(s, e);
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      },
      [start, end],
    );
  return { ctx, page, editor, press, panel, openPanel, select };
}

const versions = async (id) => (await call(`/api/chapters/${id}/versions`)).data;
const saved = async (id, expected) => {
  for (let i = 0; i < 60 && (await call(`/api/chapters/${id}`)).data.content !== expected; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(`/api/chapters/${id}`)).data.content, expected);
};

for (const device of DEVICES) {
  test(`${device.name}: selección → propuesta → comparación → aceptar → copia previa → autoguardado → recargar → restaurar el original`, async () => {
    const target = ch[6]; // chapter 7
    const original = "La casa era azul.\n\n[[separador]]\n\nY *grande*.";
    const { revision } = (await call(`/api/chapters/${target}`)).data;
    await call(`/api/chapters/${target}`, "PATCH", { content: original, revision });
    const aiBefore = (await versions(target)).filter((v) => v.reason === "ai").length;

    let s = await open(device, target);
    assert.equal(await s.editor.inputValue(), original);
    await s.openPanel();
    await s.press(s.panel.getByRole("button", { name: "Editar selección" }));
    await s.select(0, "La casa era azul.".length);
    await s.press(s.panel.getByRole("button", { name: "Proponer cambios" }));
    await s.panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();

    // The comparison, as prose: what goes and what comes; the manuscript untouched.
    const diff = s.panel.getByLabel("Cambios que propone la IA");
    assert.equal(await diff.locator("del").innerText(), "La casa era azul.");
    assert.equal(await diff.locator("ins").innerText(), "Texto propuesto por el modelo.");
    await s.panel.getByText(/La IA propone quitar 4 palabras y añadir 5 palabras/).waitFor();
    await s.press(s.panel.getByRole("button", { name: "Tu texto" }));
    await s.panel.getByLabel("Tu texto actual").getByText("La casa era azul.").waitFor();
    await s.press(s.panel.getByRole("button", { name: "Cambios", exact: true }));
    assert.equal(await s.editor.inputValue(), original, "nothing applied before accepting");

    await s.press(s.panel.getByRole("button", { name: "Reemplazar selección" }));
    const applied = original.replace("La casa era azul.", "Texto propuesto por el modelo.");
    await s.page.waitForFunction((v) => document.querySelector("textarea.editor")?.value === v, applied);
    // The copy was saved before the change: it holds the original text.
    const ai = (await versions(target)).filter((v) => v.reason === "ai");
    assert.equal(ai.length, aiBefore + 1);
    assert.equal((await call(`/api/versions/${ai[0].id}`)).data.content, original);
    await saved(target, applied);

    // Reload: the change persisted; restore the original from the history.
    await s.page.reload();
    await s.editor.waitFor();
    assert.equal(await s.editor.inputValue(), applied);
    if (!(await s.page.locator("nav.chapters").isVisible())) await s.press(s.page.locator(".topbar .chapter-title"));
    await s.press(s.page.getByRole("button", { name: "Versiones de este capítulo" }));
    const dialog = s.page.getByRole("dialog");
    await s.press(dialog.getByRole("button", { name: /Antes de aplicar la IA/ }).first());
    await s.press(dialog.getByRole("button", { name: "Restaurar esta versión" }));
    await s.page.waitForFunction((v) => document.querySelector("textarea.editor")?.value === v, original);
    await saved(target, original);
    assert.ok((await s.editor.inputValue()).includes("[[separador]]") && (await s.editor.inputValue()).includes("*grande*"), "format kept");
    await s.ctx.close();
  });

  test(`${device.name}: si la copia previa no se puede guardar, no se aplica nada y la propuesta se queda`, async () => {
    const target = ch[7]; // chapter 8
    const original = "Una frase para cambiar.";
    const { revision } = (await call(`/api/chapters/${target}`)).data;
    await call(`/api/chapters/${target}`, "PATCH", { content: original, revision });
    const s = await open(device, target);
    await s.openPanel();
    await s.press(s.panel.getByRole("button", { name: "Editar selección" }));
    await s.select(0, original.length);
    await s.press(s.panel.getByRole("button", { name: "Proponer cambios" }));
    await s.panel.getByRole("button", { name: "Reemplazar selección" }).waitFor();

    await s.page.route("**/api/chapters/*/versions", (r) => r.abort());
    await s.press(s.panel.getByRole("button", { name: "Reemplazar selección" }));
    await s.panel.getByRole("alert").getByText(/no se ha aplicado nada/).waitFor();
    assert.equal(await s.editor.inputValue(), original, "the manuscript is untouched");
    assert.ok(await s.panel.getByLabel("Cambios que propone la IA").isVisible(), "the proposal stays");

    // Once it can save the copy, the same proposal applies.
    await s.page.unroute("**/api/chapters/*/versions");
    await s.press(s.panel.getByRole("button", { name: "Reemplazar selección" }));
    await s.page.waitForFunction(() => document.querySelector("textarea.editor")?.value === "Texto propuesto por el modelo.");
    await s.ctx.close();
  });

  test(`${device.name}: Insertar en el cursor (elegido) muestra la escena y dónde irá; después se puede ver lo que se envió`, async () => {
    const target = ch[8]; // chapter 9
    const text = "Primer párrafo del nueve.\n\nSegundo párrafo del nueve.";
    const { revision } = (await call(`/api/chapters/${target}`)).data;
    await call(`/api/chapters/${target}`, "PATCH", { content: text, revision });
    const s = await open(device, target);
    await s.openPanel();
    await s.select("Primer párrafo del nueve.".length, "Primer párrafo del nueve.".length);
    await s.press(s.panel.getByRole("button", { name: "Escribir escena" }));
    await s.page.getByPlaceholder(/Qué ocurre en la escena/).fill("ESCENA-FORMATO");
    // Deliberately at the cursor (docs/asistente-contexto.md §11).
    await s.press(s.panel.getByRole("radio", { name: "En el cursor" }));
    await s.press(s.panel.getByRole("button", { name: "Desarrollar escena" }));
    await s.panel.getByRole("button", { name: "Insertar en el cursor", exact: true }).waitFor();

    await s.panel.getByText("Se insertará en la posición actual").waitFor();
    await s.panel.getByText(/Capítulo 9: Parte 9, entre estos párrafos/).waitFor();
    const preview = s.panel.getByLabel("La escena en su lugar");
    assert.match(await preview.locator("ins").innerText(), /Leyó \*Rayuela\* de un tirón\.\s+⁂ cambio de escena\s+Al día siguiente dijo \*nunca\*\./);
    assert.match(await preview.innerText(), /^Primer párrafo del nueve\.[\s\S]+Segundo párrafo del nueve\.$/);
    assert.equal(await s.editor.inputValue(), text, "nothing inserted yet");

    // What the real request carried.
    await s.press(s.panel.getByRole("button", { name: "Ver lo que se envió" }));
    const sentView = s.panel.getByRole("region", { name: "Contexto que recibió la IA" });
    await sentView.getByText("La IA tuvo en cuenta").waitFor();
    await sentView.getByText("Tu argumento").waitFor();

    await s.press(s.panel.getByRole("button", { name: "Insertar en el cursor", exact: true }));
    await s.page.waitForFunction(() => document.querySelector("textarea.editor")?.value.includes("[[separador]]"));
    assert.match(await s.editor.inputValue(), /^Primer párrafo del nueve\.\n\nLeyó \*Rayuela\* de un tirón\.\n\n\[\[separador\]\]\n\nAl día siguiente dijo \*nunca\*\.\n\nSegundo párrafo del nueve\.$/);
    await s.ctx.close();
  });
}
