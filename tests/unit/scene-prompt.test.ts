import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCENE_PROVIDER_CRAFT,
  SCENE_PROVIDER_NOTES,
  WRITE_INSTRUCTIONS,
  scenePrompt,
  writeInstructions,
} from "../../src/lib/ai/prompts";

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

test("base común: fidelidad a los hechos del argumento, no a su redacción", () => {
  assert.match(WRITE_INSTRUCTIONS, /Fidelidad al argumento es fidelidad a sus acontecimientos, a su intención y a sus límites; no a su redacción/);
  assert.doesNotMatch(WRITE_INSTRUCTIONS, /tal como lo dice/);
  assert.match(WRITE_INSTRUCTIONS, /La narración del argumento es un plan, no un borrador: no la copies ni la corrijas por encima/);
  assert.match(WRITE_INSTRUCTIONS, /con la voz del manuscrito y de la Guía Maestra, no con la forma telegráfica o resumida/);
  // The author's own lines are kept as written.
  assert.match(WRITE_INSTRUCTIONS, /Las réplicas de diálogo que el autor escribe explícitamente[^\n]*consérvalas tal cual, sin embellecerlas ni cambiar lo que dicen/);
  assert.match(WRITE_INSTRUCTIONS, /Cuando el argumento nombra un estado interior[^\n]*hazlo visible en lo que el personaje hace, mira o dice/);
  const p = scenePrompt({ ...base, length: "media" });
  assert.match(p, /Argumento del autor: los hechos de la escena \(su plan, no su texto\):\n<argumento>/);
  assert.doesNotMatch(p, /y sólo esto/);
});

test("xAI: su bloque en el sistema, con el ejemplo Marta/Juan; nadie más lo recibe", () => {
  const xai = writeInstructions("xai");
  assert.ok(xai.startsWith(WRITE_INSTRUCTIONS), "on top of the common base, never instead of it");
  assert.equal(xai, `${WRITE_INSTRUCTIONS}\n\n${SCENE_PROVIDER_CRAFT.xai}`);
  assert.match(xai, /Escenificar, no resumir:/);
  assert.match(xai, /Para cada acontecimiento: qué hace el cuerpo \(una microacción\), qué se ve u oye en ese instante, cómo reacciona el otro/);
  assert.match(xai, /Resumen \(no\): «Marta estaba nerviosa y le pidió a Juan que se fuera\.»/);
  assert.match(xai, /enseña el procedimiento, no un estilo/);
  assert.ok(SCENE_PROVIDER_CRAFT.xai!.length < 1000, "short: a behaviour, not a style");
  assert.equal(writeInstructions("openai"), WRITE_INSTRUCTIONS);
  assert.equal(writeInstructions("anthropic"), WRITE_INSTRUCTIONS);
});

test("xAI: recordatorio de una línea al final de la tarea, con la extensión", () => {
  assert.equal(SCENE_PROVIDER_NOTES.openai, undefined);
  assert.equal(SCENE_PROVIDER_NOTES.anthropic, undefined);
  const p = scenePrompt({ ...base, length: "media", providerNote: SCENE_PROVIDER_NOTES.xai });
  assert.match(p, /Recuerda: no copies las frases del argumento; escenifícalas momento a momento, hasta alrededor de 800–1\.000 palabras\.\n\nEscribe la escena completa/);
  assert.doesNotMatch(scenePrompt({ ...base, length: "media" }), /Recuerda: no copies/);
});

test("Ampliar: el borrador, conservar lo ocurrido y su orden, sin acontecimientos nuevos", () => {
  const p = scenePrompt({ ...base, length: "media", draft: "Juan llegó. Elena calló.", providerNote: SCENE_PROVIDER_NOTES.xai });
  assert.match(p, /<borrador>\nJuan llegó\. Elena calló\.\n<\/borrador>/);
  assert.match(p, /\(≈4 palabras\)/);
  assert.match(p, /Desarróllala hasta alrededor de 800–1\.000 palabras\. Conserva todo lo que ocurre, en el mismo orden/);
  assert.match(p, /No añadas acontecimientos nuevos para ganar extensión ni rellenes/);
  assert.doesNotMatch(p, /Escribe la escena completa, desarrollada/);
});
