// The author's plan for the Consejero (overview + details, no AI) and the automatic
// continuity check of the Asistente's proposals (no AI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterTag, planDetails, planOverview, paragraphs, questionWords } from "@/lib/advisor/plan-text";
import { checkContinuity, currentScene, spanishNumber } from "@/lib/continuity";
import { nameMatcher } from "@/lib/ai/context";

const PREMISE = "Una novela coral en un pueblo del sur de Chile: Pola y Héctor, un matrimonio desgastado, y los secretos que los rodean.";
const ENDING = "Desenlace: Pola deja a Héctor y se queda en el pueblo; Gerardo se va sin haber conseguido nada.";
const middle = Array.from({ length: 40 }, (_, i) =>
  i === 17
    ? "Gerardo, primo de Héctor, llega al pueblo en el capítulo 12. Intentará quedarse con Pola. Se insinúa poco a poco, nunca de frente."
    : `Tramo ${i + 1}. Lo que pasa en el pueblo en esa época, con detalle suficiente para ocupar espacio en el plan del autor y su historia paralela.`,
);
const LONG = [PREMISE, "## Segunda parte", ...middle, ENDING].join("\n\n");

test("plan: a short plan goes whole; a long one keeps the premise, the headings, every paragraph's first sentence and the ending", () => {
  const short = planOverview("Pola y Héctor.\n\nDesenlace: se separan.", 7000);
  assert.deepEqual([short.whole, short.text], [true, "Pola y Héctor.\n\nDesenlace: se separan."]);

  const o = planOverview(LONG, 4000);
  assert.equal(o.whole, false);
  assert.ok(o.text.length <= 4000, `within budget (${o.text.length})`);
  assert.ok(o.text.startsWith(PREMISE), "the premise");
  assert.ok(o.text.endsWith(ENDING), "the ending");
  assert.match(o.text, /## Segunda parte/);
  assert.match(o.text, /Gerardo, primo de Héctor, llega al pueblo en el capítulo 12\. \[…\]/, "first sentences: the global view");
  assert.doesNotMatch(o.text, /Intentará quedarse con Pola/, "the detail is not in the overview");
  assert.deepEqual(planOverview(LONG, 4000), o, "the same every turn (cacheable)");
  // Much longer: still within budget, the middle thinned out, premise and ending kept.
  const huge = planOverview([PREMISE, ...Array.from({ length: 400 }, (_, i) => `Tramo ${i}. ${"x".repeat(120)}.`), ENDING].join("\n\n"), 7000);
  assert.ok(huge.text.length <= 7000 && huge.text.startsWith(PREMISE) && huge.text.endsWith(ENDING));
});

test("plan: the details are the whole paragraphs about the people in play or the question's words", () => {
  const o = planOverview(LONG, 4000);
  const gerardo = nameMatcher({ name: "Gerardo", aliases: "" })!;
  const d = planDetails(LONG, { matchers: [gerardo], words: [], budget: 3000, skip: o.full });
  assert.equal(d, middle[17]);
  assert.match(d, /Intentará quedarse con Pola/);
  assert.equal(planDetails(LONG, { matchers: [], words: questionWords("¿Cómo sigue la historia paralela?"), budget: 400, skip: o.full }).split("\n\n").length, 2, "within budget");
  assert.equal(planDetails(LONG, { matchers: [], words: [], budget: 3000, skip: o.full }), "", "nothing relevant: nothing");
  assert.equal(paragraphs(LONG)[1].heading, true);
});

const memory = {
  characters: [
    { name: "Marcela", aliases: "" },
    { name: "Claudia", aliases: "Clau" },
    { name: "Héctor", aliases: "" },
  ],
  places: [
    { name: "Supermercado", aliases: "el súper" },
    { name: "Casa de Pola", aliases: "" },
  ],
};

test("continuity: a garment that changes colour, or another of the same kind, is worth a look; shoes are not", () => {
  const before = "Marcela llegó temprano con su cotona azul y las botas mojadas.";
  const w = checkContinuity({ ...memory, proposal: "Marcela se ajustó la cotona roja.", before });
  assert.deepEqual(w.map((x) => x.kind), ["ropa"]);
  assert.match(w[0].message, /Antes en la escena: «cotona azul»; la propuesta dice «cotona roja»/);
  assert.match(checkContinuity({ ...memory, proposal: "Marcela se arregló la blusa.", before })[0].message, /describía «cotona azul»; la propuesta habla de «blusa»/);
  assert.deepEqual(checkContinuity({ ...memory, proposal: "Marcela se quitó los zapatos y la cotona azul.", before }), [], "same garment and colour; other kind");
  assert.deepEqual(checkContinuity({ ...memory, proposal: "Se puso una blusa.", before: "Llovía." }), [], "nothing described before");
});

test("continuity: a new name not in the Memoria nor earlier; known names, sentence starts and the argument are fine", () => {
  const w = checkContinuity({ ...memory, proposal: "Marcela esperó. En el pasillo, Rodrigo la miraba. Llegó Héctor con Clau.", before: "Marcela estaba sola." });
  assert.deepEqual(w.map((x) => x.message), ["Aparece «Rodrigo», que no está en la Memoria ni antes en la escena. ¿Es alguien nuevo?"]);
  assert.deepEqual(checkContinuity({ ...memory, proposal: "Esperó a Rodrigo, que vino el lunes de Navidad.", before: "", given: "Llega Rodrigo." }), []);
});

test("continuity: the scene's place and the ages of the Cronología", () => {
  const place = memory.places[0];
  assert.deepEqual(
    checkContinuity({ ...memory, place, proposal: "Marcela entró en la Casa de Pola sin llamar.", before: "" }).map((x) => x.kind),
    ["lugar"],
  );
  assert.deepEqual(checkContinuity({ ...memory, place, proposal: "En el súper, Marcela pensó en la Casa de Pola.", before: "" }), [], "only mentioned");
  const ages = [{ name: "Claudia", aliases: "Clau", min: 25, max: 25, approx: false }];
  assert.match(checkContinuity({ ...memory, ages, proposal: "Claudia, de veinte años, cerró la ventana.", before: "" })[0].message, /da a Claudia 20 años; según la Cronología, en este punto tiene 25/);
  assert.deepEqual(checkContinuity({ ...memory, ages, proposal: "Claudia recordó cuando tenía veinte años.", before: "" }), [], "a memory");
  assert.deepEqual(checkContinuity({ ...memory, ages, proposal: "Clau tenía 25 años.", before: "" }), []);
  assert.deepEqual([spanishNumber("treinta y dos"), spanishNumber("veinticinco"), spanishNumber("40"), spanishNumber("mesa")], [32, 25, 40, null]);
});

test("continuity: the current scene starts after the last scene break", () => {
  assert.equal(currentScene("Antes.\n\n[[separador]]\n\nAhora."), "[[separador]]\n\nAhora.");
  assert.equal(currentScene("Sin cortes."), "Sin cortes.");
});

test("plan: a paragraph that names its chapter is tagged as still to come or already written, by the open chapter", () => {
  assert.equal(chapterTag("Gerardo llega en el capítulo 12.", 5), "[Previsto para el cap. 12 · aún no escrito: no ha ocurrido]");
  assert.equal(chapterTag("En el cap. 3 Pola miente.", 5), "[Previsto para el cap. 3 · ya escrito: manda el manuscrito; compruébalo]");
  assert.equal(chapterTag("Entre los capítulos 4 y 9 crece la sospecha.", 5), "[Previsto para los caps. 4–9 · el abierto es el 5: lo posterior no ha ocurrido]");
  assert.equal(chapterTag("Caps. 20-22: la boda.", 5), "[Previsto para los caps. 20–22 · aún no escrito: no ha ocurrido]");
  assert.equal(chapterTag("Pola y Eduardo se aman.", 5), "", "no chapter: no tag");
  const gerardo = nameMatcher({ name: "Gerardo", aliases: "" })!;
  const d = planDetails(LONG, { matchers: [gerardo], words: [], budget: 3000, skip: planOverview(LONG, 4000).full, current: 4 });
  assert.equal(d, `[Previsto para el cap. 12 · aún no escrito: no ha ocurrido] ${middle[17]}`);
});
