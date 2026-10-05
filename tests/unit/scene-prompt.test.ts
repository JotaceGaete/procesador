import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENE_PROVIDER_NOTES, WRITE_INSTRUCTIONS, scenePrompt } from "../../src/lib/ai/prompts";

const base = { argument: "Juan y Elena discuten.", chapter: "Capítulo 1", previousChapterTail: null, before: "Antes.", after: "" };

test("instrucciones: dramatizar, no resumir; contención no es brevedad; se mantienen las reglas de estilo", () => {
  assert.match(WRITE_INSTRUCTIONS, /Desarrollar una escena es dramatizarla, no resumirla/);
  assert.match(WRITE_INSTRUCTIONS, /esa conversación ocurre en escena[^\n]*no la resuelvas con «hablaron de…»/);
  assert.match(WRITE_INSTRUCTIONS, /Si nadie interactúa, no fuerces el diálogo/);
  assert.match(WRITE_INSTRUCTIONS, /Contención no es brevedad/);
  // The rules against padding and invented events are still there.
  assert.match(WRITE_INSTRUCTIONS, /No añadas acontecimientos que cambien la historia/);
  assert.match(WRITE_INSTRUCTIONS, /Nada de prosa genérica de IA/);
  assert.match(WRITE_INSTRUCTIONS, /Termina donde termina el argumento/);
});

test("extensión: rangos orientativos, sin cuota", () => {
  const cases = [
    ["breve", "alrededor de 300–500 palabras"],
    ["media", "alrededor de 800–1.000 palabras"],
    ["larga", "alrededor de 1.500–2.100 palabras"],
  ] as const;
  for (const [length, range] of cases) {
    const p = scenePrompt({ ...base, length });
    assert.equal(p.split(range).length - 1, 2, `${length}: said at the task and at the end`);
    assert.match(p, /Es una orientación, no una cuota: no rellenes para llegar/);
  }
  const free = scenePrompt({ ...base, length: "libre" });
  assert.match(free, /la extensión natural que la escena necesite, sin resumir/);
  assert.doesNotMatch(free, /palabras/);
});

test("la nota de Grok sólo cuando se pasa, con la extensión pedida", () => {
  assert.ok(SCENE_PROVIDER_NOTES.xai);
  assert.equal(SCENE_PROVIDER_NOTES.openai, undefined);
  assert.equal(SCENE_PROVIDER_NOTES.anthropic, undefined);
  const p = scenePrompt({ ...base, length: "media", providerNote: SCENE_PROVIDER_NOTES.xai });
  assert.match(p, /Importante: no resumas el argumento\. Escribe la escena entera en tiempo de escena, desarrollando cada momento que contiene, hasta alrededor de 800–1\.000 palabras\./);
  assert.doesNotMatch(scenePrompt({ ...base, length: "media" }), /Importante: no resumas/);
});

test("Ampliar: el borrador, conservar lo ocurrido y su orden, sin acontecimientos nuevos", () => {
  const p = scenePrompt({ ...base, length: "media", draft: "Juan llegó. Elena calló.", providerNote: SCENE_PROVIDER_NOTES.xai });
  assert.match(p, /<borrador>\nJuan llegó\. Elena calló\.\n<\/borrador>/);
  assert.match(p, /\(≈4 palabras\)/);
  assert.match(p, /Desarróllala hasta alrededor de 800–1\.000 palabras\. Conserva todo lo que ocurre, en el mismo orden/);
  assert.match(p, /No añadas acontecimientos nuevos para ganar extensión ni rellenes/);
  assert.doesNotMatch(p, /Escribe la escena completa, desarrollada/);
});
