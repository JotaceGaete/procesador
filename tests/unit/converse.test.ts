// Consejero, Conversar: the author's words read without AI (intents, decisions, discards),
// the conversation's plan, and the brief the Asistente accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefBlock,
  conversationPlan,
  decisionsIn,
  discardsIn,
  lastProposal,
  likesProposal,
  parseBrief,
  planBlock,
  wantsAnalysis,
  wantsHandoff,
  wantsOptions,
  wantsSave,
} from "@/lib/advisor/converse";
import { conversationCards, type ConversationMessage } from "@/lib/advisor/cards";
import { planQuestion } from "@/lib/advisor/planner";

test("intents: one proposal by default, several only when asked; an analysis only when asked", () => {
  for (const q of ["Dame opciones", "¿Qué alternativas tengo?", "dame varias ideas", "Dame 3 caminos", "otras ideas"]) assert.equal(wantsOptions(q), true, q);
  for (const q of ["¿Cómo puedo continuar?", "No sé cómo seguir", "Quiero que Waldo vuelva"]) assert.equal(wantsOptions(q), false, q);
  for (const q of ["Analiza el capítulo", "Revisa la coherencia del capítulo", "¿Hay repeticiones?", "¿Qué cabos pendientes quedan?", "Evalúa el ritmo"])
    assert.equal(wantsAnalysis(q), true, q);
  for (const q of ["¿Cómo puedo continuar?", "Quiero que Waldo haya sido novio de Pola", "Me gusta, desarróllala"]) assert.equal(wantsAnalysis(q), false, q);
});

test("intents: «me gusta», «esa quiero», «desarróllala» continue the proposal; «envíala al Asistente», «guárdala»", () => {
  for (const q of ["Me gusta", "Me gusta, desarróllala.", "Esa quiero", "esa me gusta", "Desarróllala", "sí, me encanta", "Perfecto, sigue con esa", "Me quedo con esa"])
    assert.equal(likesProposal(q), true, q);
  for (const q of ["No me gusta nada", "¿Cómo continúo?", "Quiero que Waldo haya sido novio de Pola"]) assert.equal(likesProposal(q), false, q);
  for (const q of ["Envíala al Asistente", "mándala al asistente", "pásala al Asistente, por favor", "Llévala al asistente"]) assert.equal(wantsHandoff(q), true, q);
  assert.equal(wantsHandoff("¿Qué hace el Asistente?"), false);
  assert.equal(wantsSave("Guárdala"), true);
  assert.equal(wantsSave("Guarda esa idea"), true);
  assert.equal(wantsSave("Guarda silencio Pola"), false);
});

test("decisions: the author's own words, as a plan; discards, including «sin Nacho» but not «sin embargo»", () => {
  assert.deepEqual(decisionsIn("Quiero que Waldo haya sido amigo de infancia de Pola y Casandra, y novio juvenil de Pola."), [
    "Quiero que Waldo haya sido amigo de infancia de Pola y Casandra, y novio juvenil de Pola.",
  ]);
  assert.deepEqual(decisionsIn("Me gusta. He decidido que Héctor no lo sabe. ¿Cómo lo introduzco?"), ["He decidido que Héctor no lo sabe."]);
  assert.deepEqual(decisionsIn("¿Cómo puedo continuar?"), []);
  assert.deepEqual(decisionsIn("No quiero que muera."), [], "a «no quiero que» is a discard, not a decision");
  assert.deepEqual(discardsIn("No, mejor sin Nacho."), ["No, mejor sin Nacho."]);
  assert.deepEqual(discardsIn("No quiero que muera."), ["No quiero que muera."]);
  assert.deepEqual(discardsIn("Sin embargo, me gusta."), []);
});

const author = (content: string, ctx: Record<string, unknown> | null = null): ConversationMessage => ({ role: "author", content, context: ctx, observations: [] });
const advisor = (ids: string[]): ConversationMessage => ({
  role: "advisor",
  content: "…",
  context: null,
  observations: ids.map((id, position) => ({ id, kind: "alternative", title: id, body: "", status: "new", position })),
});

test("the plan: decisions in order; a later «sin Nacho» takes back the decision about Nacho; the block says it isn't canon", () => {
  const msgs = [
    author("Quiero que Waldo haya sido novio de Pola.", { decisions: ["Quiero que Waldo haya sido novio de Pola."] }),
    advisor(["a"]),
    author("Pero quiero que también aparezca Nacho.", { decisions: ["Pero quiero que también aparezca Nacho."] }),
    advisor(["b"]),
    author("No, mejor sin Nacho.", { discarded: ["No, mejor sin Nacho."] }),
  ];
  const plan = conversationPlan(msgs);
  assert.deepEqual(plan.decisions.map((d) => d.text), ["Quiero que Waldo haya sido novio de Pola."]);
  assert.deepEqual(plan.discarded, [{ text: "No, mejor sin Nacho.", message: 4 }]);
  const block = planBlock(plan);
  assert.match(block, /PLAN: lo ha decidido él; trabaja con ellas, no las discutas; aún no están escritas en el manuscrito ni son canon/);
  assert.match(block, /Descartado por el autor \(no lo propongas ni lo incluyas\):\n- No, mejor sin Nacho\./);
  assert.equal(planBlock(conversationPlan([author("hola")])), "");
});

test("the proposal on the table: the latest one not discarded", () => {
  const msgs = [advisor(["a", "b"]), author("x"), advisor(["c"])];
  const cards = conversationCards(msgs);
  assert.equal(lastProposal(cards)?.id, "c");
  cards[2].status = "dismissed";
  assert.equal(lastProposal(cards)?.id, "b");
});

test("the brief: validated against the novel; long or foreign data rejected or trimmed; its block for the scene", () => {
  const known = { characters: ["pola", "waldo"], places: ["casa"] };
  const b = parseBrief(
    {
      argument: "  Una cena en casa de Pola. ",
      decisions: ["Waldo fue novio de Pola", "", 3, "x".repeat(900)],
      constraints: ["No revelar todavía lo de Casandra"],
      discarded: ["Nacho"],
      characterIds: ["pola", "otra-novela"],
      placeId: "otro",
      target: "cursor",
      source: "Propuesta B",
    },
    known,
  );
  assert.equal(b.argument, "Una cena en casa de Pola.");
  assert.deepEqual(b.decisions.map((d) => d.length), [23, 500]);
  assert.deepEqual(b.characterIds, ["pola"], "a character of another novel is dropped");
  assert.equal(b.placeId, null);
  assert.equal(b.target, "cursor");
  assert.throws(() => parseBrief({ argument: "" }, known), /necesita un argumento/);
  assert.throws(() => parseBrief({ argument: "x".repeat(7000) }, known), /demasiado largo/);
  assert.throws(() => parseBrief("nope", known), /no es válido/);
  assert.equal(
    briefBlock(b),
    "Decisiones del autor (cúmplelas como el argumento):\n- Waldo fue novio de Pola\n- " +
      "x".repeat(500) +
      "\n\nRestricciones (no las rompas):\n- No revelar todavía lo de Casandra\n\nDescartado por el autor (no debe ocurrir ni aparecer):\n- Nacho",
  );
});

test("planner: «¿cómo puedo continuar?» is still «seguir»; a decision has no analytic intent", () => {
  const ctx = { characters: [{ id: "w", name: "Waldo", aliases: "" }], places: [], chapters: [{ title: "" }], threads: [] };
  for (const q of ["¿Cómo puedo continuar?", "¿Cómo podría seguir?", "¿Por dónde sigo?", "¿Cómo lo continúo?"]) assert.equal(planQuestion(q, ctx).action, "seguir", q);
  const p = planQuestion("Quiero que Waldo haya sido amigo de infancia de Pola y Casandra.", ctx);
  assert.equal(p.explicit, null);
});
