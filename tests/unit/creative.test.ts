// Consejero creativo, phase 1: labels, references ("el segundo", "la B", "el último"),
// states and the proposal in course, all without AI; and the planner's new intents.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignLabels,
  cardStates,
  cardsBlock,
  conversationCards,
  currentFocus,
  isDiscard,
  leavesFocus,
  resolveReference,
  type ConversationMessage,
} from "@/lib/advisor/cards";
import { NEW_TOPIC, planQuestion } from "@/lib/advisor/planner";
import { verifyObservations } from "@/lib/advisor/observations";
import type { ObservationKind } from "@/lib/types";

const obs = (id: string, title: string, kind: ObservationKind = "alternative", status: "new" | "saved" | "dismissed" = "new") => ({
  id,
  kind,
  title,
  body: `${title}: cuerpo`,
  status,
});
const author = (content: string, anchor?: { id: string; label: string; title: string }): ConversationMessage => ({
  role: "author",
  content,
  context: anchor ? { anchor: { ...anchor, how: "ordinal" } } : null,
  observations: [],
});
const advisor = (list: ReturnType<typeof obs>[], cards?: { label: string; from: string | null }[]): ConversationMessage => ({
  role: "advisor",
  content: "respuesta",
  context: cards ? { cards } : null,
  observations: list.map((o, position) => ({ ...o, position })),
});

// "No sé cómo continuar." → A, B, C
const three = [author("No sé cómo continuar."), advisor([obs("a", "La pelea"), obs("b", "La carta"), obs("c", "El viaje")])];

test("labels: A, B, C in order; versions of an anchored card are B2, B3; letters never reused", () => {
  assert.deepEqual(assignLabels([], ["alternative", "alternative", "alternative"], null), [
    { label: "A", from: null },
    { label: "B", from: null },
    { label: "C", from: null },
  ]);
  assert.deepEqual(assignLabels(["A", "B", "C"], ["alternative", "opportunity"], { label: "B" }), [
    { label: "B2", from: "B" },
    { label: "D", from: null },
  ]);
  assert.deepEqual(assignLabels(["A", "B", "C", "B2"], ["alternative"], { label: "B2" }), [{ label: "B3", from: "B2" }], "a version of a version");
  assert.deepEqual(assignLabels(["A", "B", "C", "B2", "D"], ["pacing"], null), [{ label: "E", from: null }]);
  assert.equal(assignLabels(Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), ["alternative"], null)[0].label, "AA");
  // Stored labels win; older messages without them get letters in order.
  const cards = conversationCards([...three, author("¿Y otra?"), advisor([obs("d", "Otra")])]);
  assert.deepEqual(cards.map((c) => c.label), ["A", "B", "C", "D"]);
});

test("1. «el segundo» resolves to Camino B", () => {
  const cards = conversationCards(three);
  for (const q of ["Me gusta el segundo.", "Me gusta el segundo", "me quedo con el segundo, pero cambiaría el final", "El segundo me convence", "el segundo camino", "Prefiero la segunda opción"]) {
    const r = resolveReference(q, cards);
    assert.equal(r?.card.label, "B", q);
    assert.equal(r?.how, "ordinal");
  }
  // Not a card: an ordinal that names something else.
  for (const q of ["En el segundo capítulo Elena miente.", "la primera vez que se vieron", "el tercer día"]) assert.equal(resolveReference(q, cards), null, q);
});

test("2. «la B» resolves to Camino B (and «camino b», «B», «lo de la B»)", () => {
  const cards = conversationCards(three);
  for (const q of ["Me gusta la B", "Desarrolla la B.", "camino b", "B", "B.", "lo de la B me interesa", "¿Y si en la B aparece Nacho?"]) {
    assert.equal(resolveReference(q, cards)?.card.label, "B", q);
  }
  assert.equal(resolveReference("Vamos a la playa", cards), null);
  assert.equal(resolveReference("la Z", cards), null, "a label that doesn't exist");
});

test("3. «el último» resolves to the last card of the most recent answer; «el penúltimo» too", () => {
  const cards = conversationCards(three);
  assert.equal(resolveReference("Me quedo con el último.", cards)?.card.label, "C");
  assert.equal(resolveReference("la última me gusta", cards)?.card.label, "C");
  assert.equal(resolveReference("el penúltimo", cards)?.card.label, "B");
  assert.equal(resolveReference("En el último capítulo", cards), null);
  // After an answer with one card (B2), "el segundo" still means the last answer that had two.
  const later = conversationCards([...three, author("Me gusta el segundo", { id: "b", label: "B", title: "La carta" }), advisor([obs("b2", "La carta, con Nacho")], [{ label: "B2", from: "B" }])]);
  assert.equal(resolveReference("el segundo", later)?.card.label, "B");
  assert.equal(resolveReference("el último", later)?.card.label, "B2");
  assert.equal(resolveReference("camino 3", later)?.card.label, "C");
});

test("discarding by name and leaving the focus are recognised; negations are not discards", () => {
  assert.equal(isDiscard("Descarta la C"), true);
  assert.equal(isDiscard("descartemos el primero"), true);
  assert.equal(isDiscard("Olvídate de la A"), true);
  assert.equal(isDiscard("no me gusta la B"), true);
  assert.equal(isDiscard("No descartes la B"), false);
  assert.equal(isDiscard("Me gusta el segundo"), false);
  assert.equal(isDiscard("No, mejor sin Nacho."), false, "a change, not a discard");
  assert.equal(leavesFocus("Cambiemos de tema"), true);
  assert.equal(leavesFocus("Pero quiero que aparezca Nacho"), false);
});

test("5. states: a version doesn't destroy the proposal it comes from; the focus follows the versions", () => {
  const msgs: ConversationMessage[] = [
    ...three,
    author("Me gusta el segundo.", { id: "b", label: "B", title: "La carta" }),
    advisor([obs("b2", "La carta")], [{ label: "B2", from: "B" }]),
    author("Pero quiero que también aparezca Nacho.", { id: "b2", label: "B2", title: "La carta" }),
    advisor([obs("b3", "La carta, con Nacho")], [{ label: "B3", from: "B2" }]),
  ];
  const states = cardStates(msgs);
  const by = Object.fromEntries(states.map((c) => [c.label, c]));
  assert.deepEqual(Object.keys(by), ["A", "B", "C", "B2", "B3"], "B is still there, with its body");
  assert.equal(by.B.body, "La carta: cuerpo");
  assert.deepEqual([by.A.state, by.B.state, by.C.state, by.B2.state, by.B3.state], ["PROPUESTO", "MODIFICADO", "PROPUESTO", "MODIFICADO", "PROPUESTO"]);
  assert.deepEqual(by.B.versions, ["B2"]);
  assert.equal(by.B.chosen, true);
  assert.equal(currentFocus(msgs)?.label, "B3", "the proposal in course is the latest version");

  // "No, mejor sin Nacho" → B4: B3 stays, as a modified version.
  const more = [...msgs, author("No, mejor sin Nacho.", { id: "b3", label: "B3", title: "La carta, con Nacho" }), advisor([obs("b4", "La carta, sin Nacho")], [{ label: "B4", from: "B3" }])];
  const s2 = Object.fromEntries(cardStates(more).map((c) => [c.label, c.state]));
  assert.deepEqual([s2.B3, s2.B4], ["MODIFICADO", "PROPUESTO"]);
  assert.equal(currentFocus(more)?.label, "B4");
  // A message without an anchor ends the focus.
  assert.equal(currentFocus([...more, author("Cambiemos de tema")]), null);
});

test("6. a discarded proposal goes to the model only by its title, marked as not true; never its body", () => {
  const msgs = [author("No sé cómo continuar."), advisor([obs("a", "La pelea"), obs("b", "Nacho muere en el incendio", "alternative", "dismissed"), obs("c", "El viaje", "alternative", "saved")])];
  const states = cardStates(msgs);
  assert.deepEqual(states.map((c) => c.state), ["PROPUESTO", "DESCARTADO", "PROPUESTO"]);
  const block = cardsBlock(states, null);
  assert.match(block, /Ninguna es un hecho de la novela/);
  assert.match(block, /- B · DESCARTADO por el autor — «Nacho muere en el incendio»\. No la propongas de nuevo salvo que el autor la recupere; no es verdad en la novela\./);
  assert.doesNotMatch(block, /Nacho muere en el incendio: cuerpo/, "the body of a discarded card is not sent");
  assert.match(block, /- C · PROPUESTO · guardada por el autor como idea — «El viaje»/, "saved is still an idea");
  assert.doesNotMatch(block, /CANON|hecho aprobado/i);
  // A discarded card can't be the proposal in course.
  assert.equal(currentFocus([...msgs, author("la B", { id: "b", label: "B", title: "x" })]), null);
});

test("12. long conversations: labels stay unique and the block keeps the last cards, the oldest shortened", () => {
  const msgs: ConversationMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(author(`pregunta ${i}`));
    const used = conversationCards(msgs).map((c) => c.label);
    const kinds: ObservationKind[] = ["alternative", "alternative", "alternative"];
    msgs.push(advisor(kinds.map((k, j) => obs(`m${i}c${j}`, `Idea ${i}.${j}`, k)), assignLabels(used, kinds, null)));
  }
  const cards = conversationCards(msgs);
  assert.equal(cards.length, 60);
  assert.equal(new Set(cards.map((c) => c.label)).size, 60, "no label repeats");
  assert.equal(resolveReference("la B", cards)?.card.title, "Idea 0.1", "B is still the B of the first answer");
  assert.equal(resolveReference("el segundo", cards)?.card.title, "Idea 19.1", "ordinals: the most recent answer");
  const block = cardsBlock(cardStates(msgs), null);
  assert.match(block, /las últimas 40 de 60/);
  assert.ok(block.length < 12_000, `bounded (${block.length})`);
  assert.doesNotMatch(block, /Idea 0\.1/, "the oldest fall out of the block (still resolvable by label)");
});

test("planner: the creative intents", () => {
  const ctx = { characters: [{ id: "n", name: "Nacho", aliases: "" }], places: [], chapters: [{ title: "" }], threads: [] };
  const action = (q: string) => planQuestion(q, ctx).action;
  assert.equal(action("No sé cómo continuar."), "seguir");
  assert.equal(action("Estoy bloqueado"), "seguir");
  assert.equal(action("Dame 3 caminos"), "caminos");
  assert.equal(action("¿Qué opciones tengo?"), "caminos");
  assert.equal(action("¿Qué pasa si Nacho descubre la carta?"), "consecuencias");
  assert.equal(action("¿Y si Elena se va?"), "consecuencias");
  assert.equal(action("¿Qué consecuencias tendría?"), "consecuencias");
  assert.equal(action("Necesito un giro"), "giro");
  assert.equal(action("Quiero algo inesperado"), "giro");
  assert.equal(action("Busca oportunidades"), "oportunidades");
  assert.equal(action("¿Qué puedo aprovechar de lo escrito?"), "oportunidades");
  assert.equal(action("¿Qué personajes estoy desaprovechando?"), "personajes", "not an opportunity");
  assert.equal(action("Quiero subir la tensión"), "tension");
  assert.equal(action("Le falta tensión a la escena"), "tension");
  assert.equal(action("¿Funciona la tensión del capítulo?"), "analizar", "asking about it is analysis");
  // No intent: a fallback, and `explicit` says so (the conversation decides then).
  const p = planQuestion("Pero quiero que también aparezca Nacho.", ctx);
  assert.deepEqual([p.explicit, p.characterIds], [null, ["n"]]);
  assert.ok(NEW_TOPIC.includes("caminos") && !NEW_TOPIC.includes("consecuencias"));
});

test("proposals in sections: the body carries each one under its label", () => {
  const [o] = verifyObservations(
    [{ kind: "alternative", title: "La carta", ocurre: "Elena la encuentra.", porque: "Está plantada.", aprovecha: "El cajón", consecuencias: "Juan miente.", riesgos: "Prisa.", personajes: ["Elena", "Juan"], refs: [] }],
    [{ id: "c1", content: "x" }],
  );
  assert.equal(
    o.body,
    "Qué podría ocurrir: Elena la encuentra.\nPor qué funciona aquí: Está plantada.\nQué aprovecha: El cajón\nConsecuencias: Juan miente.\nRiesgos: Prisa.\nPersonajes: Elena, Juan",
  );
});
