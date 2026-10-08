// Consejero creativo, phase 1 (docs/consejero.md): a creative conversation that
// remembers its proposals. "No sé cómo continuar" → A, B, C; "Me gusta el segundo" → B,
// developed as B2; "Pero quiero que también aparezca Nacho" → B3 with Nacho, from what the
// novel says of him; "No, mejor sin Nacho" → B4. Nothing of it becomes canon: the manuscript, Memoria,
// facts and threads stay as they were. API with the mock AI, then the panel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, ch, ids, browser, snapshot;
const s = {};

const T1 = "Elena guardó la carta en el cajón de la cocina.\n\nCABO: La carta de la madre.\n\nNacho la vio desde el patio y no dijo nada.";
const T2 = "Elena bajó al puerto con la carta en el bolsillo.\n\nJuan la esperaba junto a las redes.";

const advise = (extra) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId: ch[1], content: T2, provider: "anthropic", ...extra });
const say = (question, extra = {}) => advise({ question, conversationId: s.conversation, ...extra });
const saved = (list) => list.find((e) => e.type === "saved");
const planOf = (list) => list.find((e) => e.type === "plan");
const lastPrompt = async () => (await aiLog()).filter((x) => /<consejero>/.test(x.body.system?.[0]?.text ?? "")).at(-1).body.messages[0].content;
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  return (await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })).json();
}
const messages = async () => (await call(`/api/conversations/${s.conversation}`)).data.messages;
/** The cards of the last answer, with their labels as stored. */
async function lastCards() {
  const list = await messages();
  const m = list.filter((x) => x.role === "advisor").at(-1);
  return m.observations.map((o, k) => ({ ...o, label: m.context.cards[k].label, from: m.context.cards[k].from }));
}
/** Everything the Consejero must never touch: manuscript, Memoria, facts, threads. */
async function canon() {
  const n = (await call(`/api/novels/${novel}`)).data;
  const chapters = await Promise.all(ch.map(async (id) => (await call(`/api/chapters/${id}`)).data));
  return JSON.stringify({
    chapters: chapters.map((c) => [c.id, c.content, c.revision]),
    memory: n.memory,
    facts: await rows("facts", `novel_id=eq.${novel}&order=id`),
    threads: (await rows("story_threads", `novel_id=eq.${novel}&order=id`)).map((t) => [t.id, t.title, t.status, t.confirmed]),
  });
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "La carta" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "El puerto" })).data.id);
  await call(`/api/chapters/${ch[0]}`, "PATCH", { content: T1, revision: 0 });
  await call(`/api/chapters/${ch[1]}`, "PATCH", { content: T2, revision: 0 });
  const create = async (kind, body) => (await call(`/api/novels/${novel}/memory/${kind}`, "POST", body)).data.id;
  ids = {
    elena: await create("characters", { name: "Elena", secrets: "Esconde la carta de su madre", unaware: "Que Nacho la vio esconderla" }),
    nacho: await create("characters", { name: "Nacho", secrets: "Vio a Elena esconder la carta", motivations: "Recuperar el trabajo en el puerto" }),
    juan: await create("characters", { name: "Juan" }),
  };
  await create("relationships", { from_id: ids.nacho, to_id: ids.elena, kind: "hermano de", note: "se hablan poco" });
  await create("facts", { text: "Nacho perdió su trabajo en el puerto en invierno.", character_ids: [ids.nacho] });
  // Cronología: chapter 1 in 1972, chapter 2 in 1973; Elena is 21 in chapter 1.
  await call(`/api/chapters/${ch[0]}/time`, "PUT", { when: { date: { year: 1972 } } });
  await call(`/api/chapters/${ch[1]}/time`, "PUT", { when: { date: { year: 1973 } } });
  await call(`/api/memory/characters/${ids.elena}`, "PATCH", { age_anchor: { kind: "age_at", age: 21, at: { chapter_id: ch[0] } } });
  for (const id of ch) await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic" });
  snapshot = await canon();
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

// ---------------------------------------------------------------- the mandatory flow

test("«No sé cómo continuar.» → three paths, Camino A, B and C, each with its sections and quotes", async () => {
  await clearAiLog();
  const list = events((await advise({ question: "No sé cómo continuar." })).data);
  assert.equal(planOf(list).action, "seguir");
  assert.equal(planOf(list).label, "¿Cómo continúo?");
  const obs = list.find((e) => e.type === "observations");
  assert.deepEqual(obs.labels, [
    { label: "A", from: null },
    { label: "B", from: null },
    { label: "C", from: null },
  ]);
  assert.deepEqual(obs.items.map((o) => o.kind), ["alternative", "alternative", "alternative"]);
  const b = obs.items[1];
  assert.match(b.body, /^Qué podría ocurrir: .+\nPor qué funciona aquí: .+\nQué aprovecha: .+\nConsecuencias: .+\nRiesgos: .+\nPersonajes: /m);
  assert.equal(b.verified, true, "grounded with a verified quote");
  const prompt = await lastPrompt();
  assert.match(prompt, /Propón exactamente 3 caminos distintos/);
  assert.match(prompt, /"porque" \(por qué funciona específicamente en esta novela\)/);
  s.conversation = saved(list).conversationId;
  s.first = await lastCards();
  assert.deepEqual(s.first.map((c) => c.label), ["A", "B", "C"]);
});

test("1. «Me gusta el segundo.» is Camino B, unambiguously: told to the model and stored with the author's turn", async () => {
  await clearAiLog();
  const list = events((await say("Me gusta el segundo.")).data);
  const plan = planOf(list);
  assert.equal(plan.action, "explorar");
  assert.equal(plan.label, "Desarrollar propuesta · B");
  assert.match(plan.detail, /^sobre B «Recuperar un cabo» \(por su orden\)/);
  const prompt = await lastPrompt();
  assert.match(prompt, /<propuesta-en-curso etiqueta="B">\nRecuperar un cabo\nQué podría ocurrir: /);
  assert.match(prompt, /\(Es una posibilidad que el autor está pensando, no un hecho de la novela\.\)/);
  assert.match(prompt, /El autor sigue con la propuesta B \(«Recuperar un cabo»\).*se mostrará como B2, versión de B/);
  assert.match(prompt, /\[Consejero\] .*\nTarjetas: A «Seguir el conflicto» · B «Recuperar un cabo» · C «Cambiar de personaje»/s);
  const msgs = await messages();
  assert.deepEqual(msgs.at(-2).context.anchor, { id: s.first[1].id, label: "B", title: "Recuperar un cabo", how: "ordinal" });
  const [b2] = await lastCards();
  assert.deepEqual([b2.label, b2.from], ["B2", "B"]);
});

test("«Pero quiero que también aparezca Nacho.» keeps developing B (now B2) into B3, with what the novel says of Nacho", async () => {
  await clearAiLog();
  const list = events((await say("Pero quiero que también aparezca Nacho.")).data);
  assert.equal(planOf(list).action, "explorar");
  assert.match(planOf(list).detail, /^sobre B2 .*\(la que estamos desarrollando\) · personajes: Nacho/);
  const prompt = await lastPrompt();
  assert.match(prompt, /<propuesta-en-curso etiqueta="B2" version-de="B">/);
  // Nacho's real information: his file, his relationship with Elena, his approved fact, a passage.
  assert.match(prompt, /### Nacho/);
  assert.match(prompt, /Vio a Elena esconder la carta/);
  assert.match(prompt, /Nacho → hermano de → Elena \(se hablan poco\)/);
  assert.match(prompt, /Nacho perdió su trabajo en el puerto en invierno\./);
  assert.match(prompt, /Nacho la vio desde el patio y no dijo nada\./);
  const [b3] = await lastCards();
  assert.deepEqual([b3.label, b3.from], ["B3", "B2"]);
  assert.match(b3.body, /Personajes: .*Nacho/);
});

test("«No, mejor sin Nacho.» → B4: the conversation evolves; every earlier version is kept; nothing is canon", async () => {
  await clearAiLog();
  const list = events((await say("No, mejor sin Nacho.")).data);
  assert.match(planOf(list).detail, /^sobre B3 /);
  const [b4] = await lastCards();
  assert.deepEqual([b4.label, b4.from], ["B4", "B3"]);
  // The next request sees the states, computed from what the author did.
  await clearAiLog();
  await say("¿Qué te parece así?", { dryRun: false });
  const prompt = await lastPrompt();
  assert.match(prompt, /Estado actual de las tarjetas \(manda sobre el resumen\):\nPropuestas y observaciones de esta conversación \(\d+\)\. Ninguna es un hecho de la novela/);
  assert.match(prompt, /- B · MODIFICADO → B2 \(lo eligió el autor\) — «Recuperar un cabo»/);
  assert.match(prompt, /- B3 · versión de B2 · MODIFICADO → B4/);
  assert.match(prompt, /- A · PROPUESTO — «Seguir el conflicto»/);
  assert.match(prompt, /\[Autor, sobre B3\] No, mejor sin Nacho\./);
  const system = (await aiLog()).filter((x) => /<consejero>/.test(x.body.system?.[0]?.text ?? "")).at(-1).body.system[0].text;
  assert.match(system, /La conversación no es una fuente de hechos/);
  // B, as first proposed, is untouched.
  const b = (await messages()).flatMap((m) => m.observations).find((o) => o.id === s.first[1].id);
  assert.equal(b.body, s.first[1].body);
  assert.equal(b.status, "new");
  assert.equal(await canon(), snapshot, "manuscript, Memoria, facts and threads unchanged");
});

// ---------------------------------------------------------------- references

test("2. «la B» resolves to Camino B (by its letter), even after its versions", async () => {
  const list = events((await say("Vuelve a la B, la original.")).data);
  assert.match(planOf(list).detail, /^sobre B «Recuperar un cabo» \(por su letra\)/);
  assert.equal((await messages()).at(-2).context.anchor.id, s.first[1].id);
  const [v] = await lastCards();
  assert.deepEqual([v.label, v.from], ["B6", "B"], "a new version of B; B2–B5 stay");
});

test("3. «el último» resolves to the last card of the most recent answer with cards", async () => {
  const fresh = events((await say("Dame 3 caminos distintos")).data);
  assert.equal(planOf(fresh).action, "caminos");
  assert.match(planOf(fresh).detail, /^(?!sobre)/, "asking for new paths doesn't inherit the proposal in course");
  const three = await lastCards();
  assert.deepEqual(three.map((c) => c.label), ["D", "E", "F"]);
  const list = events((await say("Me quedo con el último.")).data);
  assert.match(planOf(list).detail, /^sobre F «Cambiar de personaje» \(la última\)/);
  assert.equal((await messages()).at(-2).context.anchor.id, three[2].id);
});

test("4. «Seguir con esta» anchors to exactly that card; a card of another conversation is refused", async () => {
  const a = s.first[0];
  await clearAiLog();
  const list = events((await say("Sigamos con el camino A: «Seguir el conflicto».", { anchorId: a.id })).data);
  assert.match(planOf(list).detail, /^sobre A «Seguir el conflicto» \(con «Seguir con esta»\)/);
  assert.match(await lastPrompt(), /<propuesta-en-curso etiqueta="A">/);
  assert.deepEqual((await messages()).at(-2).context.anchor, { id: a.id, label: "A", title: "Seguir el conflicto", how: "boton" });
  // The button wins over the words: "el segundo" here is still A.
  const again = events((await say("el segundo", { anchorId: a.id })).data);
  assert.match(planOf(again).detail, /^sobre A /);
  // A card from another conversation.
  const other = saved(events((await advise({ question: "No sé cómo continuar." })).data));
  const foreign = (await call(`/api/conversations/${other.conversationId}`)).data.messages[1].observations[0].id;
  const r = await say("Sigamos con esta", { anchorId: foreign });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no es de esta conversación/);
  await call(`/api/conversations/${other.conversationId}`, "DELETE");
});

test("«Soltar»: the next message is not about the proposal in course", async () => {
  const kept = (await say("¿Y lo de la cocina?", { dryRun: true })).data.plan;
  assert.match(kept.detail, /^sobre A3 .*\(la que estamos desarrollando\)/, "inherited by default");
  const released = (await say("¿Y lo de la cocina?", { release: true, dryRun: true })).data.plan;
  assert.doesNotMatch(released.detail, /sobre/);
});

// ---------------------------------------------------------------- discarding, compaction

test("6. «Descarta la C»: the card is discarded (only its status); it comes back as a title marked not true, never as a fact", async () => {
  const c = s.first[2];
  await say("Descarta la C, no me convence.");
  assert.equal((await rows("advisor_observations", `id=eq.${c.id}`))[0].status, "dismissed");
  await clearAiLog();
  await say("¿Qué otra cosa podría pasar en el puerto?");
  const prompt = await lastPrompt();
  assert.match(prompt, /- C · DESCARTADO por el autor — «Cambiar de personaje»\. No la propongas de nuevo salvo que el autor la recupere; no es verdad en la novela\./);
  assert.doesNotMatch(prompt.slice(prompt.indexOf("Estado actual de las tarjetas")), /- C · DESCARTADO[^\n]*Qué podría ocurrir/, "not its body");
  assert.doesNotMatch(prompt.slice(0, prompt.indexOf("<conversacion>")), /Cambiar de personaje/, "nowhere outside the conversation");
  assert.equal((await rows("facts", `novel_id=eq.${novel}&text=ilike.*personaje*`)).length, 0);
  // Choosing it again by name brings it back: the author recovered it.
  await say("Recuperemos la C");
  assert.equal((await rows("advisor_observations", `id=eq.${c.id}`))[0].status, "new");
  await say("Al final descarta la C");
  assert.equal((await rows("advisor_observations", `id=eq.${c.id}`))[0].status, "dismissed");
  assert.equal(await canon(), snapshot);
});

test("7. compaction keeps proposals as states, never as facts; the states after it are computed, and win", async () => {
  await clearAiLog();
  await say("¿Y en el puerto, de noche?");
  const log = await aiLog();
  const digests = log.filter((x) => /<resumen-conversacion>/.test(x.body.system?.[0]?.text ?? ""));
  assert.ok(digests.length >= 1, "the conversation was compacted");
  const sys = digests.at(-1).body.system[0].text;
  assert.match(sys, /PROPUESTO[\s\S]*ELEGIDO PARA EXPLORAR[\s\S]*MODIFICADO[\s\S]*DESCARTADO/);
  assert.match(sys, /Ninguno de estos estados es un hecho de la novela/);
  assert.match(sys, /escribe «el autor eligió explorar B», no «Elena muere»/);
  const input = digests.at(-1).body.messages[0].content;
  assert.match(input, /<estado-de-las-tarjetas>\nPropuestas y observaciones de esta conversación/);
  assert.match(input, /- C · DESCARTADO por el autor — «Cambiar de personaje»/, "the states as they are now");
  assert.match(input, /- B · MODIFICADO/);
  assert.equal(digests.at(-1).body.model, "claude-lector-e2e", "the cheap model");
  const prompt = await lastPrompt();
  assert.match(prompt, /Resumen de lo hablado antes \(ideas en discusión; nada de esto es un hecho de la novela\):/);
  assert.ok(prompt.indexOf("Resumen de lo hablado antes") < prompt.indexOf("Estado actual de las tarjetas"), "the states come after, and win");
  // The summary goes inside the conversation, never with the Memoria or the facts.
  const memory = prompt.slice(prompt.indexOf("# Memoria narrativa"), prompt.indexOf("<conversacion>"));
  assert.doesNotMatch(memory, /Resumen de la conversación/);
  assert.equal(await canon(), snapshot);
});

// ---------------------------------------------------------------- recipes

test("8. Cronología reaches the Consejero: the time of each chapter, the «now», and the ages", async () => {
  await clearAiLog();
  await advise({ action: "seguir" });
  const prompt = await lastPrompt();
  assert.match(prompt, /<cronologia>\nTiempo del relato por capítulo:\n- Capítulo 1[^\n]*: 1972\n- Capítulo 2: El puerto: 1973 \(capítulo abierto: el «ahora» del relato\)/);
  assert.match(prompt, /## Tiempo del relato\nEn este punto: 1973\./);
  assert.match(prompt, /### Elena[\s\S]*22 años/);
  const dry = (await advise({ action: "seguir", dryRun: true })).data;
  assert.ok(dry.parts.some((p) => p.label === "Cronología"));
});

test("9. Consecuencias (¿Qué pasa si…?) reads the people involved: files, relationships, approved facts, what they don't know", async () => {
  await clearAiLog();
  const list = events((await advise({ question: "¿Qué pasa si Nacho le cuenta a Elena que la vio esconder la carta?" })).data);
  assert.equal(planOf(list).action, "consecuencias");
  const prompt = await lastPrompt();
  assert.match(prompt, /qué pasaría si ocurriera lo que plantea/);
  assert.match(prompt, /Es una hipótesis, no un hecho/);
  assert.match(prompt, /Nacho → hermano de → Elena/);
  assert.match(prompt, /Nacho perdió su trabajo en el puerto en invierno\./);
  assert.match(prompt, /Que Nacho la vio esconderla/, "what Elena doesn't know");
  assert.match(prompt, /Esconde la carta de su madre/);
  assert.match(prompt, /<cronologia>/);
  const kinds = list.find((e) => e.type === "observations").items.map((o) => o.kind);
  assert.deepEqual(kinds, ["contradiction", "opportunity", "problem"]);
});

test("10. Necesito un giro: built from real elements of the novel (secrets, what someone ignores, threads, quotes)", async () => {
  await clearAiLog();
  const list = events((await advise({ action: "giro" })).data);
  assert.equal(planOf(list).label, "Necesito un giro");
  const prompt = await lastPrompt();
  assert.match(prompt, /SÓLO con elementos que ya existen en la novela/);
  assert.match(prompt, /Secretos y lo que cada personaje no sabe \(de la Memoria\):\n- Elena: secretos: Esconde la carta de su madre\. no sabe: Que Nacho la vio esconderla\.\n- Nacho: secretos: Vio a Elena esconder la carta\./);
  assert.match(prompt, /Cabos abiertos y capítulos sin aparecer:\n- «La carta de la madre»/);
  const items = list.find((e) => e.type === "observations").items;
  assert.equal(items.length, 3);
  for (const o of items) {
    assert.equal(o.kind, "alternative");
    assert.match(o.body, /Qué aprovecha: El secreto de Elena: Esconde la carta de su madre/);
    assert.equal(o.verified, true);
  }
  // Busca oportunidades and Subir tensión: their recipes, with the same material.
  await clearAiLog();
  assert.equal(planOf(events((await advise({ action: "oportunidades" })).data)).label, "Busca oportunidades");
  assert.match(await lastPrompt(), /Secretos y lo que cada personaje no sabe/);
  assert.equal(planOf(events((await advise({ question: "Quiero subir la tensión" })).data)).action, "tension");
});

test("creative answers have more room; analytic ones keep theirs; the Consejero's model and costs as before", async () => {
  await clearAiLog();
  await advise({ action: "caminos" });
  await advise({ action: "analizar" });
  const [creative, analytic] = (await aiLog()).filter((x) => /<consejero>/.test(x.body.system?.[0]?.text ?? ""));
  assert.equal(creative.body.max_tokens, 6000);
  assert.equal(analytic.body.max_tokens, 4000);
  assert.equal(creative.body.model, analytic.body.model);
  const usage = await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.advise&order=created_at.desc&limit=2`);
  assert.equal(usage.length, 2);
  assert.ok(usage.every((u) => u.model === creative.body.model));
});

test("11. the Consejero never modifies the manuscript, Memoria, facts or threads by itself", async () => {
  assert.equal(await canon(), snapshot);
  for (const x of await aiLog()) {
    if (/<consejero>/.test(x.body.system?.[0]?.text ?? "")) assert.match(x.body.system[0].text, /Nunca escribas texto para el manuscrito/);
  }
});

test("12. a long conversation: labels stay unique, «la B» is still the first B after compaction, the context stays bounded", async () => {
  for (let i = 0; i < 6; i++) await say(`Dame 3 caminos distintos, ronda ${i}`);
  await clearAiLog();
  const list = events((await say("Volvamos a la B")).data);
  assert.match(planOf(list).detail, /^sobre B «Recuperar un cabo» \(por su letra\)/);
  assert.equal((await messages()).at(-2).context.anchor.id, s.first[1].id);
  const all = (await messages()).filter((m) => m.role === "advisor" && m.context?.cards).flatMap((m) => m.context.cards.map((c) => c.label));
  assert.equal(new Set(all).size, all.length, "no label repeats");
  const conv = (await rows("advisor_conversations", `id=eq.${s.conversation}`))[0];
  assert.ok(conv.summarized_count > 6, "older turns are in the summary");
  const prompt = await lastPrompt();
  const block = prompt.slice(prompt.indexOf("<conversacion>"), prompt.indexOf("</conversacion>"));
  assert.ok(block.length < 30_000, `the conversation stays bounded (${block.length})`);
  assert.match(block, /- B · MODIFICADO/, "B's state survives compaction");
  assert.equal(await canon(), snapshot);
});

// ---------------------------------------------------------------- panel

test("panel: discreet quick actions; «¿Cómo continúo?» → Camino A, B, C; «Seguir con esta»; the proposal in course; «Soltar»", async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[1]]);
  // These are Analizar's cards and actions: the panel opens in Analizar (Conversar is the default).
  await page.addInitScript((n) => localStorage.setItem(`advisorMode:${n}`, "analizar"), novel);
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  const quick = panel.getByRole("group", { name: "Acciones del Consejero" });
  const rowsOf = quick.locator(".quick-row");
  assert.deepEqual(await rowsOf.nth(0).locator("button").allInnerTexts(), [
    "¿Cómo continúo?",
    "3 caminos",
    "Busca oportunidades",
    "Cabos pendientes",
    "Necesito un giro",
    "Subir tensión",
    "¿Qué pasa si…?",
  ]);
  assert.deepEqual(await rowsOf.nth(1).locator("button").allInnerTexts(), ["Analizar capítulo", "Repeticiones", "Coherencia", "Personajes"]);
  assert.deepEqual(await rowsOf.locator(".quick-label").allInnerTexts(), ["PENSAR JUNTOS", "REVISAR"]);
  assert.equal(await quick.locator("button.btn").count(), 0, "links, not big buttons");
  assert.equal(await quick.getByRole("button", { name: "Personajes desaprovechados" }).count(), 0, "phase 3");

  // "¿Qué pasa si…?" only starts the question.
  await quick.getByRole("button", { name: "¿Qué pasa si…?" }).click();
  const box = panel.getByRole("textbox", { name: "Pregunta al Consejero" });
  assert.equal(await box.inputValue(), "¿Qué pasa si ");
  await box.fill("");

  await panel.getByRole("combobox", { name: "Conversación" }).selectOption("");
  await quick.getByRole("button", { name: "¿Cómo continúo?" }).click();
  const turn = panel.locator(".turn.advisor").last();
  await turn.locator(".observation").nth(2).waitFor({ timeout: 15_000 });
  assert.deepEqual(await turn.locator(".obs-label").allInnerTexts(), ["Camino A", "Camino B", "Camino C"]);
  assert.match(await turn.locator(".observation").nth(1).locator(".obs-sections").innerText(), /Qué podría ocurrir[\s\S]*Por qué funciona aquí[\s\S]*Riesgos/);

  await turn.locator(".observation").nth(1).getByRole("button", { name: "Seguir con esta" }).click();
  const author = panel.locator(".turn.author").last();
  await page.waitForFunction(() => [...document.querySelectorAll(".turn.author")].at(-1)?.textContent?.includes("sobre B"), null, { timeout: 15_000 });
  assert.match(await author.innerText(), /Sigamos con el camino B: «Recuperar un cabo»/);
  const chip = panel.locator(".focus-chip");
  await chip.waitFor();
  assert.match(await chip.innerText(), /Desarrollando B2 «Recuperar un cabo/);
  assert.match(await panel.locator(".turn.advisor").last().locator(".obs-label").first().innerText(), /B2 · versión de B/);
  await chip.getByRole("button", { name: "Soltar" }).click();
  assert.equal(await chip.count(), 0);
  assert.equal(await page.locator("textarea.editor").inputValue(), T2, "nothing written in the manuscript");
  await ctx.close();
});
