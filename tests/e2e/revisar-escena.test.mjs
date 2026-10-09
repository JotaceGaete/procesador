// «La manta» (docs/consejero.md, «Revisar escena»): «Haz esta escena más atractiva» reads the
// selected scene whole (even in the middle of a long chapter), protects it, and can conclude
// it works; its review goes to the Asistente as the changes to make to THAT scene; the
// Consejero compares the rewrite with the original, as a recommendation; a scene whose
// argument contradicts what is established is asked, not written in silence, and written
// once the author confirms. API with the mock AI, then the panel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, ch, ids, browser;

// The scene, between ~12.000 characters before and after: far from the end of the chapter.
const FILL_BEFORE = Array.from({ length: 120 }, (_, i) => `Párrafo de antes ${i + 1}: el bus avanzaba hacia el norte sin prisa.`).join("\n\n");
const FILL_AFTER = Array.from({ length: 120 }, (_, i) => `Párrafo de después ${i + 1}: Santiago aparecía entre la niebla.`).join("\n\n");
// The test scenes written from the author's description (tests/fixtures/la-manta/README.md):
// fictitious, not the author's text. The first line only labels them as tests.
const fixture = (name) => readFileSync(new URL(`../fixtures/la-manta/${name}.txt`, import.meta.url), "utf8").split("\n\n").slice(1).join("\n\n").trim();
const SCENE = fixture("original");
const DEFECTIVE = fixture("defectuosa");
const CONTENT = `${FILL_BEFORE}\n\n${SCENE}\n\n${FILL_AFTER}`;
const START = CONTENT.indexOf(SCENE);
const END = START + SCENE.length;

const advise = (extra) => call("/api/advisor", "POST", { novelId: novel, chapterId: ch, content: CONTENT, provider: "anthropic", ...extra });
const planOf = (list) => list.find((e) => e.type === "plan");
const lastBody = async () => (await aiLog()).at(-1).body;
const systemOf = (b) => (b.system ?? []).map((x) => x.text).join("\n");

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "La manta" })).data.id;
  ch = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${ch}`, "PATCH", { content: CONTENT, revision: 0 });
  const create = async (kind, body) => (await call(`/api/novels/${novel}/memory/${kind}`, "POST", body)).data.id;
  ids = {
    pola: await create("characters", { name: "Pola", age: "18 años", description: "Embarazada, viaja a Santiago a ver a su madre." }),
    eduardo: await create("characters", { name: "Eduardo", aliases: "don Eduardo" }),
  };
  await create("relationships", { from_id: ids.pola, to_id: ids.eduardo, kind: "conoce", note: "de su pueblo" });
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

test("Conversar: «Haz esta escena más atractiva» is a review of the selected scene, read whole, with who knows whom", async () => {
  await clearAiLog();
  const list = events((await advise({ question: "Haz esta escena más atractiva", mode: "conversar", selection: { start: START, end: END } })).data);
  assert.deepEqual([planOf(list).action, planOf(list).mode], ["revisar", "conversar"]);
  const req = await lastBody();
  const prompt = req.messages[0].content;
  assert.ok(prompt.includes(`<seleccion capitulo="1">\n${SCENE}\n</seleccion>`), "the scene, whole, though it is far from the end");
  assert.match(prompt, /El autor quiere mejorar una escena que ya escribió[\s\S]*Lo que funciona/);
  assert.match(prompt, /Pola → conoce → Eduardo/, "who knows whom");
  assert.match(systemOf(req), /Más acontecimientos no es más interés/);
  assert.match(systemOf(req), /Juzgas las escenas íntimas, sexuales o violentas por su oficio/);
  // It may conclude that the scene works: no cards to act on.
  const answer = list.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.match(answer, /La escena funciona; no la cambiaría/);
  assert.deepEqual(list.find((e) => e.type === "observations").items, []);
});

test("Analizar: «Revisar escena» as a quick action, and other actions also read the selection", async () => {
  await clearAiLog();
  const list = events((await advise({ action: "revisar", selection: { start: START, end: END } })).data);
  assert.equal(planOf(list).action, "revisar");
  assert.ok((await lastBody()).messages[0].content.includes(`<seleccion capitulo="1">\n${SCENE}`));
  await clearAiLog();
  events((await advise({ question: "¿Qué pasaría si Eduardo se baja antes?", mode: "conversar", selection: { start: START, end: END } })).data);
  assert.ok((await lastBody()).messages[0].content.includes("<seleccion"), "Conversar reads the author's selection too");
  await clearAiLog();
  events((await advise({ question: "¿Cómo sigo?", mode: "conversar", selection: { start: START, end: END } })).data);
  assert.doesNotMatch((await lastBody()).messages[0].content, /<seleccion/, "how to go on is about the end of the chapter");
});

const edit = (extra) =>
  call("/api/assist", "POST", { novelId: novel, chapterId: ch, content: CONTENT, mode: "edit", action: "revisar", selectionStart: START, selectionEnd: END, provider: "anthropic", ...extra });

test("Asistente, Revisar escena: the approved changes and only those, the Memoria of the scene, and a warning if a rewrite makes strangers of them", async () => {
  await clearAiLog();
  const list = events((await edit({ notes: "Que la invitación de Pola llegue con menos explicación." })).data);
  const req = await lastBody();
  assert.match(req.messages[0].content, /<cambios_pedidos>\nQue la invitación de Pola llegue con menos explicación\.\n<\/cambios_pedidos>[\s\S]*aplica esos y sólo esos/);
  assert.match(systemOf(req), /Pola → conoce → Eduardo/, "relationships go with a scene review");
  assert.equal(list.find((e) => e.type === "continuity"), undefined);

  const stranger = events((await edit({ notes: "REESCRIBE-DESCONOCIDO" })).data);
  const warnings = stranger.find((e) => e.type === "continuity")?.warnings ?? [];
  assert.ok(
    warnings.some((w) => w.kind === "relacion" && /en la Memoria Pola y Eduardo tienen una relación \(conoce\)/.test(w.message)),
    JSON.stringify(warnings),
  );
});

test("juicio comparativo: the stranger version is worse, with what it loses; only a recommendation; nothing stored", async () => {
  await clearAiLog();
  const r = await call(`/api/novels/${novel}/compare`, "POST", { original: SCENE, proposal: DEFECTIVE, provider: "anthropic" });
  assert.equal(r.status, 200);
  assert.equal(r.data.verdict, "peor");
  assert.deepEqual(r.data.criteria.map((c) => c.name), ["Tensión emocional", "Subtexto", "Ritmo", "Naturalidad", "Caracterización", "Continuidad", "Fuerza del desenlace"]);
  assert.deepEqual(r.data.changes, ["Pola y Eduardo se conocen; la propuesta los hace desconocidos"]);
  const req = await lastBody();
  assert.match(systemOf(req), /<juicio-comparativo>[\s\S]*la decisión es suya/);
  assert.match(req.messages[0].content, /Pola → conoce → Eduardo[\s\S]*<original>\n/);
  assert.ok(req.messages[0].content.includes(`<original>\n${SCENE}\n</original>\n\n<propuesta>\n${DEFECTIVE}\n</propuesta>`), "both versions, whole");
  assert.match(req.messages[0].content, /Edad: 18 años/);

  assert.equal((await call(`/api/novels/${novel}/compare`, "POST", { original: SCENE, proposal: "", provider: "anthropic" })).status, 400);
  const broken = await call(`/api/novels/${novel}/compare`, "POST", { original: SCENE, proposal: "JUICIO-ROTO", provider: "anthropic" });
  assert.equal(broken.status, 502, "an invalid verdict twice: an error, never a made-up one");
  assert.equal((await call(`/api/chapters/${ch}`)).data.content, CONTENT, "the manuscript untouched");
});

const scene = (extra) =>
  call("/api/assist", "POST", { novelId: novel, chapterId: ch, content: CONTENT, mode: "scene", length: "corta", cursor: CONTENT.length, provider: "anthropic", ...extra });

test("a scene that contradicts what is established: the Asistente asks; once the author confirms, it writes it", async () => {
  await clearAiLog();
  const asked = events((await scene({ argument: "ESCENA-CONTRADICE Pola conoce a Eduardo en una parada de carretera." })).data);
  const text = asked.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.match(text, /^<aviso>[^<]*desconocido[^<]*<\/aviso>$/);
  assert.match(systemOf(await lastBody()), /no escribas la escena: responde sólo con una línea dentro de <aviso><\/aviso>/);
  assert.doesNotMatch((await lastBody()).messages[0].content, /El autor ya confirmó el cambio/);

  const written = events((await scene({ argument: "ESCENA-CONTRADICE Pola conoce a Eduardo en una parada de carretera.", confirmChange: true })).data);
  assert.match(written.filter((e) => e.type === "text").map((e) => e.text).join(""), /<escena>/);
  assert.match((await lastBody()).messages[0].content, /El autor ya confirmó el cambio/);
});

// ---------------------------------------------------------------- panel

test("panel: Revisar escena → «Aplicar con el Asistente» → Editar with the review → the Consejero's recommendation, and «Reemplazar» stays the author's", async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  await editor.evaluate((el, [s, e]) => {
    el.focus();
    el.setSelectionRange(s, e);
  }, [START, END]);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  await panel.getByRole("group", { name: "Modo del Consejero" }).waitFor();
  await panel.getByRole("combobox", { name: "Conversación" }).selectOption("");
  assert.equal(await panel.getByRole("checkbox", { name: "Sobre la selección (la lee entera)" }).isChecked(), true, "visible in Conversar too");

  await panel.getByRole("textbox", { name: "Pregunta al Consejero" }).fill("Haz esta escena más atractiva");
  await panel.getByRole("button", { name: "Enviar", exact: true }).click();
  const apply = panel.getByRole("button", { name: "Aplicar con el Asistente" });
  await apply.waitFor({ timeout: 15_000 });
  await apply.click();

  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  assert.equal(await panel.getByRole("button", { name: "Revisar escena" }).getAttribute("aria-pressed"), "true");
  const notes = panel.getByRole("textbox", { name: "Cambios que quieres (opcional)" });
  assert.match(await notes.inputValue(), /La escena funciona; no la cambiaría/);
  await notes.fill("REESCRIBE-DESCONOCIDO");
  await panel.getByRole("button", { name: "Proponer cambios" }).click();
  const judgment = panel.getByLabel("Recomendación del Consejero");
  await judgment.waitFor({ timeout: 15_000 });
  assert.match(await judgment.innerText(), /Tu versión es mejor: el Consejero recomienda conservarla[\s\S]*Es una recomendación: la decisión es tuya/);
  const replace = panel.getByRole("button", { name: "Reemplazar selección" });
  assert.equal(await replace.isEnabled(), true, "the author can still choose the proposal");
  assert.equal(await editor.inputValue(), CONTENT, "nothing applied by itself");

  // A scene against what is established: the warning, and the author's way to go ahead.
  await panel.getByRole("button", { name: "Descartar" }).click();
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await panel.getByPlaceholder(/Qué ocurre en la escena/).fill("ESCENA-CONTRADICE Pola conoce a Eduardo en una parada de carretera.");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  const go = panel.getByRole("button", { name: "Escribir igualmente: cambio ese hecho" });
  await go.waitFor({ timeout: 15_000 });
  assert.match(await panel.locator(".contradiction").innerText(), /El argumento contradice algo establecido:[\s\S]*desconocido[\s\S]*Tú decides/);
  assert.equal(await panel.getByRole("button", { name: "Insertar al final" }).count(), 0, "no scene until the author confirms");
  await go.click();
  await panel.getByRole("button", { name: "Insertar al final" }).waitFor({ timeout: 15_000 });
  assert.match((await aiLog()).at(-1).body.messages[0].content, /El autor ya confirmó el cambio/);
  assert.equal(await editor.inputValue(), CONTENT, "still nothing applied");
  await ctx.close();
});
