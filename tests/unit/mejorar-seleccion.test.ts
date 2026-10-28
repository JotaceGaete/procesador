import { test } from "node:test";
import assert from "node:assert/strict";

test("Mejorar selección: acción del Asistente, con prompt que no añade hechos", async () => {
  const { EDIT_ACTIONS } = await import("@/lib/types");
  const { editPrompt } = await import("@/lib/ai/prompts");
  const action = EDIT_ACTIONS.find((a) => a.id === "mejorar");
  assert.ok(action, "existe la acción mejorar");
  assert.equal(action.label, "Mejorar selección");
  assert.equal(action.section, "assistant");
  assert.equal(action.rewrites, true);
  const prompt = editPrompt({
    action: "mejorar",
    character: null,
    selection: "Hola, dijo ella.",
    before: "",
    after: "",
    passages: null,
  });
  assert.match(prompt, /No inventes acontecimientos/);
  assert.match(prompt, /<reescritura>/);
});
