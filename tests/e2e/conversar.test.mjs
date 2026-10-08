// Consejero, Conversar (docs/consejero.md): a writing companion. «¿Cómo puedo continuar?» → one
// proposal; «Me gusta, desarróllala» → that one; «Quiero que Waldo…» → a decision kept as the
// plan (never canon); «Dame opciones» → several; «Analiza…» → that turn in Analizar.
// «Enviar al Asistente» → a brief the author reviews → the Asistente prepares the scene and
// writes nothing until the author applies it. API with the mock AI, then desktop and phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, ch, ids, browser, snapshot;
const s = {};

const T1 = "Pola y Casandra crecieron juntas en el puerto.\n\nCABO: El misterio de Casandra.\n\nNacho las miraba desde la escalera.";
const T2 = "Pola volvió a casa de madrugada.\n\nHéctor la esperaba en la cocina, con el café frío.";

const advise = (extra) => call("/api/advisor", "POST", { novelId: novel, chapterId: ch[1], content: T2, provider: "anthropic", ...extra });
const say = (question, extra = {}) => advise({ question, mode: "conversar", conversationId: s.conversation, ...extra });
const planOf = (list) => list.find((e) => e.type === "plan");
const cardsOf = (list) => list.find((e) => e.type === "observations");
const advisorCalls = async () => (await aiLog()).filter((x) => /<consejero>/.test(x.body.system?.[0]?.text ?? ""));
const lastCall = async () => (await advisorCalls()).at(-1).body;
const messages = async () => (await call(`/api/conversations/${s.conversation}`)).data.messages;
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  return (await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })).json();
}
/** Manuscript, Memoria, facts and threads: what the Consejero must never change. */
async function canon() {
  const n = (await call(`/api/novels/${novel}`)).data;
  const chapters = await Promise.all(ch.map(async (id) => (await call(`/api/chapters/${id}`)).data));
  return JSON.stringify({
    chapters: chapters.map((c) => [c.id, c.content, c.revision]),
    memory: n.memory,
    facts: await rows("facts", `novel_id=eq.${novel}&order=id`),
    threads: (await rows("story_threads", `novel_id=eq.${novel}&order=id`)).map((t) => [t.id, t.title, t.status]),
  });
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Casandra" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "La cocina" })).data.id);
  await call(`/api/chapters/${ch[0]}`, "PATCH", { content: T1, revision: 0 });
  await call(`/api/chapters/${ch[1]}`, "PATCH", { content: T2, revision: 0 });
  const create = async (kind, body) => (await call(`/api/novels/${novel}/memory/${kind}`, "POST", body)).data.id;
  ids = {
    pola: await create("characters", { name: "Pola" }),
    hector: await create("characters", { name: "Héctor" }),
    nacho: await create("characters", { name: "Nacho" }),
    waldo: await create("characters", { name: "Waldo" }),
    casandra: await create("characters", { name: "Casandra" }),
    casa: await create("places", { name: "Casa de Pola" }),
  };
  // An approved fact that a decision of the author will contradict.
  await create("facts", { text: "Waldo nunca conoció a Casandra.", character_ids: [ids.waldo, ids.casandra] });
  for (const id of ch) await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic" });
  snapshot = await canon();
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- the conversation

test("«¿Cómo puedo continuar?» in Conversar: one proposal, brief, no analysis tables; stored as a Conversar turn", async () => {
  await clearAiLog();
  const list = events((await advise({ question: "¿Cómo puedo continuar?", mode: "conversar" })).data);
  assert.deepEqual([planOf(list).action, planOf(list).mode], ["seguir", "conversar"]);
  assert.equal(cardsOf(list).items.length, 1, "one proposal, not three");
  const req = await lastCall();
  assert.match(req.system[0].text, /^<consejero>\nModo: conversar\./);
  assert.match(req.system[0].text, /Una propuesta principal/);
  assert.doesNotMatch(req.system[0].text, /De 0 a 8 observaciones/, "not the Analizar format");
  assert.match(req.messages[0].content, /Propón UNA dirección concreta/);
  assert.doesNotMatch(req.messages[0].content, /<datos>/, "no presence or repetition tables to comment on");
  assert.equal(req.max_tokens, 3000);
  s.conversation = list.find((e) => e.type === "saved").conversationId;
  const msgs = await messages();
  assert.deepEqual(msgs.map((m) => m.context?.mode), ["conversar", "conversar"]);
  assert.equal(msgs[1].context.cards[0].label, "A");
});

test("1. «Me gusta, desarróllala» continues exactly that proposal, without analysing the chapter again", async () => {
  await clearAiLog();
  const list = events((await say("Me gusta, desarróllala.")).data);
  assert.equal(planOf(list).action, "explorar");
  assert.match(planOf(list).detail, /^sobre A «Una escena cotidiana» \(la que acabo de proponer\)/);
  const req = await lastCall();
  assert.match(req.messages[0].content, /<propuesta-en-curso etiqueta="A">\nUna escena cotidiana/);
  assert.match(req.messages[0].content, /Desarróllala según lo que pide en su mensaje, sin volver a analizar/);
  const msgs = await messages();
  assert.equal(msgs.at(-2).context.anchor.how, "esa");
  assert.deepEqual(msgs.at(-1).context.cards, [{ label: "A2", from: "A" }]);
});

test("2. a decision of the author is kept as the plan, developed (not audited), never written into Memoria or facts", async () => {
  const decision = "Quiero que Waldo haya sido amigo de infancia de Pola y Casandra, y novio juvenil de Pola.";
  await clearAiLog();
  const list = events((await say(decision)).data);
  assert.equal(planOf(list).action, "explorar", "it develops the idea in course with the decision");
  assert.match(planOf(list).detail, /^sobre A2 /);
  const msgs = await messages();
  assert.deepEqual(msgs.at(-2).context.decisions, [decision]);
  // The next turn carries it as the plan; the contradicting approved fact comes too.
  await clearAiLog();
  await say("¿Cómo lo introduzco?");
  const req = await lastCall();
  assert.match(req.messages[0].content, new RegExp(`Decisiones del autor en esta conversación \\(PLAN[^\\n]*\\n- ${decision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(req.system[0].text, /Las decisiones que el autor toma en la conversación son su plan: no las discutes ni las vuelves a evaluar/);
  assert.match(req.system[0].text, /Sólo si esa decisión contradice el canon[^\n]*lo dices en una frase/);
  assert.match(req.messages[0].content, /Waldo nunca conoció a Casandra\./, "the approved fact it contradicts is in the context");
  assert.equal(await canon(), snapshot, "nothing written in the manuscript, Memoria, facts or threads");
});

test("«Dame opciones»: several, only because they were asked for; «No, mejor sin Nacho» is kept as discarded", async () => {
  const list = events((await say("Dame opciones")).data);
  assert.equal(planOf(list).action, "caminos");
  assert.equal(cardsOf(list).items.length, 3);
  await say("Quiero que también aparezca Nacho.");
  await say("No, mejor sin Nacho.");
  await clearAiLog();
  await say("¿Y ahora?");
  const prompt = (await lastCall()).messages[0].content;
  assert.match(prompt, /Descartado por el autor \(no lo propongas ni lo incluyas\):\n- No, mejor sin Nacho\./);
  assert.doesNotMatch(prompt.slice(prompt.indexOf("Decisiones del autor")), /^- Quiero que también aparezca Nacho\./m, "the later «sin Nacho» took it back");
});

test("an explicit analysis in Conversar: that turn in Analizar, with its cards; the next one is a conversation again", async () => {
  await clearAiLog();
  const list = events((await say("Analiza el capítulo")).data);
  assert.equal(planOf(list).mode, "analizar");
  assert.match(planOf(list).detail, /en modo Analizar, porque lo pediste/);
  assert.match((await lastCall()).system[0].text, /De 0 a 8 observaciones/);
  assert.ok(cardsOf(list).items.length >= 3, "the analysis cards");
  const again = events((await say("Gracias, sigamos")).data);
  assert.equal(planOf(again).mode, "conversar");
});

test("Analizar stays as it was: without a mode, «¿Cómo seguir?» gives the three paths A/B/C", async () => {
  const list = events((await advise({ action: "seguir" })).data);
  assert.equal(planOf(list).mode, "analizar");
  assert.equal(cardsOf(list).items.filter((o) => o.kind === "alternative").length, 3);
});

test("the plan can be edited: a decision removed or added by hand; bad input refused", async () => {
  const msgs = await messages();
  const with_ = msgs.findIndex((m) => m.context?.decisions?.length && m.context.decisions[0].startsWith("Quiero que Waldo"));
  assert.equal((await call(`/api/conversations/${s.conversation}`, "PATCH", { plan: { decisions: "x" } })).status, 400);
  assert.equal((await call(`/api/conversations/${s.conversation}`, "PATCH", { plan: { add: "Héctor no sabe nada de Waldo." } })).status, 204);
  assert.deepEqual((await messages()).at(-2).context.decisions, ["Héctor no sabe nada de Waldo."]);
  await call(`/api/conversations/${s.conversation}`, "PATCH", { plan: { messageId: msgs[with_].id, decisions: [] } });
  await call(`/api/conversations/${s.conversation}`, "PATCH", { plan: { messageId: msgs[with_].id, decisions: msgs[with_].context.decisions } });
  assert.deepEqual((await messages())[with_].context.decisions, msgs[with_].context.decisions);
  assert.equal(await canon(), snapshot);
});

// ---------------------------------------------------------------- «Enviar al Asistente»

test("3. «Enviar al Asistente»: a brief with the proposal, the decisions, the people, the destination and what was discarded", async () => {
  await clearAiLog();
  const msgs = await messages();
  const a2 = msgs.find((m) => m.context?.cards?.[0]?.label === "A2").observations[0];
  const r = await call("/api/advisor", "POST", { brief: true, novelId: novel, conversationId: s.conversation, anchorId: a2.id, provider: "anthropic" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s.brief = r.data;
  assert.match(s.brief.argument, /^Escena: Una escena cotidiana/);
  assert.ok(s.brief.decisions.includes("Quiero que Waldo haya sido amigo de infancia de Pola y Casandra, y novio juvenil de Pola."), "the author's words");
  assert.ok(s.brief.decisions.includes("Héctor no sabe nada de Waldo."));
  assert.ok(s.brief.discarded.includes("No, mejor sin Nacho."));
  assert.deepEqual(s.brief.constraints, ["No revelar todavía el misterio."]);
  assert.equal(s.brief.target, "end");
  assert.equal(s.brief.source, "Propuesta A2");
  const log = await aiLog();
  assert.equal(log.length, 1);
  assert.match(log[0].body.system[0].text, /<encargo-escena>/);
  assert.equal(log[0].body.model, "claude-lector-e2e", "the cheap model");
  const usage = await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.digest&order=created_at.desc&limit=1`);
  assert.equal(usage[0].model, "claude-lector-e2e");
  // Nothing stored, nothing written.
  assert.equal((await messages()).length, msgs.length);
  assert.equal(await canon(), snapshot);
});

test("the brief belongs to its conversation; without a usable answer it is made from the proposal", async () => {
  const other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  assert.equal((await call("/api/advisor", "POST", { brief: true, novelId: other, conversationId: s.conversation, provider: "anthropic" })).status, 404);
  // A conversation whose brief the model can't answer (mock hook in its plan).
  const list = events((await advise({ question: "¿Cómo puedo continuar?", mode: "conversar" })).data);
  const id = list.find((e) => e.type === "saved").conversationId;
  await call(`/api/conversations/${id}`, "PATCH", { plan: { add: "ENCARGO-ROTO" } });
  const r = await call("/api/advisor", "POST", { brief: true, novelId: novel, conversationId: id, provider: "anthropic" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.argument, /^Una escena cotidiana\. Yo continuaría con una escena cotidiana/);
  assert.deepEqual(r.data.decisions, ["ENCARGO-ROTO"]);
  const foreign = (await call(`/api/conversations/${id}`)).data.messages[1].observations[0].id;
  assert.equal((await call("/api/advisor", "POST", { brief: true, novelId: novel, conversationId: s.conversation, anchorId: foreign, provider: "anthropic" })).status, 400);
  await call(`/api/conversations/${id}`, "DELETE");
});

test("4. the Asistente receives the brief: decisions, limits and discards in the scene request; the manuscript untouched", async () => {
  const scene = (extra) =>
    call("/api/assist", "POST", {
      novelId: novel,
      chapterId: ch[1],
      content: T2,
      mode: "scene",
      argument: s.brief.argument,
      length: "media",
      characterIds: s.brief.characterIds,
      cursor: T2.length,
      provider: "anthropic",
      brief: { decisions: s.brief.decisions, constraints: s.brief.constraints, discarded: s.brief.discarded },
      ...extra,
    });
  const dry = await scene({ dryRun: true });
  assert.equal(dry.status, 200);
  const arg = dry.data.sections.find((x) => x.id === "argument");
  assert.ok(arg.items.some((i) => i.label === "Encargo del Consejero"), "Ver contexto shows it");
  await clearAiLog();
  const r = await scene({});
  assert.equal(r.status, 200);
  assert.ok(events(r.data).some((e) => e.type === "text"));
  const prompt = (await aiLog()).at(-1).body.messages[0].content;
  assert.match(prompt, /<argumento>\nEscena: Una escena cotidiana/);
  assert.match(prompt, /Encargo del Consejero: [^\n]*misma autoridad que el argumento[^\n]*\n<encargo_del_consejero>\nDecisiones del autor \(cúmplelas como el argumento\):\n- Quiero que Waldo/);
  assert.match(prompt, /Descartado por el autor \(no debe ocurrir ni aparecer\):\n- No, mejor sin Nacho\./);
  assert.match(prompt, /Restricciones \(no las rompas\):\n- No revelar todavía el misterio\./);
  // Without a brief, the scene is as before; a brief without an argument is refused.
  await clearAiLog();
  await scene({ brief: undefined });
  assert.doesNotMatch((await aiLog()).at(-1).body.messages[0].content, /encargo_del_consejero/);
  assert.equal((await scene({ argument: "" })).status, 400);
  assert.equal(await canon(), snapshot, "a scene request writes nothing: the author applies it");
});

// ---------------------------------------------------------------- panel

async function openConsejero(page, tap = false) {
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  const link = page.locator(".topbar .link", { hasText: "Consejero" });
  await (tap ? link.tap() : link.click());
  const panel = page.locator("aside.panel");
  await panel.getByRole("group", { name: "Modo del Consejero" }).waitFor();
  return panel;
}

test("desktop: Conversar by default → one proposal → «Desarrollar idea» → decision in the plan → «Enviar al Asistente» → brief → the Asistente, nothing applied", async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[1]]);
  const panel = await openConsejero(page);
  const modes = panel.getByRole("group", { name: "Modo del Consejero" });
  assert.equal(await modes.getByRole("button", { name: "Conversar" }).getAttribute("aria-pressed"), "true");
  await panel.getByRole("combobox", { name: "Conversación" }).selectOption("");
  assert.deepEqual(await panel.getByRole("group", { name: "Acciones del Consejero" }).locator("button").allInnerTexts(), [
    "¿Cómo continúo?",
    "Dame opciones",
    "Necesito un giro",
    "¿Qué pasa si…?",
  ]);
  assert.equal(await panel.getByText("Lectura profunda").count(), 0, "technical options only in Analizar");

  const box = panel.getByRole("textbox", { name: "Pregunta al Consejero" });
  await box.fill("¿Cómo puedo continuar?");
  await panel.getByRole("button", { name: "Enviar", exact: true }).click();
  const turn = () => panel.locator(".turn.advisor.chat").last();
  await turn().locator(".proposal").first().waitFor({ timeout: 15_000 });
  assert.equal(await turn().locator(".proposal").count(), 1);
  assert.equal(await turn().locator(".obs-kind, .obs-refs").count(), 0, "no kinds, confidence or reference lists");
  assert.match(await turn().locator(".proposal-head").innerText(), /Propuesta A/);

  await turn().getByRole("button", { name: "Desarrollar idea" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".turn.advisor.chat").length === 2, null, { timeout: 15_000 });
  assert.match(await panel.locator(".turn.author").last().innerText(), /sobre A\n/i);

  await box.fill("Quiero que Waldo haya sido novio juvenil de Pola.");
  await box.press("Control+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".turn.advisor.chat").length === 3, null, { timeout: 15_000 });
  const planBar = panel.locator(".plan-bar");
  await planBar.getByText("Quiero que Waldo haya sido novio juvenil de Pola.").waitFor();

  await turn().getByRole("button", { name: "Enviar al Asistente" }).click();
  const brief = panel.getByRole("region", { name: "Encargo para el Asistente" });
  await brief.waitFor({ timeout: 15_000 });
  assert.equal(await brief.getByRole("textbox", { name: "Decisiones 1" }).inputValue(), "Quiero que Waldo haya sido novio juvenil de Pola.");
  const argument = brief.getByRole("textbox", { name: "Qué ocurre en la escena" });
  await argument.fill(`${await argument.inputValue()} Pola no le cuenta nada a Héctor.`);
  await brief.getByRole("button", { name: "Llevar al Asistente" }).click();

  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  const sceneArg = page.getByPlaceholder(/Qué ocurre en la escena/);
  assert.match(await sceneArg.inputValue(), /Pola no le cuenta nada a Héctor\.$/);
  assert.match(await panel.locator(".brief-note").innerText(), /Del Consejero \(Propuesta A3\): 1 decisión/);
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar al final" }).waitFor({ timeout: 15_000 });
  const sent = (await aiLog()).at(-1).body.messages[0].content;
  assert.match(sent, /<encargo_del_consejero>\nDecisiones del autor \(cúmplelas como el argumento\):\n- Quiero que Waldo haya sido novio juvenil de Pola\./);
  assert.equal(await page.locator("textarea.editor").inputValue(), T2, "the proposal waits: nothing written until the author applies it");
  await ctx.close();
});

test("phone: Conversar in the sheet; «envíala al Asistente» typed opens the brief; no horizontal scroll", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[1]]);
  const panel = await openConsejero(page, true);
  await panel.getByRole("combobox", { name: "Conversación" }).selectOption("");
  await panel.getByRole("button", { name: "¿Cómo continúo?" }).tap();
  await panel.locator(".turn.advisor.chat .proposal").first().waitFor({ timeout: 15_000 });
  const box = panel.getByRole("textbox", { name: "Pregunta al Consejero" });
  await box.fill("Envíala al Asistente");
  await panel.getByRole("button", { name: "Enviar", exact: true }).tap();
  const brief = panel.getByRole("region", { name: "Encargo para el Asistente" });
  await brief.waitFor({ timeout: 15_000 });
  assert.equal(await panel.locator(".turn.author").count(), 1, "the handoff is not sent as a message");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll");
  await brief.getByRole("button", { name: "Llevar al Asistente" }).tap();
  assert.equal(await panel.getAttribute("aria-label"), "Asistente");
  assert.match(await page.getByPlaceholder(/Qué ocurre en la escena/).inputValue(), /^Escena: Una escena cotidiana/);
  assert.equal(await page.locator("textarea.editor").inputValue(), T2);
  await ctx.close();
});
