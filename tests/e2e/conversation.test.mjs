// Consejero, phase 4 (docs/consejero.md): conversations that continue (with the older
// turns compacted), stored observations (save, dismiss, resolve), "Volver a comprobar"
// after an edit, "Proponer hecho" as a suggested fact, and thread actions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, other, ch, browser, page;
const s = {};

const T1 = "Elena juró que nunca había visto el mar.\n\nJuan guardó silencio toda la tarde.";
const T2 = "Elena recordó los veranos en Cartagena, frente al mar.\n\nNadie dijo nada durante la cena.";

const ask = (extra) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId: ch[1], content: T2, provider: "anthropic", ...extra });
const saved = (list) => list.find((e) => e.type === "saved");
const revision = async (id) => (await call(`/api/chapters/${id}`)).data.revision;
const save = async (id, content) => call(`/api/chapters/${id}`, "PATCH", { content, revision: await revision(id) });
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  return (await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })).json();
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El mar" })).data.id;
  other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "Dos" })).data.id);
  await save(ch[0], T1);
  await save(ch[1], T2);
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena" });
  for (const id of ch) await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic" });
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- conversations

test("a question starts a conversation: both turns and the cards are stored", async () => {
  const list = events((await ask({ question: "¿Funciona el ritmo de este capítulo?" })).data);
  const ok = saved(list);
  assert.ok(ok, JSON.stringify(list.map((e) => e.type)));
  assert.equal(ok.observationIds.length, 3);
  s.conversation = ok.conversationId;

  const convs = (await call(`/api/novels/${novel}/conversations`)).data;
  assert.deepEqual(convs.map((c) => [c.id, c.title]), [[s.conversation, "¿Funciona el ritmo de este capítulo?"]]);
  const { messages } = (await call(`/api/conversations/${s.conversation}`)).data;
  assert.deepEqual(messages.map((m) => m.role), ["author", "advisor"]);
  assert.equal(messages[0].content, "¿Funciona el ritmo de este capítulo?");
  assert.match(messages[1].content, /^## Lectura del Consejero/);
  assert.doesNotMatch(messages[1].content, /<observaciones>/, "only the Markdown is kept as the message");
  assert.equal(messages[1].context.plan.label, "Analizar capítulo");
  assert.equal(messages[1].context.usage.output, 30);
  assert.deepEqual(messages[1].observations.map((o) => o.title), ["Arranque lento", "Una impresión", "Mal atribuida"], "in their order");
  const [first] = messages[1].observations;
  assert.equal(first.status, "new");
  assert.deepEqual(first.based_on, { [ch[1]]: await revision(ch[1]) });
  assert.deepEqual(first.changed, []);
  s.obs = messages[1].observations.map((o) => o.id);
});

test("continuing: the previous turns go with the question; a dry run touches nothing", async () => {
  await clearAiLog();
  const dry = await ask({ question: "¿Y el final?", conversationId: s.conversation, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal((await aiLog()).length, 0);

  const list = events((await ask({ question: "¿Y el final?", conversationId: s.conversation })).data);
  assert.equal(saved(list).conversationId, s.conversation, "same conversation");
  const prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /<conversacion>\nÚltimos mensajes:\n\[Autor\] ¿Funciona el ritmo de este capítulo\?\n\n\[Consejero\] ## Lectura del Consejero/);
  assert.ok(prompt.indexOf("<conversacion>") < prompt.indexOf("<tarea>"));
  assert.equal((await call(`/api/conversations/${s.conversation}`)).data.messages.length, 4);
});

test("older turns are compacted by the cheap model; only the last three exchanges go literally", async () => {
  await ask({ question: "Tercera pregunta sobre el ritmo", conversationId: s.conversation });
  await ask({ question: "Cuarta pregunta sobre el ritmo", conversationId: s.conversation });
  await clearAiLog();
  await ask({ question: "Quinta pregunta sobre el ritmo", conversationId: s.conversation });
  const log = await aiLog();
  assert.equal(log.length, 2);
  assert.match(log[0].body.system[0].text, /<resumen-conversacion>/);
  assert.equal(log[0].body.model, "claude-lector-e2e");
  assert.match(log[0].body.messages[0].content, /\[Autor\] ¿Funciona el ritmo/);
  const prompt = log[1].body.messages[0].content;
  assert.match(prompt, /Resumen de lo hablado antes \(ideas en discusión; nada de esto es un hecho de la novela\):\nResumen de la conversación: 2 mensajes anteriores\./);
  assert.doesNotMatch(prompt, /\[Autor\] ¿Funciona el ritmo/, "the first exchange only in the summary");
  assert.match(prompt, /\[Autor\] ¿Y el final\?/);
  assert.match(prompt, /\[Autor\] Cuarta pregunta/);
  const usage = await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.digest&order=created_at.desc&limit=1`);
  assert.equal(usage[0].model, "claude-lector-e2e");
});

test("conversations belong to their novel", async () => {
  const r = await call("/api/advisor", "POST", {
    novelId: other,
    chapterId: (await call(`/api/novels/${other}`)).data.chapters[0].id,
    content: "x",
    provider: "anthropic",
    question: "¿Qué tal?",
    conversationId: s.conversation,
  });
  assert.equal(r.status, 404);
  assert.equal((await call(`/api/novels/${other}/conversations`)).data.length, 0);
});

// ---------------------------------------------------------------- observations

test("observations: save, dismiss and resolve; listed by status", async () => {
  const [keep, drop] = s.obs;
  assert.equal((await call(`/api/observations/${keep}`, "PATCH", { status: "saved" })).data.status, "saved");
  assert.equal((await call(`/api/observations/${drop}`, "PATCH", { status: "dismissed" })).data.status, "dismissed");
  assert.equal((await call(`/api/observations/${keep}`, "PATCH", { status: "nope" })).status, 400);
  const list = (await call(`/api/novels/${novel}/observations?status=saved`)).data;
  assert.deepEqual(list.map((o) => o.id), [keep]);
  assert.equal((await call(`/api/novels/${novel}/observations?status=dismissed`)).data[0].id, drop);
  assert.equal((await call(`/api/novels/${novel}/observations?status=whatever`)).status, 400);
});

test("after an edit: 'based on an earlier version'; checking again finds the quote, or says it's gone", async () => {
  const [keep] = s.obs;
  await save(ch[1], `${T2}\n\nUn párrafo nuevo.`);
  let o = (await call(`/api/novels/${novel}/observations?status=saved`)).data[0];
  assert.deepEqual(o.changed, [ch[1]]);

  o = (await call(`/api/observations/${keep}/recheck`, "POST")).data;
  assert.deepEqual(o.changed, []);
  assert.equal(o.verified, true);
  assert.equal(o.refs[0].verified, true);

  await save(ch[1], "Todo reescrito.\n\nNada queda del texto anterior.");
  o = (await call(`/api/observations/${keep}/recheck`, "POST")).data;
  assert.deepEqual([o.verified, o.refs[0].verified, o.refs[0].at], [false, false, null], "the quote is no longer in the text");
  await save(ch[1], T2);
});

test("Proponer hecho: a suggested fact, not canon until approved", async () => {
  const r = await call(`/api/novels/${novel}/memory/facts`, "POST", {
    text: "Elena conoce el mar desde niña.",
    chapter_id: ch[1],
    status: "suggested",
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, "suggested");
  assert.equal((await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "x", status: "canon" })).status, 400);

  // The assistant doesn't use it until it is approved.
  await clearAiLog();
  await call("/api/assist", "POST", {
    novelId: novel, chapterId: ch[1], content: T2, provider: "anthropic", mode: "edit", action: "consistencia", selectionStart: 0, selectionEnd: 20,
  });
  assert.ok(!JSON.stringify((await aiLog())[0].body).includes("Elena conoce el mar desde niña"));
  const approved = (await call(`/api/memory/facts/${r.data.id}`, "PATCH", { status: "approved" })).data;
  assert.equal(approved.status, "approved");
  await clearAiLog();
  await call("/api/assist", "POST", {
    novelId: novel, chapterId: ch[1], content: T2, provider: "anthropic", mode: "edit", action: "consistencia", selectionStart: 0, selectionEnd: 20,
  });
  assert.ok(JSON.stringify((await aiLog())[0].body).includes("Elena conoce el mar desde niña"));
});

test("deleting a conversation keeps the saved observations; duplicating a novel copies none", async () => {
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", {})).data.id;
  assert.equal((await call(`/api/novels/${copy}/conversations`)).data.length, 0);
  assert.equal((await call(`/api/novels/${copy}/observations?status=saved`)).data.length, 0);
  await call(`/api/novels/${copy}`, "DELETE");

  assert.equal((await call(`/api/conversations/${s.conversation}`, "PATCH", { title: "Ritmo" })).status, 204);
  assert.equal((await call(`/api/conversations/${s.conversation}`, "DELETE")).status, 204);
  assert.equal((await call(`/api/conversations/${s.conversation}`)).status, 404);
  const kept = (await call(`/api/novels/${novel}/observations?status=saved`)).data;
  assert.deepEqual(kept.map((o) => [o.id, o.message_id]), [[s.obs[0], null]]);
  assert.equal((await rows("advisor_observations", `novel_id=eq.${novel}`)).length, 1, "the rest went with it");
  assert.equal((await rows("advisor_messages", `novel_id=eq.${novel}`)).length, 0);
});

// ---------------------------------------------------------------- panel

test("panel: a conversation in the Consejero; Guardar, Descartar, and a follow-up in the same thread", async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[1]]);
  // These are Analizar's cards and actions: the panel opens in Analizar (Conversar is the default).
  await page.addInitScript((n) => localStorage.setItem(`advisorMode:${n}`, "analizar"), novel);
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  const box = panel.getByRole("textbox", { name: "Pregunta al Consejero" });
  await box.fill("¿Qué personajes estoy desaprovechando?");
  await panel.getByRole("button", { name: "Preguntar" }).click();
  await panel.locator(".turn.advisor .observation").first().waitFor({ timeout: 15_000 });
  assert.equal(await panel.locator(".turn.author").innerText(), "¿Qué personajes estoy desaprovechando?");
  assert.equal(await box.inputValue(), "", "the box is ready for the next question");

  const cards = panel.locator(".turn.advisor .observation");
  await cards.nth(0).getByRole("button", { name: "Guardar" }).click();
  await cards.nth(0).locator(".tag", { hasText: "guardada" }).waitFor();
  await cards.nth(1).getByRole("button", { name: "Descartar" }).click();
  await cards.nth(1).getByText(/^Descartada:/).waitFor();

  await box.fill("¿Y Juan?");
  await box.press("Control+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".turn.author").length === 2, null, { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".turn.advisor").length === 2);
  const select = panel.getByRole("combobox", { name: "Conversación" });
  assert.deepEqual(await select.locator("option").allInnerTexts(), ["Nueva conversación", "¿Qué personajes estoy desaprovechando?"]);

  // A new conversation, then back to the first one.
  await panel.getByRole("button", { name: "Nueva", exact: true }).click();
  assert.equal(await panel.locator(".turn").count(), 0);
  await select.selectOption({ label: "¿Qué personajes estoy desaprovechando?" });
  await page.waitForFunction(() => document.querySelectorAll(".turn.author").length === 2);
});

test("panel: Guardadas shows the kept one; after an edit it can be checked again; Proponer hecho goes to Memoria", async () => {
  const panel = page.locator("aside.panel");
  await panel.getByRole("button", { name: "Guardadas" }).click();
  const list = panel.locator(".saved-observations .observation");
  await list.first().waitFor();
  const before = await list.count();
  assert.ok(before >= 1);
  const card = list.filter({ hasText: "Arranque lento" }).first();

  // Edit the chapter: the saved observation now relies on an earlier version.
  const editor = page.locator("textarea.editor");
  await editor.evaluate((el) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type(" Fin.");
  await page.waitForFunction(() => document.querySelector(".save")?.textContent === "Guardado", null, { timeout: 15_000 });
  await panel.getByRole("button", { name: "Consultar" }).click();
  await panel.getByRole("button", { name: "Guardadas" }).click();
  await card.locator(".changed").waitFor();
  assert.match(await card.locator(".changed").innerText(), /Basada en una versión anterior de Capítulo 2: Dos/);
  await card.getByRole("button", { name: "Volver a comprobar" }).click();
  await card.locator(".changed").waitFor({ state: "detached" });

  // Proponer hecho (on a problem card) → a suggested fact in Memoria.
  await panel.getByRole("button", { name: "Consultar" }).click();
  const problem = panel.locator(".turn.advisor .observation.obs-problem").first();
  await problem.waitFor();
  await problem.getByRole("button", { name: "Proponer hecho" }).click();
  await problem.getByRole("textbox", { name: "Hecho propuesto" }).fill("Elena vivió frente al mar.");
  await problem.getByRole("button", { name: "Añadir a Memoria" }).click();
  await problem.getByText("Hecho propuesto en Memoria").waitFor();
  const facts = (await call(`/api/novels/${novel}`)).data.memory.facts;
  const f = facts.find((x) => x.text === "Elena vivió frente al mar.");
  assert.equal(f.status, "suggested");
  assert.equal(f.chapter_id, null, "that card has no verified quote, so no chapter is assumed");
  await page.getByRole("button", { name: "Memoria" }).click();
  await page.getByRole("button", { name: /^Hechos/ }).click();
  await page.getByText("Sugerido por el Consejero, sin aprobar").first().waitFor();
});

test("panel: a thread card closes a known thread or creates a new one", async () => {
  const known = (await call(`/api/novels/${novel}/threads`, "POST", { title: "La carta de Marta" })).data;
  await page.keyboard.press("Escape"); // the Memoria dialog of the previous test
  const panel = page.locator("aside.panel");
  await panel.getByRole("button", { name: "Consultar" }).click();
  const turns = await panel.locator(".turn.advisor").count();
  await panel.getByRole("button", { name: "Cabos pendientes" }).click();
  await page.waitForFunction((n) => document.querySelectorAll(".turn.advisor").length > n, turns, { timeout: 15_000 });
  const last = panel.locator(".turn.advisor").last();
  await last.getByRole("button", { name: "Marcar cabo «La carta de Marta» cerrado" }).click();
  await last.getByRole("button", { name: "Marcar cabo «La carta de Marta» cerrado" }).waitFor({ state: "detached" });
  const t = (await call(`/api/novels/${novel}/threads`)).data.find((x) => x.id === known.id);
  assert.deepEqual([t.status, t.status_by], ["closed", "author"]);

  await last.locator(".observation", { hasText: "El viaje a Cartagena" }).getByRole("button", { name: "Crear cabo" }).click();
  await last.locator(".observation", { hasText: "El viaje a Cartagena" }).getByRole("button", { name: "Crear cabo" }).waitFor({ state: "detached" });
  const created = (await call(`/api/novels/${novel}/threads`)).data.find((x) => x.title === "El viaje a Cartagena");
  assert.deepEqual([created.origin, created.confirmed], ["author", true]);
});
