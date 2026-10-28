import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANIONS, companionPrompt, pickCompanion } from "../../src/lib/companions";

test("selección: cada género va a su compañero; el elegido manda; sin género usa el primero", () => {
  assert.equal(pickCompanion("Infantil").id, "kiki");
  assert.equal(pickCompanion("Novela adulta").id, "bruno");
  assert.equal(pickCompanion("Thriller policial").id, "victor");
  assert.equal(pickCompanion("Ficción histórica").id, "nathaniel");
  assert.equal(pickCompanion("Ciencia ficción").id, "elena");
  assert.equal(pickCompanion("Romántica").id, "valentina");
  assert.equal(pickCompanion("Ensayo").id, "jorge");
  assert.equal(pickCompanion("Erótica").id, "morgana");
  assert.equal(pickCompanion(undefined).id, COMPANIONS[0].id);
  assert.equal(COMPANIONS.length, 8);
  assert.ok(COMPANIONS.every((c) => !c.style.includes("PENDIENTE")));
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

test("conversación: el pedido lleva los turnos anteriores, con quién habla cada uno", () => {
  const p = companionPrompt({
    companion: COMPANIONS[0],
    novel: { title: "x", guide: {} },
    synopsis: "",
    chapter: "x",
    history: [{ speaker: "autor", text: "¿Y si Clara miente?" }, { speaker: "compañero", text: "Eso cambia el secreto." }],
    request: "Sigue",
  });
  assert.match(p, /Conversación hasta ahora:\nAutor: ¿Y si Clara miente\?\nKiki: Eso cambia el secreto\./);
  assert.doesNotMatch(companionPrompt({ companion: COMPANIONS[0], novel: { title: "x", guide: {} }, synopsis: "", chapter: "x", request: "r" }), /Conversación hasta ahora/);
});

test("pedido: sin estilo definido, el compañero sólo lee y pregunta", () => {
  const p = companionPrompt({
    companion: { id: "nuevo", name: "Nuevo", style: "PENDIENTE: descripción de estilo del autor.", audiences: [] },
    novel: { title: "x", guide: {} },
    synopsis: "",
    chapter: "x",
    request: "Propón tramas",
  });
  assert.match(p, /Todavía no tienes un estilo definido/);
  assert.match(p, /\(sin argumento\)/);
  assert.doesNotMatch(p, /Final del capítulo anterior/);
});
