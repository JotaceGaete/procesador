// Measurement, not a behaviour test: what the Consejero and the Asistente send per turn in a
// realistic session (a novel of 30 chapters, a synopsis of 18.000 characters and notes of
// 6.000, the author typing between turns). For each request of the Consejero: instructions,
// frame (the part the provider can cache) and prompt, in estimated tokens (chars / 3.5), and
// whether the cacheable prefix is identical to the previous request's. Printed as
// "# TOKENS {json}" lines; run with E2E_ONLY=tokens on two builds to compare.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

let call, novel, ch, ids;
const est = (s) => Math.ceil((s ?? "").length / 3.5);
const NAMES = ["Pola", "Héctor", "Eduardo", "Gerardo", "Marcela", "Claudia", "Waldo", "Casandra"];
const para = (i, j) =>
  `${NAMES[(i + j) % NAMES.length]} cruzó la plaza del pueblo mientras ${NAMES[(i + j + 3) % NAMES.length]} la miraba desde la ventana del almacén. ` +
  `Llovía como siempre en el sur, y el olor a leña mojada entraba por todas partes. Nadie dijo nada durante un rato largo, y después todos hablaron a la vez. `.repeat(2);
const chapterText = (i) => Array.from({ length: 30 }, (_, j) => para(i, j)).join("\n\n"); // ≈2.500 palabras
const SYNOPSIS = [
  "Una novela coral en un pueblo del sur de Chile: Pola y Héctor, un matrimonio desgastado, y los secretos que se cruzan a su alrededor durante tres inviernos.",
  ...Array.from({ length: 70 }, (_, i) => `${NAMES[i % 8]} y ${NAMES[(i + 2) % 8]}: tramo ${i + 1}. Lo que pasa entre ellos durante ese tiempo, cómo se van enterando de las cosas y qué deciden callar, con los lugares del pueblo y sus historias paralelas.`),
  "Desenlace: Pola deja a Héctor y se queda en el pueblo; Gerardo se va sin haber conseguido nada; Eduardo muere sin que nadie sepa lo que hubo.",
].join("\n\n").slice(0, 18_000);
const NOTES = Array.from({ length: 30 }, (_, i) => `Nota ${i + 1}: ${NAMES[i % 8]} no debe saber todavía lo de ${NAMES[(i + 1) % 8]}; recordar el tono de la lluvia y del almacén.`).join("\n\n").slice(0, 6000);

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Tres inviernos" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (let i = 1; i < 30; i++) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: `Capítulo ${i + 1}` })).data.id);
  for (const [i, id] of ch.entries()) await call(`/api/chapters/${id}`, "PATCH", { content: chapterText(i), revision: 0 });
  await call(`/api/novels/${novel}`, "PATCH", { synopsis: SYNOPSIS, notes: NOTES, guide: { tone: "Melancólico", narrator: "Tercera persona" } });
  ids = {};
  for (const name of NAMES)
    ids[name] = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name, description: `${name}, del pueblo. `.repeat(8), secrets: "Algo que calla.", knows: "Lo de siempre." })).data.id;
  for (const id of ch) await call(`/api/chapters/${id}/digest`, "POST", { provider: "anthropic" });
});
after(() => clearAiLog());

let content;
const CURRENT = 29;
async function type(text) {
  // The author writes and the chapter is saved between turns.
  const rev = (await call(`/api/chapters/${ch[CURRENT]}`)).data.revision;
  content = `${content}\n\n${text}`;
  await call(`/api/chapters/${ch[CURRENT]}`, "PATCH", { content, revision: rev });
}

test("measure the Consejero (Conversar and Analizar) and the Asistente", async () => {
  content = chapterText(CURRENT);
  const turns = [
    ["conversar", "¿Cómo puedo continuar?"],
    ["conversar", "Me gusta, desarróllala."],
    ["type", "Pola volvió al almacén sin paraguas."],
    ["conversar", "Quiero que Eduardo aparezca como un hombre mayor, elegante y reservado."],
    ["conversar", "¿Y Gerardo, cuándo aparece?"],
    ["type", "Héctor no preguntó nada."],
    ["conversar", "Dame opciones"],
    ["conversar", "Me gusta la B"],
    ["conversar", "¿Cómo sigue?"],
    ["conversar", "Perfecto"],
    ["analizar", "Analiza el capítulo"],
    ["analizar", "¿Es coherente lo que sabe Marcela?"],
  ];
  let conversationId = null;
  let previous = null;
  const rows = [];
  for (const [mode, text] of turns) {
    if (mode === "type") {
      await type(text);
      continue;
    }
    await clearAiLog();
    const list = events(
      (await call("/api/advisor", "POST", { novelId: novel, chapterId: ch[CURRENT], content, provider: "anthropic", mode, question: text, conversationId })).data,
    );
    conversationId = list.find((e) => e.type === "saved")?.conversationId ?? conversationId;
    const log = await aiLog();
    const req = log.filter((x) => /<consejero>/.test(x.body.system?.[0]?.text ?? "")).at(-1).body;
    const instr = req.system[0].text;
    const frame = req.system[1]?.text ?? "";
    const prompt = req.messages[0].content;
    const prefix = instr + frame;
    const row = {
      mode,
      q: text.slice(0, 24),
      instr: est(instr),
      frame: est(frame),
      prompt: est(prompt),
      total: est(instr) + est(frame) + est(prompt),
      prefixReused: previous === prefix,
      compaction: log.some((x) => /<resumen-conversacion>/.test(x.body.system?.[0]?.text ?? "")),
      maxOut: req.max_tokens,
    };
    previous = prefix;
    rows.push(row);
    console.log(`# TOKENS ${JSON.stringify(row)}`);
  }
  await clearAiLog();
  await call("/api/assist", "POST", { novelId: novel, chapterId: ch[CURRENT], content, mode: "scene", argument: "Pola cierra el almacén.", length: "media", cursor: content.length, provider: "anthropic" });
  const a = (await aiLog()).at(-1).body;
  const aRow = { mode: "asistente-escena", instr: est(a.system?.map?.((b) => b.text).join("") ?? a.system), prompt: est(a.messages[0].content) };
  aRow.total = aRow.instr + aRow.prompt;
  aRow.carriesSynopsis = JSON.stringify(a).includes("Desenlace: Pola deja a Héctor");
  console.log(`# TOKENS ${JSON.stringify(aRow)}`);
  const conv = rows.filter((r) => r.mode === "conversar");
  console.log(`# TOKENS ${JSON.stringify({ summary: "conversar", turns: conv.length, avgTotal: Math.round(conv.reduce((n, r) => n + r.total, 0) / conv.length), reused: conv.filter((r) => r.prefixReused).length })}`);
  assert.ok(rows.length === 10);
});
