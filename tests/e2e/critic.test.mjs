// Crítico Literario, phase 1 (docs/critico.md): one finished chapter, one report. API end to end
// with the mock AI (which builds its report from the request, with real quotes), then the
// report in the browser. What it checks: what the Crítico reads (and what it never reads), the
// validation and verification of its report, contradictions checked against the manuscript,
// that the manuscript never changes, and the author's answer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, STACK, aiLog, clearAiLog, client, login, resetDb, textEditor } from "./helpers.mjs";

let call, novel, ch, browser, page;

const FILLER = Array.from({ length: 8 }, (_, i) => `La marea subió despacio en la tarde número ${i} sin que nadie la mirara.`).join("\n\n");
const TEXT1 = `Elena encontró la carta en el cajón de su madre. Juan no sabía nada de la carta.\n\nCABO: La carta de Marta.\n\nEl último tren salió a las nueve y Elena lo vio irse desde el andén.`;
const TEXT2 = `Elena bajó al puerto con la carta en el bolsillo. El viento olía a sal y a gasoil. Nadie la esperaba en el muelle.\n\n—¿Te perdiste? —le preguntó un estibador.\n\n${FILLER}`;

const evaluate = (id, extra = {}) => call(`/api/chapters/${id}/critiques`, "POST", { provider: "anthropic", ...extra });
const critiques = async (id) => (await call(`/api/chapters/${id}/critiques`)).data;
const save = async (id, content) => {
  const { revision } = (await call(`/api/chapters/${id}`)).data;
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision });
  assert.equal(r.status, 200);
};
async function rows(table, query) {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/${table}?${query}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  return res.json();
}
/** The Crítico's requests to the mock since the last clear: their system and user text. */
const criticCalls = async () =>
  (await aiLog())
    .filter((l) => l.provider === "anthropic" && JSON.stringify(l.body.system ?? "").includes("<critico-literario>"))
    .map((l) => ({ model: l.body.model, user: l.body.messages[0].content, system: l.body.system.map((b) => b.text).join("\n") }));

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El puerto" })).data.id;
  // The author's plan and secrets: the Crítico reads as a reader, never these.
  await call(`/api/novels/${novel}`, "PATCH", { synopsis: "SINOPSIS-SECRETA: Elena es hija de Marta.", plot: "ARGUMENTO-SECRETO: el desenlace." });
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "El puerto" })).data.id);
  await save(ch[0], TEXT1);
  await save(ch[1], TEXT2);
  await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", description: "Pelirroja y testaruda" });
  // Chapter 1 read by the Consejero: its digest is what the Crítico knows of it.
  assert.equal((await call(`/api/chapters/${ch[0]}/digest`, "POST", { provider: "anthropic" })).status, 200);
});
after(async () => {
  await browser?.close();
  await clearAiLog();
});

test("evaluate: a report with nine scores (one decimal), the reader's experience and a verdict; quotes verified", async () => {
  await clearAiLog();
  const before = (await call(`/api/chapters/${ch[1]}`)).data;
  const r = await evaluate(ch[1]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  const c = r.data.critique;
  assert.equal(c.scores.length, 9);
  assert.deepEqual(
    c.scores.map((s) => s.criterion),
    ["interes", "emocion", "tension", "dialogos", "ritmo", "atmosfera", "continuar", "prosa", "funcion"],
  );
  assert.ok(c.scores.some((s) => s.score % 1 !== 0), "decimals kept");
  assert.equal(c.overall_score, 8.1);
  assert.equal(c.average, Math.round((c.scores.reduce((a, s) => a + s.score, 0) / 9) * 10) / 10);
  assert.equal(c.verdict, "solido");
  assert.deepEqual(c.experience.effects, ["emociona", "entretiene"]);
  assert.match(c.experience.summary, /emociona/);
  assert.ok(c.experience.stretches.length >= 2 && c.experience.stretches.every((s) => s.verified));
  assert.ok(c.scores.every((s) => !s.impression && s.refs.every((q) => q.verified)));
  assert.equal(c.status, "current");
  // «Ir»: every quote has its place in the text.
  const [quote] = c.scores[0].refs;
  const at = c.at[quote.quote];
  assert.equal(TEXT2.slice(at.start, at.end), quote.quote);
  assert.equal(c.model, "claude-consejero-e2e", "without a model of its own, the Consejero's");
  assert.ok(c.context.parts.some((p) => /Capítulo 2: El puerto completo/.test(p.label)));
  assert.ok(c.context.input > 0 && c.context.output > 0);

  // The manuscript is only read.
  const after = (await call(`/api/chapters/${ch[1]}`)).data;
  assert.equal(after.revision, before.revision);
  assert.equal(after.content, TEXT2);
  // Its usage is logged as the Crítico's.
  const usage = await rows("ai_usage", `novel_id=eq.${novel}&purpose=eq.critic`);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model, "claude-consejero-e2e");
});

test("what it reads: the chapter whole, the Guía, the digests before and the end of the previous chapter; never the plan", async () => {
  await clearAiLog();
  await call(`/api/novels/${novel}`, "PATCH", { guide: { tone: "Melancólico, sin prisa" } });
  assert.equal((await evaluate(ch[1])).status, 200);
  const [req] = await criticCalls();
  assert.ok(req.user.includes(`<capitulo-evaluado titulo="Capítulo 2: El puerto">\n${TEXT2}\n</capitulo-evaluado>`), "the whole chapter");
  assert.match(req.user, /<ficha capitulo="Capítulo 1">/);
  assert.match(req.user, /Pasajes literales del manuscrito:/);
  assert.match(req.user, /<final-del-capitulo-anterior capitulo="Capítulo 1">[\s\S]*El último tren salió a las nueve/);
  assert.match(req.user, /La carta de Marta/, "open threads");
  assert.match(req.user, /Pelirroja y testaruda/, "the people in it, from the Memoria");
  assert.doesNotMatch(req.user, /SINOPSIS-SECRETA|ARGUMENTO-SECRETO/, "not the author's plan or secrets");
  // Independent: none of its own earlier reports.
  assert.doesNotMatch(req.user, /Sólido: funciona|Lo mejor: el comienzo/);
  assert.match(req.system, /No reescribes/);
});

test("a mediocre chapter is called so; without dialogue, «no aplica»; an invented quote is an impression", async () => {
  const id = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Tres" })).data.id;
  await save(id, "MEDIOCRE. SIN-DIALOGO. CITA-FALSA. Pasó el día sin que nada pasara. Elena miró la ventana un rato largo. Luego se fue a dormir.");
  const c = (await evaluate(id)).data.critique;
  assert.equal(c.verdict, "no_funciona");
  assert.equal(c.overall_score, 4.2);
  assert.deepEqual(c.experience.effects, ["aburre"]);
  assert.equal(c.scores.find((s) => s.criterion === "dialogos").score, null);
  assert.equal(c.average, Math.round((c.scores.filter((s) => s.score !== null).reduce((a, s) => a + s.score, 0) / 8) * 10) / 10);
  const prosa = c.scores.find((s) => s.criterion === "prosa");
  assert.equal(prosa.impression, true);
  assert.equal(prosa.refs[0].verified, false);
});

test("an invalid first answer is retried once; a long «quote» (a rewrite) is sent back", async () => {
  const id = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Cuatro" })).data.id;
  await save(id, "CRITICO-ROTO. CITA-LARGA. La lluvia golpeaba el techo de zinc. Marta contaba las gotas en silencio.");
  await clearAiLog();
  const r = await evaluate(id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const calls = await criticCalls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /Tu respuesta anterior no era válida/);
  assert.ok(r.data.critique.scores[0].refs[0].quote.length < 300);
});

test("contradictions: one only a digest suggests never lowers a score; one quoted from the manuscript counts", async () => {
  // Only the digest says so, and it lowered «funcion»: sent back; the retry keeps it, lowering nothing.
  const id = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Cinco" })).data.id;
  await save(id, "CONTRADICCION-FICHA. Elena llegó al puerto sin saber dónde estaba. Preguntó por el muelle dos veces.");
  await clearAiLog();
  let c = (await evaluate(id)).data.critique;
  const calls = await criticCalls();
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /no se confirman en el manuscrito[\s\S]*El manuscrito manda/);
  assert.equal(c.contradictions.length, 1);
  assert.equal(c.contradictions[0].confirmed, false);
  assert.deepEqual(c.contradictions[0].affects, []);

  // It insists: kept, marked as unconfirmed with what it said it affected (never hidden).
  await save(id, "CONTRADICCION-TERCA. Elena llegó al puerto sin saber dónde estaba. Preguntó por el muelle dos veces.");
  c = (await evaluate(id)).data.critique;
  assert.equal(c.contradictions[0].confirmed, false);
  assert.deepEqual(c.contradictions[0].affects, ["funcion"]);

  // Both passages in the manuscript (the end of the previous chapter, quoted): confirmed, its chapter corrected.
  await save(id, "CONTRADICCION-REAL. Elena llegó al puerto sin saber dónde estaba. Preguntó por el muelle dos veces.");
  await clearAiLog();
  c = (await evaluate(id)).data.critique;
  assert.equal((await criticCalls()).length, 1);
  const real = c.contradictions[0];
  assert.equal(real.confirmed, true);
  assert.equal(real.sourceVerified, true);
  assert.equal(real.sourceChapter, 4, "the previous chapter, Cuatro");
});

test("history: newest first; after a rewrite, «versión anterior»; after a retouch, still valid", async () => {
  let list = await critiques(ch[1]);
  assert.equal(list.length, 2);
  assert.ok(new Date(list[0].created_at) >= new Date(list[1].created_at));
  await save(ch[1], TEXT2.replace("gasoil", "gasóleo"));
  list = await critiques(ch[1]);
  assert.equal(list[0].status, "touched");
  await save(ch[1], "Todo cambió. Otra escena distinta, en otra ciudad, con otra gente, un mediodía de invierno.\n\n" + FILLER.replace(/marea/g, "nieve"));
  list = await critiques(ch[1]);
  assert.equal(list[0].status, "stale");
  // A quote that is no longer in the text has no place for «Ir».
  assert.ok(Object.values(list[0].at).some((x) => x === null));
  await save(ch[1], TEXT2);
});

test("the author's answer: agree or disagree and a note; never the scores; delete", async () => {
  const [c] = await critiques(ch[1]);
  assert.equal((await call(`/api/critiques/${c.id}`, "PATCH", { response: "disagree", note: "El final es así a propósito." })).status, 204);
  assert.equal((await call(`/api/critiques/${c.id}`, "PATCH", { response: "quizá" })).status, 400);
  assert.equal((await call(`/api/critiques/${c.id}`, "PATCH", { overall_score: 10, verdict: "excelente" })).status, 400);
  const [now] = await critiques(ch[1]);
  assert.equal(now.author_response, "disagree");
  assert.equal(now.author_note, "El final es así a propósito.");
  assert.equal(now.overall_score, c.overall_score);
  assert.equal(now.verdict, c.verdict);
  // The note never reaches the Crítico.
  await clearAiLog();
  await evaluate(ch[1]);
  assert.doesNotMatch((await criticCalls())[0].user, /a propósito/);
  assert.equal((await call(`/api/critiques/${c.id}`, "DELETE")).status, 204);
  assert.equal((await call(`/api/critiques/${c.id}`, "DELETE")).status, 404);
  assert.equal((await call("/api/critiques/no-es-un-id", "PATCH", { note: "x" })).status, 404);
});

test("guards: an empty chapter, an unknown provider, and a very large chapter asks first", async () => {
  const empty = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Vacío" })).data.id;
  assert.equal((await evaluate(empty)).status, 400);
  assert.equal((await evaluate(ch[1], { provider: "nadie" })).status, 400);
  const big = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Largo" })).data.id;
  await save(big, Array.from({ length: 1500 }, (_, i) => `Párrafo ${i}: la ciudad dormía bajo la niebla y nadie hablaba.`).join("\n\n"));
  await clearAiLog();
  const asked = await evaluate(big);
  assert.equal(asked.data.done, false);
  assert.ok(asked.data.confirm.tokens > asked.data.confirm.limit);
  assert.equal((await criticCalls()).length, 0, "nothing sent before the author says yes");
  const yes = await evaluate(big, { approvedTokens: asked.data.confirm.tokens });
  assert.equal(yes.data.done, true);
});

test("a duplicated novel does not carry the reports; deleting the chapter deletes them", async () => {
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", { title: "Copia" })).data.id;
  assert.ok(copy);
  assert.equal((await rows("chapter_critiques", `novel_id=eq.${copy}`)).length, 0);
  const id = (await call(`/api/novels/${novel}/chapters`, "POST", { title: "Borrable" })).data.id;
  await save(id, "Elena cerró la puerta. La casa quedó en silencio. Nadie volvió.");
  await evaluate(id);
  assert.equal((await rows("chapter_critiques", `chapter_id=eq.${id}`)).length, 1);
  assert.equal((await call(`/api/chapters/${id}`, "DELETE")).status < 300, true);
  assert.equal((await rows("chapter_critiques", `chapter_id=eq.${id}`)).length, 0);
});

// ---------------------------------------------------------------- the report in the browser

test("view: Crítico evaluates the open chapter, shows the table and the verdict; Ir selects the quote", async () => {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[0]]);
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  // Unsaved text: the Crítico saves first and reads it.
  const LIVE = `${TEXT1}\n\nElena guardó la carta y salió a la lluvia sin paraguas.`;
  await editor.fill(LIVE);
  await page.locator(".topbar .link", { hasText: "Crítico" }).click();
  const dialog = page.getByRole("dialog", { name: /Crítico · Capítulo 1/ });
  await dialog.getByText("Aún no hay ninguna evaluación").waitFor();
  await dialog.getByRole("button", { name: "Evaluar capítulo" }).click();
  const report = dialog.getByRole("article", { name: "Informe del Crítico" });
  await report.waitFor({ timeout: 15_000 });
  assert.match(await report.locator(".critic-verdict").innerText(), /Sólido/);
  assert.match(await report.locator(".critic-overall").innerText(), /8,1/);
  assert.equal(await report.locator(".critic-scores tbody tr").count(), 9);
  assert.match(await report.locator(".critic-scores").innerText(), /Deseo de continuar[\s\S]*Función en la novela/);
  assert.match(await report.innerText(), /Experiencia del lector[\s\S]*Emociona/i);
  assert.equal((await rows("chapters", `id=eq.${ch[0]}&select=content`))[0].content, LIVE, "saved before reading, and nothing else");

  // Agree, then a note.
  await report.getByRole("button", { name: "De acuerdo" }).click();
  await page.waitForFunction(() => document.querySelector(".critic-response .btn.primary")?.textContent === "De acuerdo");
  await report.getByRole("textbox", { name: "Nota personal" }).fill("Coincido.");
  await report.getByRole("button", { name: "Guardar nota" }).click();
  await report.getByText("Nota guardada.").waitFor();

  // «Ir» closes the report and selects the quote in the text.
  await editor.evaluate((el) => el.setSelectionRange(0, 0));
  const quote = (await report.locator(".critic-scores .critic-quote").first().innerText()).match(/«(.+)»/)[1];
  await report.locator(".critic-scores .critic-quote").first().getByRole("button", { name: "Ir" }).click();
  await dialog.waitFor({ state: "detached" });
  const selected = await editor.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  assert.equal(selected, quote);
  assert.equal(await editor.inputValue(), LIVE, "the text untouched");

  // Reopened: the last report is there, with the author's answer.
  await page.locator(".topbar .link", { hasText: "Crítico" }).click();
  const again = page.getByRole("dialog", { name: /Crítico/ }).getByRole("article", { name: "Informe del Crítico" });
  await again.waitFor();
  assert.equal(await again.getByRole("textbox", { name: "Nota personal" }).inputValue(), "Coincido.");
});
