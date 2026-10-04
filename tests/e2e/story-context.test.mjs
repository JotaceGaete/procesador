// Desarrollar escena with "la historia hasta aquí" (docs/asistente-contexto.md, phase 2): the
// Consejero's digests of the previous chapters, what the people of the scene know and the
// threads open at this point reach the writer; nothing from later chapters does, and "Ver
// contexto" lists exactly that. No reading is triggered by writing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

const KEY = process.env.E2E_SERVICE_KEY;
// Rows straight into the database, one by one (they don't share the same keys).
const rest = async (table, rows) => {
  const out = [];
  for (const row of rows) {
    const res = await fetch(`${STACK}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    out.push(...(await res.json()));
  }
  return out;
};
const count = async (table, query) =>
  (await (await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } })).json()).length;

const ARGUMENT = "Pilar abre la puerta y espera.";
let call, browser, novel, ch, current;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Seis capítulos" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (let i = 2; i <= 6; i++) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: `Parte ${i}` })).data.id);
  const revisions = [];
  for (const [i, id] of ch.entries()) {
    const content = i === 3 ? "Pilar volvió a la casa. FIN-DE-LO-ESCRITO." : `Capítulo ${i + 1}. Pilar y Héctor en la casa. ANCLA-${i}.`;
    revisions.push((await call(`/api/chapters/${id}`, "PATCH", { content, revision: 0 })).data.revision);
  }
  current = "Pilar volvió a la casa. FIN-DE-LO-ESCRITO.";
  const pilar = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Pilar" })).data;
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Héctor" });

  const [carta, juicio, futuro, posible] = await rest("story_threads", [
    { novel_id: novel, title: "La carta de Marta", kind: "mystery", status: "closed", confirmed: true, opened_chapter_id: ch[0], closed_chapter_id: ch[4] },
    { novel_id: novel, title: "El juicio perdido", kind: "conflict", status: "closed", confirmed: true, opened_chapter_id: ch[0], closed_chapter_id: ch[1] },
    { novel_id: novel, title: "HILO-FUTURO", kind: "promise", confirmed: true, opened_chapter_id: ch[5] },
    { novel_id: novel, title: "Un hilo posible", kind: "other", confirmed: false, opened_chapter_id: ch[0] },
  ]);
  const digest = (i, extra) => ({
    chapter_id: ch[i],
    novel_id: novel,
    source_revision: revisions[i],
    summary: `RESUMEN-${i + 1}. Lo que pasa en el capítulo ${i + 1}.`,
    events: [{ text: `SUCESO-${i + 1}`, characters: [pilar.id], quote: `ANCLA-${i}` }],
    presence: [{ character: pilar.id, kind: "present" }],
    revelations: [],
    threads: [],
    ...extra,
  });
  await rest("chapter_digests", [
    digest(0, { threads: [{ thread: carta.id, change: "opened", quote: "" }, { thread: juicio.id, change: "opened", quote: "" }, { thread: posible.id, change: "opened", quote: "" }] }),
    // Chapter 2 (index 1) has no digest.
    digest(2, { revelations: [{ text: "SABE-QUE-HECTOR-MINTIO", to: pilar.id, quote: "" }], threads: [{ thread: carta.id, change: "advanced", quote: "" }] }),
    digest(4, { revelations: [{ text: "REVELACION-FUTURA", to: pilar.id, quote: "" }], threads: [{ thread: carta.id, change: "closed", quote: "" }] }),
    digest(5, { threads: [{ thread: futuro.id, change: "opened", quote: "" }] }),
  ]);
  await rest("novel_digests", [{ novel_id: novel, summary: "RESUMEN-GLOBAL-CON-FINAL" }]);
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const scene = (extra = {}) => ({
  novelId: novel,
  chapterId: ch[3],
  content: current,
  provider: "anthropic",
  mode: "scene",
  argument: ARGUMENT,
  cursor: current.length,
  length: "breve",
  ...extra,
});
const byId = (sections) => Object.fromEntries(sections.map((x) => [x.id, x]));

test("escena en el capítulo 4: caps. 1–3 sí, 5–6 no; hilos abiertos en este punto; lo que sabe Pilar", async () => {
  const usageBefore = await count("ai_usage", `novel_id=eq.${novel}`);
  const dry = (await call("/api/assist", "POST", { ...scene(), dryRun: true })).data;
  const sec = byId(dry.sections);
  assert.deepEqual(
    dry.sections.map((x) => x.id),
    ["chapter", "previous", "story", "guide", "characters", "knowledge", "threads", "argument"],
  );
  assert.equal(sec.story.label, "Lo ocurrido antes: 2 capítulos");
  assert.deepEqual(sec.story.items.map((i) => [i.label, i.reason]), [["Capítulo 1", "resumen"], ["Capítulo 3: Parte 3", "en detalle"]]);
  assert.equal(sec.knowledge.label, "Lo que saben: Pilar (1)");
  assert.deepEqual(sec.threads.items.map((i) => i.label), ["La carta de Marta"]);
  assert.deepEqual(dry.notices, [
    "El capítulo 2 no tiene ficha de lectura: la IA no sabe qué pasó en él. Puedes leerlo en Consejero → Lectura.",
    "1 hilo posible, sin confirmar, no se envía: puedes confirmarlos en Consejero → Lectura.",
  ]);

  await clearAiLog();
  const r = await call("/api/assist", "POST", scene());
  assert.ok(events(r.data).some((e) => e.type === "text"));
  const prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /<historia_hasta_aqui>[\s\S]*RESUMEN-1[\s\S]*RESUMEN-3[\s\S]*<\/historia_hasta_aqui>/);
  assert.match(prompt, /SUCESO-3/, "the closest chapter in detail");
  assert.match(prompt, /<lo_que_saben>\n- Pilar: SABE-QUE-HECTOR-MINTIO \(Capítulo 3: Parte 3\)\n<\/lo_que_saben>/);
  assert.match(prompt, /<hilos_abiertos>\n- «La carta de Marta» · Misterio · se abre en Capítulo 1, última vez en Capítulo 3: Parte 3\n<\/hilos_abiertos>/);
  for (const never of ["RESUMEN-5", "RESUMEN-6", "REVELACION-FUTURA", "HILO-FUTURO", "El juicio perdido", "Un hilo posible", "RESUMEN-GLOBAL", "ANCLA-0"])
    assert.ok(!prompt.includes(never), never);
  // Writing never triggers a reading.
  assert.equal(await count("ai_usage", `novel_id=eq.${novel}&purpose=neq.assist`), 0);
  assert.equal(await count("ai_usage", `novel_id=eq.${novel}`), usageBefore + 1);
});

test("con la novela completa: sin fichas, pero con lo que saben y los hilos", async () => {
  const dry = (await call("/api/assist", "POST", { ...scene({ includeManuscript: true }), dryRun: true })).data;
  assert.deepEqual(dry.sections.map((x) => x.id), ["chapter", "previous", "guide", "characters", "knowledge", "threads", "argument", "manuscript"]);
  assert.ok(!dry.notices.some((n) => n.includes("ficha de lectura")));
});

test("el resumen global sólo entra al escribir al final de la novela", async () => {
  // Chapter 6, at its end, with nothing after: the global summary goes.
  const last = `Capítulo 6. Pilar y Héctor en la casa. ANCLA-5.`;
  const dry = (await call("/api/assist", "POST", { ...scene({ chapterId: ch[5], content: last, cursor: last.length }), dryRun: true })).data;
  assert.equal(byId(dry.sections).story.items[0].label, "Resumen de la novela");
  // The same chapter with text after the cursor beyond what is shown: it doesn't.
  const long = `${last}\n\n${"Más texto que vendrá después. ".repeat(100)}`;
  const mid = (await call("/api/assist", "POST", { ...scene({ chapterId: ch[5], content: long, cursor: last.length }), dryRun: true })).data;
  assert.ok(!byId(mid.sections).story.items.some((i) => i.label === "Resumen de la novela"));
});

for (const device of [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  { name: "teléfono", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, mobile: true },
]) {
  test(`${device.name}: «Ver contexto» muestra lo ocurrido antes, lo que saben, los hilos y los avisos`, async () => {
    const ctx = await browser.newContext(device.context);
    await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
    await ctx.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[3]]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
    await page.goto(`${BASE}/novela/${novel}`);
    const press = (loc) => (device.mobile ? loc.tap() : loc.click());
    const editor = page.locator("textarea.editor");
    await editor.waitFor();
    await editor.evaluate((el) => {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    const panel = page.locator("aside.panel");
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
    await press(panel.getByRole("button", { name: "Escribir escena" }));
    await page.getByPlaceholder(/Qué ocurre en la escena/).fill(ARGUMENT);
    await press(panel.getByRole("button", { name: "Ver contexto" }));
    const view = panel.getByRole("region", { name: "Contexto que recibirá la IA" });
    await page.waitForFunction(() => document.querySelector(".context-view")?.getAttribute("aria-busy") === "false");
    await view.getByText("Lo ocurrido antes: 2 capítulos").waitFor();
    await view.getByText("Lo que saben: Pilar (1)").waitFor();
    await view.getByText("Hilos abiertos: 1").waitFor();
    await view.getByText(/El capítulo 2 no tiene ficha de lectura/).waitFor();
    const story = view.locator('[data-section="story"]');
    await press(story.locator("summary"));
    await story.getByText("en detalle").waitFor();
    await story.getByText(/RESUMEN-3/).waitFor();
    const threads = view.locator('[data-section="threads"]');
    await press(threads.locator("summary"));
    await threads.getByText("La carta de Marta").waitFor();
    assert.equal(await view.getByText(/HILO-FUTURO|El juicio perdido|RESUMEN-5|RESUMEN-GLOBAL/).count(), 0);
    await ctx.close();
  });
}
