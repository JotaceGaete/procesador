// «La manta» with whole test scenes (tests/fixtures/la-manta/README.md): fictitious scenes
// written from the author's description of his two versions, not his text. What can be checked
// without a model: the scene goes to the model whole, the stranger version is flagged, the
// author's version is not, and both versions reach the comparison whole.
// scripts/la-manta-eval.ts runs the same scenes against a real provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planQuestion } from "@/lib/advisor/planner";
import { checkContinuity } from "@/lib/continuity";
import { comparePrompt } from "@/lib/advisor/compare";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/la-manta/${name}.txt`, import.meta.url), "utf8").split("\n\n").slice(1).join("\n\n").trim();
const ORIGINAL = fixture("original");
const DEFECTIVE = fixture("defectuosa");

const POLA = { name: "Pola", aliases: "" };
const EDUARDO = { name: "Eduardo", aliases: "don Eduardo" };

test("the test scenes are labelled as tests and match the author's description", () => {
  for (const name of ["original", "defectuosa"])
    assert.match(readFileSync(new URL(`../fixtures/la-manta/${name}.txt`, import.meta.url), "utf8"), /^\[ESCENA DE PRUEBA FICTICIA\./);
  assert.match(ORIGINAL, /Lo reconoció/, "they already know each other");
  assert.match(ORIGINAL, /manta de lana gris/);
  assert.match(ORIGINAL, /Entonces es de los dos/, "she invites him to share it");
  assert.doesNotMatch(ORIGINAL, /desconocid|parada|moneda/i);
  for (const re of [/Era un desconocido/, /parada de carretera/, /monedas/, /bolso/, /boleto/, /Qué casualidad/]) assert.match(DEFECTIVE, re);
});

test("asking to improve the whole scene is a review, whatever the words", () => {
  const ctx = { characters: [{ id: "p", ...POLA }, { id: "e", ...EDUARDO }], places: [], chapters: [{ title: "El viaje" }], threads: [] };
  for (const q of ["Haz esta escena más atractiva", "Mejora la escena de la manta", "¿Qué le falta a esta escena?", "Quiero que sea más intensa, púlela"])
    assert.equal(planQuestion(q, ctx).explicit, "revisar", q);
});

test("continuity: the stranger version is flagged against the author's scene and against the Memoria; the author's scene is not", () => {
  const base = { characters: [POLA, EDUARDO], places: [] };
  const byText = checkContinuity({ ...base, proposal: DEFECTIVE, before: ORIGINAL }).filter((w) => w.kind === "relacion");
  assert.equal(byText.length, 1);
  assert.match(byText[0].message, /«desconocido»[\s\S]*en el texto original los personajes se reconocen/);
  const byMemory = checkContinuity({ ...base, proposal: DEFECTIVE, before: "", relationships: [{ from: POLA, to: EDUARDO, kind: "conoce" }] });
  assert.match(byMemory.find((w) => w.kind === "relacion")!.message, /en la Memoria Pola y Eduardo tienen una relación \(conoce\)/);
  // The author's own scene, or a rewrite that keeps them acquainted: nothing to say.
  assert.deepEqual(checkContinuity({ ...base, proposal: ORIGINAL, before: ORIGINAL, relationships: [{ from: POLA, to: EDUARDO, kind: "conoce" }] }).filter((w) => w.kind === "relacion"), []);
});

test("the Asistente's «Revisar escena» receives the whole scene and only the changes the author approved", async () => {
  const { editPrompt } = await import("@/lib/ai/prompts");
  const prompt = editPrompt({ action: "revisar", character: null, selection: ORIGINAL, before: "", after: "", passages: null, notes: "Que la invitación llegue con menos explicación." });
  assert.ok(prompt.includes(ORIGINAL), "every line of the scene, untruncated");
  assert.match(prompt, /No añadas acontecimientos, incidentes, personajes ni complicaciones/);
  assert.match(prompt, /conserva su intensidad y su grado de explicitud/);
});

test("the comparison receives both versions whole, with who knows whom", () => {
  const prompt = comparePrompt({ original: ORIGINAL, proposal: DEFECTIVE, characters: [{ name: "Pola", block: "### Pola\nEdad: 18 años\nEmbarazada." }], relationships: ["- Pola → conoce → Eduardo"] });
  assert.ok(prompt.includes(`<original>\n${ORIGINAL}\n</original>`));
  assert.ok(prompt.includes(`<propuesta>\n${DEFECTIVE}\n</propuesta>`));
  assert.match(prompt, /Pola → conoce → Eduardo/);
});
