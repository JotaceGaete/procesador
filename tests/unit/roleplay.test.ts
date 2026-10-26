import { test } from "node:test";
import assert from "node:assert/strict";
import { roleplayPrompt } from "../../src/lib/ai/roleplay";

test("roleplay: responde solo el interlocutor y conserva la dirección", () => {
  const prompt = roleplayPrompt({ name: "Any", authorName: "Carlos", personality: "Espontánea",
    objective: "Desea aceptar una invitación pero disimula", avoid: "No tutear a Carlos; tratarlo de usted", history: [{ speaker: "autor", text: "Hola Any, ¿cómo estás?" }] });
  assert.match(prompt, /No escribas sus respuestas/);
  assert.match(prompt, /Desea aceptar/);
  assert.match(prompt, /No tutear a Carlos; tratarlo de usted/);
  assert.match(prompt, /Carlos: Hola Any/);
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
