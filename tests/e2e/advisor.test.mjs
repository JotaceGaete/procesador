// Consejero, phase 1 (docs/consejero.md): the overview measured without AI, usage
// reported and logged per request, and the panel's Asistente | Consejero sections.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, other, ch, browser, page;

const LONG = "Juan Ortega abrió la puerta del taller sin hacer ruido";
const CH3 = `La lámpara temblaba sobre la mesa. Elena miró la lámpara sin decir nada.\n\n${LONG}.`;

/** ai_usage rows, read with the service key (the app has no endpoint that lists them). */
async function usageRows(novelId) {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/ai_usage?novel_id=eq.${novelId}&order=created_at`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}
const overview = (chapterId, content) => call(`/api/novels/${novel}/advisor`, "POST", { chapterId, content });

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El taller" })).data.id;
  other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (const title of ["Dos", "Tres"]) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title })).data.id);
  const texts = [`${LONG}. Elena dormía.`, "Marta esperaba en el puerto. La Rubia no tenía prisa.", "Todavía nada."];
  for (const [i, content] of texts.entries()) await call(`/api/chapters/${ch[i]}`, "PATCH", { content, revision: 0 });
  for (const [name, aliases] of [
    ["Juan Ortega", ""],
    ["Elena", ""],
    ["Marta", "la Rubia"],
    ["Rosa", ""],
  ])
    await call(`/api/novels/${novel}/memory/characters`, "POST", { name, aliases });
  await call(`/api/novels/${novel}/memory/places`, "POST", { name: "El puerto", aliases: "" });
});
after(async () => {
  await browser?.close();
  await clearAiLog(); // the next files expect an empty log
});

// ---------------------------------------------------------------- overview (no AI)

test("overview: presence measured up to the open chapter, with its unsaved text", async () => {
  await clearAiLog();
  const r = await overview(ch[2], CH3);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const by = Object.fromEntries(r.data.characters.map((p) => [p.name, p]));
  assert.deepEqual(by["Juan Ortega"].counts, [1, 0, 1]);
  assert.equal(by["Juan Ortega"].chaptersSince, 0);
  assert.equal(by.Marta.counts[1], 2, "name and alias");
  assert.equal(by.Marta.chaptersSince, 1);
  assert.ok(by.Marta.wordsSince > 20);
  assert.equal(by.Rosa.chaptersSince, null);
  assert.deepEqual(r.data.places[0].counts, [0, 1, 0]);
  assert.equal((await aiLog()).length, 0, "the overview never calls a provider");
});

test("overview: repetitions point at the exact text, in this chapter and across chapters", async () => {
  const { data } = await overview(ch[2], CH3);
  const echo = data.repetitions.chapter.find((x) => x.kind === "eco" && x.text === "lámpara");
  assert.ok(echo, JSON.stringify(data.repetitions.chapter));
  for (const o of echo.occurrences) assert.equal(CH3.slice(o.start, o.end), "lámpara");
  assert.ok(!data.repetitions.chapter.some((x) => x.text === "Elena"), "names are not echoes");

  const across = data.repetitions.novel.filter((x) => x.text.includes("puerta"));
  assert.equal(across.length, 1, "the long phrase once, not its pieces");
  assert.equal(across[0].text, LONG);
  const [a, b] = across[0].occurrences;
  assert.equal(a.chapterId, ch[0]);
  assert.equal(b.chapterId, ch[2]);
  assert.equal(CH3.slice(b.start, b.end), LONG, "offsets of the unsaved text");
});

test("overview: novel map and month usage; chapters of another novel are not found", async () => {
  const { data } = await overview(ch[2], CH3);
  assert.deepEqual(
    data.chapters.map((c) => c.words),
    [12, 10, CH3.split(/\s+/).length],
  );
  const juan = data.characters.find((p) => p.name === "Juan Ortega").id;
  assert.ok(data.chapters[0].characters.includes(juan));
  assert.equal(data.usage.requests, 0);
  const foreign = await call(`/api/novels/${other}/advisor`, "POST", { chapterId: ch[0], content: "" });
  assert.equal(foreign.status, 404);
});

// ---------------------------------------------------------------- usage per request

const edit = (action, extra = {}) =>
  call("/api/assist", "POST", {
    novelId: novel,
    chapterId: ch[2],
    content: CH3,
    provider: "anthropic",
    mode: "edit",
    action,
    selectionStart: 0,
    selectionEnd: 33,
    ...extra,
  });

test("assist: the context it read comes first, the provider's usage (with cost) before the end", async () => {
  await clearAiLog();
  const list = events((await edit("redaccion")).data);
  assert.equal(list[0].type, "context");
  assert.deepEqual(
    list[0].parts.map((p) => p.label),
    ["Instrucciones", "Guía y memoria", "Texto y tarea"],
  );
  assert.ok(list[0].parts.every((p) => p.tokens > 0));
  const usage = list.find((e) => e.type === "usage");
  assert.deepEqual(
    { model: usage.model, input: usage.input, cached: usage.cached, output: usage.output },
    { model: "claude-opus-5-5", input: 1200, cached: 1000, output: 30 },
  );
  // 200 fresh × 5 + 1000 cached × 0.5 + 30 out × 25, per million.
  assert.ok(Math.abs(usage.costUsd - 0.00225) < 1e-9);
  assert.equal((await aiLog())[0].body.model, "claude-opus-5-5");

  const dry = (await edit("redaccion", { dryRun: true })).data;
  assert.equal(dry.total, dry.parts.reduce((n, p) => n + p.tokens, 0));
});

test("assist: the Consejero's analyses use its own model; every request is logged", async () => {
  await clearAiLog();
  const list = events((await edit("consistencia")).data);
  assert.equal((await aiLog())[0].body.model, "claude-consejero-e2e");
  assert.equal(list.find((e) => e.type === "usage").costUsd, null, "no price for that model: tokens only");

  const rows = await usageRows(novel);
  assert.deepEqual(
    rows.map((r) => [r.purpose, r.provider, r.model]),
    [
      ["assist", "anthropic", "claude-opus-5-5"],
      ["advise", "anthropic", "claude-consejero-e2e"],
    ],
  );
  assert.equal(Number(rows[0].cost_usd), 0.00225);
  assert.equal(rows[1].cost_usd, null);
  assert.deepEqual([rows[1].input_tokens, rows[1].cached_tokens, rows[1].output_tokens], [1200, 1000, 30]);

  const { usage } = (await overview(ch[2], CH3)).data;
  assert.deepEqual(usage, { requests: 2, input: 2400, cached: 2000, output: 60, costUsd: 0.00225 });
});

test("ai_usage: not copied when duplicating; deleted with its novel", async () => {
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", {})).data.id;
  assert.equal((await usageRows(copy)).length, 0);
  assert.equal((await call(`/api/novels/${copy}`, "DELETE")).status, 204);
  assert.equal((await usageRows(novel)).length, 2);
});

test("the novel tells the panel when to ask before sending (AI_CONFIRM_TOKENS)", async () => {
  assert.equal((await call(`/api/novels/${novel}`)).data.confirmTokens, 30000, "AI_CONFIRM_TOKENS of the test stack");
});

// ---------------------------------------------------------------- panel

test("panel: the Asistente writes, the Consejero analyses; the three analyses moved", async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();

  const panel = page.locator("aside.panel");
  // Open by default on a wide screen, on the Asistente.
  if (!(await panel.isVisible())) await page.locator(".topbar .link", { hasText: "Asistente" }).click();
  await panel.waitFor();
  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  const actionNames = () => panel.locator(".actions button").allInnerTexts();
  assert.deepEqual(await actionNames(), ["Redacción", "Diálogo", "Expandir", "Acortar"]);
  assert.ok(await panel.getByRole("button", { name: "Escribir escena" }).isVisible());

  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  assert.equal(await panel.getAttribute("aria-label"), "Consejero");
  await panel.getByRole("button", { name: "Sobre la selección" }).click();
  assert.deepEqual(await actionNames(), ["Consistencia", "Personaje", "Evolución"]);
  assert.equal(await panel.getByRole("button", { name: "Escribir escena" }).count(), 0, "the Consejero doesn't write");
});

test("panel: an analysis shows, discreetly, what it read and what it used", async () => {
  await page.locator("textarea.editor").evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 30);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.keyboard.press("Shift+ArrowRight");
  await page.locator("aside.panel").getByRole("button", { name: "Consistencia" }).click();
  await page.getByRole("button", { name: "Analizar" }).click();
  const line = page.locator(".usage-line");
  await line.waitFor();
  const text = await line.innerText();
  assert.match(text, /Leyó: instrucciones ≈.*guía y memoria ≈.*texto y tarea ≈/);
  assert.match(text, /1,2 mil tokens de entrada \(1 mil en caché\) → 30 de salida/);
  assert.doesNotMatch(text, /US\$/, "no price configured for the Consejero's model");
});

test("panel: Panorama lists who has been away, the repetitions, and Ir selects one", async () => {
  // Open the third chapter and give it the text with repetitions.
  await page.locator(".topbar .chapter-title").click();
  await page.locator(".chapter-name", { hasText: "Tres" }).click();
  await page.waitForFunction(() => document.querySelector("textarea.editor")?.value === "Todavía nada.");
  await page.locator("textarea.editor").fill(CH3);
  await page.getByRole("button", { name: "Panorama" }).click();
  const ov = page.locator(".overview");
  await ov.locator(".presence li").first().waitFor();
  assert.match(await ov.locator(".presence li", { hasText: "Marta" }).innerText(), /hace 1 capítulo/);
  assert.match(await ov.locator(".presence li", { hasText: "Rosa" }).innerText(), /aún no aparece/);

  const lamp = ov.locator(".repetitions > li", { hasText: "«lámpara»" });
  await lamp.waitFor();
  await lamp.getByRole("button", { name: "Ir" }).nth(1).click();
  const sel = await page
    .locator("textarea.editor")
    .evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  assert.equal(sel, "lámpara");

  // Across chapters: Ir opens the other chapter and selects the phrase there.
  await ov.getByRole("button", { name: "Entre capítulos" }).click();
  const phrase = ov.locator(".repetitions > li", { hasText: "Juan Ortega abrió" });
  await phrase.getByRole("button", { name: "Ir" }).first().click();
  await page.waitForFunction(
    (t) => {
      const el = document.querySelector("textarea.editor");
      return el && el.value.slice(el.selectionStart, el.selectionEnd) === t;
    },
    LONG,
    { timeout: 15_000 },
  );
  assert.match(await page.locator(".topbar .chapter-title").innerText(), /Capítulo 1/);
  assert.match(await ov.locator(".usage-month").innerText(), /consultas/);
});
