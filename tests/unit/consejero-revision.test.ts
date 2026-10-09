// «La manta» (docs/consejero.md, «Revisar escena»): asking to make a written scene «more
// attractive» must read it and protect it, not replace it with another story. And the
// Consejero, the Asistente and the helper prompts treat adult fiction as fiction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planQuestion } from "@/lib/advisor/planner";
import { checkContinuity } from "@/lib/continuity";
import { comparePrompt, parseComparison } from "@/lib/advisor/compare";

const POLA = { name: "Pola", aliases: "" };
const EDUARDO = { name: "Eduardo", aliases: "don Eduardo" };
const ctx = {
  characters: [
    { id: "pola", ...POLA },
    { id: "eduardo", ...EDUARDO },
  ],
  places: [],
  chapters: [{ title: "El viaje" }],
  threads: [],
};

// A summary of the original scene and of the Consejero's proposal (the full texts are the author's).
const ORIGINAL =
  "En el bus a Santiago, Pola reconoció a don Eduardo dos asientos más adelante. Él la vio tiritar y le ofreció su manta. Horas después, Pola levantó una punta de la manta y lo invitó a compartirla.";
const PROPOSAL =
  "En la parada de carretera, un desconocido ayudó a Pola con las monedas del baño, el bolso y el boleto. Se llamaba Eduardo. Una gotera en su asiento la obligó a sentarse junto a él.";

test("«Haz esta escena más atractiva» is a review of what is written, not new plot", () => {
  for (const q of [
    "Haz esta escena más atractiva",
    "¿Cómo mejoro esta escena?",
    "Quiero mejorar la escena de la manta",
    "¿Qué le falta a esta escena?",
    "Púlela, que quede más intensa",
    "¿Cómo ves esta escena?",
  ])
    assert.equal(planQuestion(q, ctx).explicit, "revisar", q);
  // The other intents keep their words.
  assert.equal(planQuestion("Quiero subir la tensión", ctx).action, "tension");
  assert.equal(planQuestion("¿Qué pasaría si Eduardo se baja antes?", ctx).action, "consecuencias");
  assert.equal(planQuestion("¿Cómo sigo desde aquí?", ctx).action, "seguir");
  assert.equal(planQuestion("Mejor sin Eduardo", ctx).explicit, null, "«mejor» alone is not a review");
  // «Mejorar» with a narrower subject keeps the intent it had before «Revisar escena».
  for (const [q, action] of [
    ["¿Cómo mejoro el ritmo?", "analizar"],
    ["Quiero mejorar la tensión", "analizar"],
    ["¿Cómo mejoro el personaje de Pola?", "personajes"],
    ["¿Qué le falta a Pola?", "personajes"],
    ["Mejora los diálogos", "analizar"],
    ["Mejora el capítulo 2", "analizar"],
    ["Mejorar el final de la novela", "analizar"],
  ])
    assert.equal(planQuestion(q, ctx).action, action, q);
});

test("Revisar escena: strengths first, problems apart from preferences, no new events, and «it works» is an answer", async () => {
  const { ADVISE_TASKS, CONVERSE_TASKS } = await import("@/lib/advisor/prompts");
  for (const task of [ADVISE_TASKS.revisar("el capítulo 1"), CONVERSE_TASKS.revisar("el capítulo 1")]) {
    assert.match(task, /Léela entera antes de juzgar/);
    assert.match(task, /\*\*Lo que funciona:\*\*[\s\S]*cita literal/);
    assert.match(task, /La escena funciona; no la cambiaría/);
    assert.match(task, /No inventes problemas/);
    assert.match(task, /\*\*Preferencias \(opcionales\):\*\*[\s\S]*marcado como gusto/);
    assert.match(task, /relaciones \(quién conoce a quién\)/);
    assert.match(task, /más acontecimientos no es más interés/);
    assert.match(task, /propón uno solo, di qué cambia de lo escrito y por qué/);
    assert.match(task, /No reescribas la escena/);
    assert.match(task, /juzga su oficio, no su tema, y no propongas atenuarla/);
  }
});

test("the Consejero's criteria protect the original and leave the last word to the author", async () => {
  const { ADVISE_INSTRUCTIONS, CONVERSE_INSTRUCTIONS } = await import("@/lib/advisor/prompts");
  for (const text of [ADVISE_INSTRUCTIONS, CONVERSE_INSTRUCTIONS]) {
    assert.match(text, /Puedes concluir que una escena ya funciona y no necesita cambios/);
    assert.match(text, /Más acontecimientos no es más interés/);
    assert.match(text, /Distingue un problema real[\s\S]*de una preferencia tuya/);
    assert.match(text, /Una coincidencia o una casualidad que ya está escrita es canon/);
    assert.match(text, /cambia un hecho, una relación \(quién conoce a quién\)[\s\S]*dilo expresamente/);
    assert.match(text, /La autoridad final es del autor[\s\S]*si él confirma que quiere cambiarlo, se hace/);
  }
});

test("adult fiction: judged by its craft in the Consejero; named without euphemisms in fichas, summaries and the brief", async () => {
  const p = await import("@/lib/advisor/prompts");
  for (const text of [p.ADVISE_INSTRUCTIONS, p.CONVERSE_INSTRUCTIONS, p.COMPARE_INSTRUCTIONS]) {
    assert.match(text, /Juzgas las escenas íntimas, sexuales o violentas por su oficio: credibilidad, intensidad, progresión, lenguaje, consentimiento dentro de la ficción y función narrativa/);
    assert.match(text, /Nunca recomiendes suavizarla, quitarla, reducirla a insinuaciones/);
    assert.match(text, /No conviertas a un personaje contradictorio en villano o en víctima/);
    assert.match(text, /La respetabilidad moral de lo que ocurre no es un criterio literario/);
  }
  for (const text of [p.DIGEST_INSTRUCTIONS, p.NOVEL_DIGEST_INSTRUCTIONS, p.BRIEF_INSTRUCTIONS])
    assert.match(text, /Describe lo que ocurre con claridad y sin eufemismos, también si es sexual o violento/);
  assert.match(p.BRIEF_INSTRUCTIONS, /Nunca añadas límites de tono o de contenido \(suavizar, evitar lo explícito/);
  assert.match(p.BRIEF_INSTRUCTIONS, /No cambies hechos ni relaciones de lo escrito \(quién conoce a quién/);
  assert.match(p.CONVERSATION_SUMMARY_INSTRUCTIONS, /también si son crudas o explícitas/);
});

test("the Asistente: adult scenes keep their intensity, and a contradiction is asked, not written in silence", async () => {
  const { EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS, scenePrompt } = await import("@/lib/ai/prompts");
  for (const text of [EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS]) {
    assert.match(text, /no lo suavices, no moralices/);
    assert.match(text, /No la conviertas en insinuación/);
    assert.match(text, /no se castiga ni se convierte en lección/);
  }
  assert.doesNotMatch(WRITE_INSTRUCTIONS, /escribe igualmente lo que pide el argumento/);
  assert.match(WRITE_INSTRUCTIONS, /dos personajes que se conocen y el argumento los hace desconocidos[\s\S]*no escribas la escena: responde sólo con una línea dentro de <aviso><\/aviso>/);
  const base = { argument: "Pola y Eduardo.", length: "media" as const, chapter: "Capítulo 1", previousChapterTail: null, before: "", after: "" };
  assert.doesNotMatch(scenePrompt(base), /El autor ya confirmó el cambio/);
  assert.match(scenePrompt({ ...base, confirmedChange: true }), /El autor ya confirmó el cambio[\s\S]*Escribe la escena según el argumento, sin aviso/);
});

test("Revisar escena in the Asistente: the author's approved changes and only those; the scene can be left as it is", async () => {
  const { editPrompt } = await import("@/lib/ai/prompts");
  const base = { action: "revisar" as const, character: null, selection: ORIGINAL, before: "", after: "", passages: null };
  const plain = editPrompt(base);
  assert.doesNotMatch(plain, /Cambios que el autor pidió/);
  assert.match(plain, /\*\*Lo que funciona:\*\*/);
  assert.match(plain, /No añadas acontecimientos, incidentes, personajes ni complicaciones/);
  assert.match(plain, /si la escena es íntima o sexual, conserva su intensidad y su grado de explicitud/);
  assert.match(plain, /La escena funciona; no la cambiaría[\s\S]*no incluyas <reescritura>/);
  const asked = editPrompt({ ...base, notes: "Que la invitación de Pola llegue con menos explicación." });
  assert.match(asked, /<cambios_pedidos>\nQue la invitación de Pola llegue con menos explicación\.\n<\/cambios_pedidos>/);
  assert.match(asked, /aplica esos y sólo esos/);
});

test("continuity: making a stranger of someone the text or the Memoria ties to another character is flagged", () => {
  const base = { characters: [POLA, EDUARDO], places: [] };
  const [byText] = checkContinuity({ ...base, proposal: PROPOSAL, before: ORIGINAL });
  assert.equal(byText.kind, "relacion");
  assert.match(byText.message, /desconocido.*los personajes se reconocen/);
  const [byMemory] = checkContinuity({
    ...base,
    proposal: PROPOSAL,
    before: "Pola subió al bus.",
    relationships: [{ from: POLA, to: EDUARDO, kind: "conocido de la familia" }],
  });
  assert.match(byMemory.message, /en la Memoria Pola y Eduardo tienen una relación \(conocido de la familia\)/);
  // A stranger already in the original, or nobody tied: nothing to say.
  assert.deepEqual(checkContinuity({ ...base, proposal: PROPOSAL, before: "Un desconocido miraba a Pola." }).filter((w) => w.kind === "relacion"), []);
  assert.deepEqual(checkContinuity({ ...base, proposal: PROPOSAL, before: "Pola subió al bus." }).filter((w) => w.kind === "relacion"), []);
});

test("juicio comparativo: both versions, who is who, and a verdict that is only a recommendation", async () => {
  const { COMPARE_INSTRUCTIONS } = await import("@/lib/advisor/prompts");
  assert.match(COMPARE_INSTRUCTIONS, /Tu juicio es una recomendación para el autor; la decisión es suya/);
  assert.match(COMPARE_INSTRUCTIONS, /No favorezcas la versión más larga, la que tiene más acontecimientos/);
  assert.match(COMPARE_INSTRUCTIONS, /Tensión emocional, Subtexto, Ritmo, Naturalidad, Caracterización, Continuidad, Fuerza del desenlace/);
  const prompt = comparePrompt({ original: ORIGINAL, proposal: PROPOSAL, characters: [{ name: "Pola", block: "### Pola\nEdad: 18 años" }], relationships: ["- Pola → conoce → Eduardo"] });
  assert.match(prompt, /<memoria>[\s\S]*Edad: 18 años[\s\S]*Pola → conoce → Eduardo[\s\S]*<\/memoria>\n\n<original>\nEn el bus[\s\S]*<propuesta>\nEn la parada/);

  const c = parseComparison({
    verdict: "peor",
    summary: "Conserva tu versión.",
    criteria: [
      { name: "continuidad", winner: "original", why: "Se conocen." },
      { name: "Tensión emocional", winner: "original", why: "El reconocimiento." },
      { name: "Algo inventado", winner: "propuesta" },
      { name: "Ritmo", winner: "quién sabe" },
    ],
    losses: ["La manta como centro", 3, ""],
    changes: ["Eduardo pasa a ser un desconocido"],
  });
  assert.equal(c.verdict, "peor");
  assert.deepEqual(c.criteria.map((x) => [x.name, x.winner]), [["Tensión emocional", "original"], ["Ritmo", "empate"], ["Continuidad", "original"]], "the fixed criteria, in order");
  assert.deepEqual(c.losses, ["La manta como centro"]);
  assert.throws(() => parseComparison({ verdict: "quizá", summary: "x" }), /verdict/);
  assert.throws(() => parseComparison({ verdict: "igual" }), /summary/);
});
