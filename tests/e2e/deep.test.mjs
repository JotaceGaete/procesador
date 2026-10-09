// Consejero, phase 5 (docs/consejero.md): lectura profunda. A long novel (28 chapters)
// where answering means connecting things far apart; the model asks for material in
// rounds, within limits, and pauses to ask the author above the threshold.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, ch, browser, page;
const s = {};
const N = 28;
const CURRENT = 26; // chapter 27, where the author is writing

const filler = (i) =>
  Array.from({ length: 12 }, (_, k) => `En el capítulo ${i + 1} la casa ${k} seguía igual, con las persianas bajas y el reloj parado.`).join("\n\n");
const TEXT = Array.from({ length: N }, (_, i) => filler(i));
TEXT[1] += "\n\nRosa se despidió en la estación y no volvió a escribir.";
TEXT[2] += "\n\nElena juró que nunca había visto el mar.";
TEXT[3] += "\n\nMarta le contó a Juan que ella era su madre.";
TEXT[25] += "\n\nJuan descubrió que su madre era Rosa, no Marta.";
TEXT[CURRENT] = `Elena recordó los veranos en Cartagena, frente al mar.\n\n${filler(CURRENT)}`;
// Two very long chapters, to reach the confirmation threshold with real sizes.
TEXT[4] += `\n\n${"Un párrafo larguísimo del capítulo cinco que sigue y sigue sin decir nada nuevo. ".repeat(1200)}`;
TEXT[5] += `\n\n${"Un párrafo larguísimo del capítulo seis que tampoco aporta nada a la historia. ".repeat(1200)}`;

const ask = (question, extra = {}) =>
  call("/api/advisor", "POST", { novelId: novel, chapterId: ch[CURRENT], content: TEXT[CURRENT], provider: "anthropic", question, ...extra });
const typeOf = (list, t) => list.find((e) => e.type === t);
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  return (await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })).json();
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "La larga" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (let i = 1; i < N; i++) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "" })).data.id);
  for (let i = 0; i < N; i++) await call(`/api/chapters/${ch[i]}`, "PATCH", { content: TEXT[i], revision: 0 });
  for (const name of ["Elena", "Juan", "Marta", "Rosa"]) await call(`/api/novels/${novel}/memory/characters`, "POST", { name });
  const juan = (await call(`/api/novels/${novel}`)).data.memory.characters.find((c) => c.name === "Juan").id;
  await call(`/api/novels/${novel}/memory/facts`, "POST", { text: "Juan es hijo de Marta.", chapter_id: ch[3], character_ids: [juan] });
  // Only some chapters have been read: the recipe doesn't read the whole novel either.
  for (const i of [1, 2]) await call(`/api/chapters/${ch[i]}/digest`, "POST", { provider: "anthropic" });
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

test("the first answer starts from the hierarchical context; without requests there is one round", async () => {
  await clearAiLog();
  const list = events((await ask("¿Funciona el ritmo de este capítulo?")).data);
  const log = await aiLog();
  assert.equal(log.length, 1);
  assert.match(log[0].body.system[0].text, /<lectura-profunda>/, "the model knows it may ask");
  assert.ok(!typeOf(list, "material"), "nothing extra read");
  // A long novel is not sent: the first request is a fraction of it.
  const novelChars = TEXT.reduce((n, t) => n + t.length, 0);
  const sent = JSON.stringify(log[0].body).length;
  assert.ok(sent < novelChars * 0.2, `${sent} vs ${novelChars}`);
  assert.doesNotMatch(log[0].body.messages[0].content, /<capitulo numero="3"/);
});

test("chapter 3 ↔ chapter 27: it asks for passages, connects them, quotes both, and the cost of every round is logged", async () => {
  await clearAiLog();
  const before = (await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.advise`)).length;
  const q = '¿Es coherente que Elena recuerde el mar? PEDIR: [{"tipo":"pasajes","buscar":"mar","personaje":"Elena"}]';
  const list = events((await ask(q)).data);
  const log = await aiLog();
  assert.equal(log.length, 2, "one request round, then the answer");
  const second = log[1].body.messages[0].content;
  assert.match(second, /Material que pediste:\n<material ronda="1">\n### Pasajes «mar» · Elena/);
  assert.ok(second.indexOf("[Capítulo 3]\nElena juró que nunca había visto el mar.") !== -1);
  assert.deepEqual(typeOf(list, "reading"), { type: "reading", round: 1, items: ["pasajes «mar» · Elena (2)"] });
  assert.deepEqual(typeOf(list, "material").items.map((i) => i.label), ["pasajes «mar» · Elena (2)"]);
  assert.equal(typeOf(list, "material").rounds, 1);

  const usage = typeOf(list, "usage");
  assert.deepEqual([usage.input, usage.output], [2400, 60], "both rounds, added up");
  assert.equal((await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.advise`)).length, before + 2, "each round logged");
  assert.ok(!list.some((e) => e.type === "text" && e.text.includes("<solicitar>")), "the request never reaches the author");

  const card = typeOf(list, "observations").items.find((o) => o.title === "Lo leído en profundidad");
  const where = card.refs.filter((r) => r.verified).map((r) => r.chapterId);
  assert.ok(where.includes(ch[2]) && where.includes(ch[CURRENT]), "quotes from chapter 3 and 27, verified in the manuscript");
  s.observation = typeOf(list, "saved").observationIds[3];
  s.conversation = typeOf(list, "saved").conversationId;

  // What it relied on includes chapter 3, read through lectura profunda.
  const { messages } = (await call(`/api/conversations/${s.conversation}`)).data;
  const stored = messages[1].observations.find((o) => o.id === s.observation);
  assert.ok(ch[2] in stored.based_on && ch[CURRENT] in stored.based_on);
  assert.deepEqual(messages[1].context.material.map((m) => m.label), ["pasajes «mar» · Elena (2)"]);
  assert.equal(messages[1].context.rounds, 1);
});

test("an observation from lectura profunda goes stale when the far chapter changes", async () => {
  const rev = (await call(`/api/chapters/${ch[2]}`)).data.revision;
  await call(`/api/chapters/${ch[2]}`, "PATCH", { content: `${TEXT[2]}\n\nUna línea más.`, revision: rev });
  const { messages } = (await call(`/api/conversations/${s.conversation}`)).data;
  assert.deepEqual(messages[1].observations.find((o) => o.id === s.observation).changed, [ch[2]]);
  await call(`/api/chapters/${ch[2]}`, "PATCH", { content: TEXT[2], revision: rev + 1 });
});

test("a character gone for 25 chapters: two rounds, the character first, then that chapter's digest", async () => {
  await clearAiLog();
  const q =
    '¿Qué fue de Rosa? PEDIR: [{"tipo":"personaje","nombre":"Rosa"}] PEDIR2: [{"tipo":"ficha","capitulo":2}]';
  const list = events((await ask(q)).data);
  const log = await aiLog();
  assert.equal(log.length, 3);
  assert.match(log[1].body.messages[0].content, /### Personaje: Rosa[\s\S]*Aparece en los capítulos \(menciones\): 2 \(1\), 26 \(1\)\./);
  assert.match(log[2].body.messages[0].content, /<material ronda="2">\n### Ficha de Capítulo 2\nResumen del capítulo:/);
  assert.deepEqual(
    list.filter((e) => e.type === "reading").map((e) => e.items),
    [["personaje · Rosa"], ["ficha del cap. 2"]],
  );
});

test("a recent revelation against something set at the beginning: approved facts and passages", async () => {
  await clearAiLog();
  const q = '¿Contradice algo lo que descubre Juan? PEDIR: [{"tipo":"hechos","personaje":"Juan"},{"tipo":"pasajes","buscar":"madre"}]';
  const list = events((await ask(q)).data);
  const material = (await aiLog())[1].body.messages[0].content;
  assert.match(material, /Juan es hijo de Marta\. \(Capítulo 4\)/);
  assert.match(material, /\[Capítulo 4\]\nMarta le contó a Juan que ella era su madre\./);
  assert.match(material, /\[Capítulo 26\]\nJuan descubrió que su madre era Rosa, no Marta\./);
  const refs = typeOf(list, "observations").items.find((o) => o.title === "Lo leído en profundidad").refs;
  assert.ok(refs.some((r) => r.verified && r.chapterId === ch[3]) && refs.some((r) => r.verified && r.chapterId === ch[25]));
});

test("author's corrections are served as they are and never overwritten", async () => {
  await call(`/api/chapters/${ch[2]}/digest`, "PATCH", { summary: "Mi propia ficha del capítulo tres." });
  await clearAiLog();
  await ask('Revisa el 3. PEDIR: [{"tipo":"ficha","capitulo":3}]');
  assert.match((await aiLog())[1].body.messages[0].content, /### Ficha de Capítulo 3 \(de una versión anterior del capítulo\) \(corregida por el autor\)\nMi propia ficha del capítulo tres\./);
  const d = await rows("chapter_digests", `chapter_id=eq.${ch[2]}`);
  assert.deepEqual([d[0].summary, d[0].author_edited], ["Mi propia ficha del capítulo tres.", true]);
});

test("limits: at most the configured rounds; the last one must answer; nothing loops", async () => {
  await clearAiLog();
  const before = (await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.advise`)).length;
  const list = events((await ask('Busca todo. PEDIR-SIEMPRE: [{"tipo":"pasajes","buscar":"casa"}]')).data);
  const log = await aiLog();
  assert.equal(log.length, 4, "three request rounds and a last one");
  assert.match(log[3].body.messages[0].content, /Ya no puedes pedir más material/);
  assert.match(log[2].body.messages[0].content, /ya entregado antes: pasajes/, "the same request is not served twice");
  assert.ok(list.some((e) => e.type === "text" && e.text.includes("No pude completar la lectura dentro de los límites")));
  assert.equal((await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.advise`)).length, before + 4);
});

test("text before a request is taken back; without lectura profunda it never asks", async () => {
  await clearAiLog();
  let list = events((await ask('TEXTO-ANTES ¿Y el 3? PEDIR: [{"tipo":"ficha","capitulo":3}]')).data);
  assert.ok(list.some((e) => e.type === "reset"));
  const after = list.slice(list.findIndex((e) => e.type === "reset"));
  assert.ok(!after.some((e) => e.type === "text" && e.text.includes("Déjame revisar")));
  assert.equal((await aiLog()).length, 2);

  await clearAiLog();
  list = events((await ask('¿Y el 3? PEDIR: [{"tipo":"ficha","capitulo":3}]', { deep: false })).data);
  const log = await aiLog();
  assert.equal(log.length, 1);
  assert.doesNotMatch(log[0].body.system[0].text, /<lectura-profunda>/);
  assert.ok(!typeOf(list, "reading"));
});

test("above the extraordinary threshold it pauses; approved, it resumes with that material and doesn't ask again", async () => {
  await clearAiLog();
  const q = 'Compara el 5 y el 6. PEDIR: [{"tipo":"capitulo","capitulo":5},{"tipo":"capitulo","capitulo":6}]';
  let list = events((await ask(q)).data);
  const pause = typeOf(list, "confirm");
  assert.ok(pause, JSON.stringify(list.map((e) => e.type)));
  assert.ok(pause.tokens > 30000);
  assert.deepEqual(pause.requests, [{ tipo: "capitulo", capitulo: 5 }, { tipo: "capitulo", capitulo: 6 }]);
  assert.ok(!typeOf(list, "saved"), "nothing stored while paused");
  assert.equal((await aiLog()).length, 1, "it stopped before the expensive round");

  await clearAiLog();
  list = events((await ask(q, { preload: pause.requests, approvedTokens: pause.tokens })).data);
  assert.deepEqual(typeOf(list, "reading"), { type: "reading", round: 0, items: ["cap. 5 completo", "cap. 6 completo"] });
  const log = await aiLog();
  assert.equal(log.length, 1, "the approved material goes in the first call");
  assert.match(log[0].body.messages[0].content, /<capitulo numero="5" titulo="">[\s\S]*recortado por el límite de tamaño/);
  assert.ok(typeOf(list, "saved"));
});

test("a very long novel (120 chapters, ~1.000 pages): every query reads a bounded fraction of it", async (t) => {
  const big = (await call("/api/novels", "POST", { title: "Muy larga" })).data.id;
  const ids = [(await call(`/api/novels/${big}`)).data.chapters[0].id];
  for (let i = 1; i < 120; i++) ids.push((await call(`/api/novels/${big}/chapters`, "POST", { title: "" })).data.id);
  const para = "La lluvia caía sobre los tejados del puerto mientras alguien, en alguna parte, contaba las horas. ";
  let total = 0;
  for (const [i, id] of ids.entries()) {
    let content = Array.from({ length: 28 }, (_, k) => `${k}. ${para.repeat(5)}`).join("\n\n");
    if (i === 4) content += "\n\nElena juró que nunca había visto el mar.";
    if (i === 117) content += "\n\nElena recordó los veranos en Cartagena, frente al mar.";
    total += content.length;
    await call(`/api/chapters/${id}`, "PATCH", { content, revision: 0 });
  }
  await call(`/api/novels/${big}/memory/characters`, "POST", { name: "Elena" });
  const current = (await call(`/api/chapters/${ids[117]}`)).data.content;

  await clearAiLog();
  const started = Date.now();
  const list = events(
    (
      await call("/api/advisor", "POST", {
        novelId: big,
        chapterId: ids[117],
        content: current,
        provider: "anthropic",
        question: '¿Elena conocía el mar? PEDIR: [{"tipo":"pasajes","buscar":"mar","personaje":"Elena"}]',
      })
    ).data,
  );
  const elapsed = Date.now() - started;
  const log = await aiLog();
  assert.equal(log.length, 2);
  const sizes = log.map((x) => JSON.stringify(x.body).length);
  // ~1.3 M characters of novel; each request a few percent of it.
  assert.ok(total > 1_200_000, String(total));
  assert.ok(Math.max(...sizes) < total * 0.06, `${sizes} of ${total}`);
  // Chapter 5 of 120 found and quoted, verified in the manuscript.
  assert.match(log[1].body.messages[0].content, /\[Capítulo 5\]\nElena juró que nunca había visto el mar\./);
  const card = list.find((e) => e.type === "observations").items.find((o) => o.title === "Lo leído en profundidad");
  assert.ok(card.refs.some((r) => r.verified && r.chapterId === ids[4]));
  assert.ok(elapsed < 15_000, `${elapsed} ms`);
  t.diagnostic(`novel ${total} chars; requests ${sizes.join(" + ")} chars; material ${list.find((e) => e.type === "material").items.map((i) => `${i.label} ${i.tokens}`).join(", ")} tokens; ${elapsed} ms`);
  await call(`/api/novels/${big}`, "DELETE");
});

// ---------------------------------------------------------------- panel

test("panel: lectura profunda shows its rounds and, discreetly, what it read; the pause asks the author", async () => {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[CURRENT]]);
  // These are Analizar's cards and actions: the panel opens in Analizar (Conversar is the default).
  await page.addInitScript((n) => localStorage.setItem(`advisorMode:${n}`, "analizar"), novel);
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".topbar .link", { hasText: "Consejero" }).click();
  const panel = page.locator("aside.panel");
  assert.ok(await panel.getByRole("checkbox", { name: /Lectura profunda/ }).isChecked());

  // Above the (low) test threshold the panel asks: first to read the chapters without a
  // digest, later to keep reading. The author accepts.
  const dialogs = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });
  const box = panel.getByRole("textbox", { name: "Pregunta al Consejero" });
  await box.fill('¿Es coherente que Elena recuerde el mar? PEDIR: [{"tipo":"pasajes","buscar":"mar","personaje":"Elena"}]');
  await panel.getByRole("button", { name: "Preguntar" }).click();
  const line = panel.locator(".turn.advisor .material-line").last();
  await line.waitFor({ timeout: 15_000 }).catch(async (e) => {
    await page.screenshot({ path: `${process.env.TMPDIR ?? "/tmp"}/deep-panel.png` });
    throw new Error(`${e.message}\n${await panel.innerText()}`);
  });
  assert.equal(await line.innerText(), `Consultó además: pasajes «mar» · Elena (2) — ≈${await line.evaluate((el) => el.textContent.match(/≈(.*) tokens/)[1])} tokens en 1 ronda`);
  assert.doesNotMatch(await panel.locator(".consult").innerText(), /<solicitar>/);

  // The pause: the author is asked, accepts, and the answer reads the two chapters.
  await box.fill('Compara el 5 y el 6. PEDIR: [{"tipo":"capitulo","capitulo":5},{"tipo":"capitulo","capitulo":6}]');
  await panel.getByRole("button", { name: "Preguntar" }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".turn.advisor .material-line")].some((el) => el.textContent.includes("cap. 5 completo · cap. 6 completo")),
    null,
    { timeout: 20_000 },
  );
  assert.match(dialogs[0], /Esta consulta enviará unos .* tokens \(incluye leer \d+ capítulos sin ficha\)/);
  assert.ok(dialogs.some((m) => /quiere seguir leyendo: la consulta llegaría a unos .* tokens/.test(m)), dialogs.join("\n"));
});
