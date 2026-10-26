import { test } from "node:test";
import assert from "node:assert/strict";
import { dialoguePrompt } from "../../src/lib/ai/dialogue";

test("director: conserva argumento, participantes y oyentes", () => {
  const result = dialoguePrompt({
    argument: "Sonia se justifica; Carlos duda; Any calla.",
    participants: [
      { name: "Carlos", role: "habla", personality: "Reservado", voice: "Frases cortas" },
      { name: "Any", role: "escucha", unaware: "No conoce la clave" },
      { name: "Sonia", role: "habla", occasional: true, personality: "No debe enviarse" },
    ],
    length: "breve",
  });
  assert.match(result, /Any — presente, escucha/);
  assert.match(result, /Sonia \(ocasional\)/);
  assert.match(result, /180 palabras/);
  assert.match(result, /Sonia se justifica/);
  assert.doesNotMatch(result, /No debe enviarse/);
});

test("director: no permite argumentos vacíos ni personajes duplicados", () => {
  assert.throws(() => dialoguePrompt({ argument: "", participants: [] }));
  assert.throws(() => dialoguePrompt({
    argument: "Hablan",
    participants: [{ name: "Any", role: "habla" }, { name: "any", role: "habla" }],
  }));
});

test("director: limita texto para ahorrar tokens", () => {
  const result = dialoguePrompt({
    argument: "x".repeat(5000),
    context: "y".repeat(2000),
    participants: [{ name: "A", role: "habla", personality: "z".repeat(1000) }, { name: "B", role: "habla" }],
  });
  assert.ok(result.length < 5000);
});
