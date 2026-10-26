import { test } from "node:test";
import assert from "node:assert/strict";
import { roleplayPrompt, roleplayMessages } from "../../src/lib/ai/roleplay";

test("roleplay: responde solo el interlocutor y conserva la dirección", () => {
  const prompt = roleplayPrompt({ name: "Any", authorName: "Carlos", personality: "Espontánea",
    objective: "Desea aceptar una invitación pero disimula", avoid: "No tutear a Carlos; tratarlo de usted", permanentRules: "No usar frases de conquista", history: [{ speaker: "autor", text: "Hola Any, ¿cómo estás?" }] });
  assert.match(prompt, /no escribas por ella/i);
  assert.match(prompt, /Desea aceptar/);
  assert.match(prompt, /No tutear a Carlos; tratarlo de usted/);
  assert.match(prompt, /No usar frases de conquista/);
  assert.deepEqual(roleplayMessages([{ speaker: "autor", text: "Hola Any, ¿cómo estás?" }]), [{ role: "user", content: "Hola Any, ¿cómo estás?" }]);
  assert.match(prompt, /Carácter: Espontánea/);
});

test("roleplay: exige intervención del autor", () => {
  assert.throws(() => roleplayPrompt({ name: "Any", authorName: "Carlos", history: [] }));
  assert.throws(() => roleplayPrompt({ name: "Any", authorName: "Carlos",
    history: [{ speaker: "personaje", text: "Bien" }] }));
});

test("roleplay: limita historial y ficha para ahorrar tokens", () => {
  const history = Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? "autor" as const : "personaje" as const, text: "x".repeat(1000) }));
  const prompt = roleplayPrompt({ name: "Any", authorName: "Carlos", personality: "y".repeat(3000), history });
  assert.ok(prompt.length < 10000);
  assert.doesNotMatch(prompt, /y{401}/);
});

test("roleplay: mantiene turnos y acciones separados del diálogo", () => {
  const turns = roleplayMessages([
    { speaker: "autor", text: "No es caro.", context: "Carlos la mira con mala cara." },
    { speaker: "personaje", text: "Bueno, jefe." },
    { speaker: "autor", text: "¿Se enojó?" },
  ]);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.match(turns[0].content, /Carlos la mira con mala cara/);
  assert.match(turns[0].content, /No es caro/);
});
