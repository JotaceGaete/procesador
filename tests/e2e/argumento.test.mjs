// Argumento general, phase 1 (docs/consejero.md): the author's plan (synopsis and notes) is
// the Consejero's, never the Asistente's; the Consejero reads its global view once, plus the
// paragraphs that matter; four layers in its instructions; and every scene or rewrite of the
// Asistente is checked for continuity without AI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

let call, novel, ch, ids;

const SECRET = "Pola mantiene desde hace años una relación secreta con Eduardo.";
const LATER = "Gerardo, primo de Héctor, llegará al pueblo e intentará quedarse con Pola sin decirlo nunca.";
const SYNOPSIS = [
  "Una novela coral en un pueblo del sur de Chile, alrededor de Pola y Héctor, un matrimonio desgastado.",
  ...Array.from(
    { length: 60 },
    (_, i) => `Tramo ${i + 1}: lo que va pasando en el pueblo. Con sus historias paralelas, sus tensiones y los detalles que el autor no quiere olvidar, contados con calma y con nombres de lugares.`,
  ),
  SECRET,
  LATER,
  "Desenlace: Pola deja a Héctor; Gerardo se va con las manos vacías.",
].join("\n\n");
const NOTES = "Héctor tiene una vida secreta distinta de su comportamiento doméstico.";
const T1 = "Pola abrió el supermercado temprano.\n\nMarcela llegó con su cotona azul.";

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "El pueblo" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  await call(`/api/chapters/${ch[0]}`, "PATCH", { content: T1, revision: 0 });
  await call(`/api/novels/${novel}`, "PATCH", { synopsis: SYNOPSIS, notes: NOTES, guide: { tone: "Melancólico" } });
  const create = async (kind, body) => (await call(`/api/novels/${novel}/memory/${kind}`, "POST", body)).data.id;
  ids = {
    pola: await create("characters", { name: "Pola" }),
    marcela: await create("characters", { name: "Marcela" }),
    claudia: await create("characters", { name: "Claudia" }),
    gerardo: await create("characters", { name: "Gerardo" }),
    super: await create("places", { name: "Supermercado" }),
    casa: await create("places", { name: "Casa de Pola" }),
  };
  await call(`/api/chapters/${ch[0]}/time`, "PUT", { when: { date: { year: 1990 } } });
  await call(`/api/memory/characters/${ids.claudia}`, "PATCH", { age_anchor: { kind: "age_at", age: 25, at: { chapter_id: ch[0] } } });
  await call(`/api/chapters/${ch[0]}/digest`, "POST", { provider: "anthropic" });
});
after(() => clearAiLog());

const scene = (argument, extra = {}) =>
  call("/api/assist", "POST", { novelId: novel, chapterId: ch[0], content: T1, mode: "scene", argument, length: "media", cursor: T1.length, provider: "anthropic", ...extra });
const whole = (req) => JSON.stringify(req.body);

test("the Asistente never receives the synopsis nor the notes (scenes, rewrites, analyses); the style still goes", async () => {
  await clearAiLog();
  await scene("Pola cierra la caja al final del día.");
  await call("/api/assist", "POST", { novelId: novel, chapterId: ch[0], content: T1, mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: 36, provider: "anthropic" });
  await call("/api/assist", "POST", { novelId: novel, chapterId: ch[0], content: T1, mode: "edit", action: "consistencia", selectionStart: 0, selectionEnd: 36, provider: "anthropic" });
  const log = await aiLog();
  assert.equal(log.length, 3);
  for (const req of log) {
    const sent = whole(req);
    assert.doesNotMatch(sent, /relación secreta con Eduardo|intentará quedarse con Pola|vida secreta distinta|Desenlace: Pola deja a Héctor/, "nothing of the plan");
    assert.match(sent, /Melancólico/, "the style of the Guía Maestra still goes");
  }
  const dry = (await scene("Pola cierra la caja.", { dryRun: true })).data;
  const guide = dry.sections.find((s) => s.id === "guide");
  assert.ok(!guide.items.some((i) => /Sinopsis|Notas/.test(i.label)), "«Ver contexto» says so too");
});

test("the Consejero: the plan once, as intention (not canon), its global view in the cached frame; the details that matter apart", async () => {
  await clearAiLog();
  const list = events((await call("/api/advisor", "POST", { novelId: novel, chapterId: ch[0], content: T1, provider: "anthropic", mode: "conversar", question: "¿Cómo seguimos con Gerardo?" })).data);
  assert.ok(list.some((e) => e.type === "saved"));
  const req = (await aiLog()).at(-1).body;
  const frame = req.system[1].text;
  assert.equal(req.system[1].cache_control?.type, "ephemeral", "the frame is cached");
  assert.match(frame, /## Plan del autor \(visión general; los detalles pertinentes van aparte\)\nSu intención para la novela\. En gran parte aún no está escrito: no es canon ni algo que ya ocurrió\.\nSinopsis:\nUna novela coral/);
  assert.match(frame, /Desenlace: Pola deja a Héctor/, "the ending, always");
  assert.equal(frame.match(/Una novela coral en un pueblo/g).length, 1, "the synopsis once (it used to go twice)");
  assert.doesNotMatch(frame, /## Sinopsis/, "not inside the Guía Maestra any more");
  const prompt = req.messages[0].content;
  assert.match(prompt, /<plan-del-autor-detalles>\n[\s\S]*intentará quedarse con Pola[\s\S]*<\/plan-del-autor-detalles>\n\(Intención del autor, no canon/, "the paragraph about Gerardo, whole");
  assert.match(req.system[0].text, /Cuatro capas que no se confunden:[\s\S]*Plan del autor: su argumento general, su sinopsis y sus notas[\s\S]*nunca lo presentes como ya ocurrido ni adelantes sus revelaciones/);
  // The frame is the same in the next turn (so the provider can reuse it), even after typing.
  await clearAiLog();
  const id = list.find((e) => e.type === "saved").conversationId;
  await call("/api/advisor", "POST", { novelId: novel, chapterId: ch[0], content: `${T1}\n\nUna palabra más.`, provider: "anthropic", mode: "conversar", question: "¿Y Pola?", conversationId: id });
  assert.equal((await aiLog()).at(-1).body.system[1].text, frame, "identical cached frame");
});

test("continuity without AI: a garment that changes, a new name, an age the Cronología contradicts — as warnings with the scene", async () => {
  const ropa = events((await scene("ESCENA-ROPA Marcela se prepara.", { placeIds: [ids.super] })).data);
  const w = ropa.find((e) => e.type === "continuity");
  assert.ok(w, JSON.stringify(ropa.map((e) => e.type)));
  assert.deepEqual(w.warnings.map((x) => x.kind), ["nombre", "ropa"]);
  assert.match(w.warnings[1].message, /«cotona azul»; la propuesta habla de «blusa roja»/);
  const edad = events((await scene("ESCENA-EDAD Claudia en casa.")).data).find((e) => e.type === "continuity");
  assert.match(edad.warnings[0].message, /da a Claudia 20 años; según la Cronología, en este punto tiene 25/);
  const ok = events((await scene("Pola cierra la caja.")).data);
  assert.equal(ok.find((e) => e.type === "continuity"), undefined, "nothing to say: no event");
});
