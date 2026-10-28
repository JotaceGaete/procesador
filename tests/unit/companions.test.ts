import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANIONS, companionPrompt, pickCompanion } from "../../src/lib/companions";

test("selección: infantil → Kiki, adulta → Bruno; el elegido manda; sin género usa el primero", () => {
  assert.equal(pickCompanion("Infantil").id, "kiki");
  assert.equal(pickCompanion("Novela adulta, policial").id, "bruno");
  assert.equal(pickCompanion("Histórica").id, COMPANIONS[0].id);
  assert.equal(pickCompanion(undefined).id, COMPANIONS[0].id);
  assert.equal(pickCompanion("infantil", "bruno").id, "bruno");
  assert.equal(pickCompanion("infantil", "no-existe").id, "kiki");
});

test("pedido: lee el argumento y el capítulo antes de opinar, y no recibe el manuscrito entero", () => {
  const p = companionPrompt({
    companion: COMPANIONS[1],
    novel: { title: "La manta", guide: { genero: "adulta" } },
    synopsis: "Dos hermanos se reencuentran.",
    chapter: "Capítulo de prueba.",
    previousTail: "Fin anterior.",
    request: "Leamos juntos",
  });
  assert.match(p, /ANTES de opinar debes leer el argumento y el capítulo/);
  assert.match(p, /Argumento:\nDos hermanos se reencuentran\./);
  assert.match(p, /Capítulo abierto:\nCapítulo de prueba\./);
  assert.match(p, /Final del capítulo anterior:\nFin anterior\./);
  assert.match(p, /Pedido del autor: Leamos juntos/);
});

test("pedido: sin estilo definido, el compañero sólo lee y pregunta", () => {
  const p = companionPrompt({
    companion: COMPANIONS[0],
    novel: { title: "x", guide: {} },
    synopsis: "",
    chapter: "x",
    request: "Propón tramas",
  });
  assert.match(p, /Todavía no tienes un estilo definido/);
  assert.match(p, /\(sin argumento\)/);
  assert.doesNotMatch(p, /Final del capítulo anterior/);
});
