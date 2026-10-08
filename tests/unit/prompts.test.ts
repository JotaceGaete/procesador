import { test } from "node:test";
import assert from "node:assert/strict";
import { EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS, editPrompt, memoryBlock, scenePrompt } from "@/lib/ai/prompts";
import { cleanGuide, compileGuide } from "@/lib/guide";
import { character, fact } from "./fixtures";

test("editing and writing use different instructions", () => {
  assert.match(EDIT_INSTRUCTIONS, /conservador/);
  assert.doesNotMatch(EDIT_INSTRUCTIONS, /argumento es el plan de la escena y la autoridad/);
  assert.match(WRITE_INSTRUCTIONS, /argumento es el plan de la escena y la autoridad/);
  assert.match(WRITE_INSTRUCTIONS, /<escena><\/escena>/);
  for (const text of [EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS]) {
    assert.match(text, /no moralices/, "both modes keep the shared literary principles");
    assert.match(text, /prosa genérica de IA/);
  }
});

test("edit prompt: selection with context, passages and the task", () => {
  const p = editPrompt({
    action: "personaje",
    character: character({ name: "Juan" }),
    selection: "SEL",
    before: "A",
    after: "B",
    passages: "PAS",
  });
  assert.ok(p.includes("<pasajes>\nPAS\n</pasajes>"));
  assert.ok(p.includes("<antes>\nA\n</antes>\n<seleccion>\nSEL\n</seleccion>\n<despues>\nB\n</despues>"));
  assert.match(p, /\*\*Veredicto:\*\* Consistente \| Posible inconsistencia/);
  assert.match(
    editPrompt({ action: "acortar", character: null, selection: "x", before: "", after: "", passages: null }),
    /<reescritura>/,
  );
});

test("scene prompt: argument, chapter, surrounding text and length", () => {
  const p = scenePrompt({
    argument: "Juan se va.",
    length: "breve",
    chapter: "Capítulo 2",
    previousChapterTail: "FIN CAP 1",
    before: "ANTES",
    after: "DESPUES",
  });
  assert.ok(p.includes("<argumento>\nJuan se va.\n</argumento>"));
  assert.ok(p.includes("<capitulo_anterior>\nFIN CAP 1"));
  assert.ok(p.includes("<antes>\nANTES") && p.includes("<despues>\nDESPUES"));
  assert.match(p, /alrededor de 300–500 palabras/);
  assert.match(
    scenePrompt({ argument: "x", length: "libre", chapter: "C", previousChapterTail: null, before: "", after: "" }),
    /principio del capítulo/,
  );
});

test("memory block: relationships by name, and facts of later chapters flagged", () => {
  const juan = character({ name: "Juan" });
  const elena = character({ name: "Elena" });
  const memory = {
    characters: [juan, elena],
    relationships: [{ id: "r", novel_id: "n", from_id: "Elena", to_id: "Juan", kind: "desconfía de", note: "" }],
    places: [],
    facts: [fact({ text: "Ardió la bodega.", chapter_id: "c3" })],
  };
  const chapters = [
    { id: "c1", title: "" },
    { id: "c2", title: "" },
    { id: "c3", title: "El incendio" },
  ];
  const block = memoryBlock(memory, memory, chapters, "c1");
  assert.ok(block.includes("Elena → desconfía de → Juan"));
  assert.ok(block.includes("Capítulo 3: El incendio, posterior al capítulo actual"));
  assert.match(block, /todavía no han ocurrido/);
  assert.equal(memoryBlock({ characters: [], relationships: [], places: [], facts: [] }, memory, chapters, "c1"), "");
});

test("Guía Maestra: only filled fields, unknown fields dropped", () => {
  const guide = cleanGuide({ person: "Primera persona", avoid: "Metáforas marinas", tone: "  ", junk: "x" });
  assert.deepEqual(guide, { person: "Primera persona", avoid: "Metáforas marinas" });
  const compiled = compileGuide({ title: "T", guide, ...{ synopsis: "Pola ama a Eduardo en secreto.", notes: "Gerardo llegará." } } as never);
  assert.ok(compiled.includes("Persona narrativa: Primera persona") && compiled.includes("## Intención"));
  assert.ok(!compiled.includes("## Mundo"));
  // The synopsis and the notes are the author's plan: never in the guide the Asistente receives.
  assert.doesNotMatch(compiled, /Sinopsis|Eduardo|Notas del autor|Gerardo/);
  assert.match(compileGuide({ title: "T", guide: {} }), /infiere el estilo del texto/);
});

test("both modes explain the manuscript's format: italics *así*, scene breaks * * *, no other formatting", () => {
  for (const instructions of [EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS]) {
    assert.match(instructions, /\*así\*/);
    assert.match(instructions, /sólo \* \* \*/);
    assert.match(instructions, /No uses negritas/);
  }
});

test("relaciones personalizadas: in the Asistente's memory block like any other kind", async () => {
  const { memoryBlock } = await import("@/lib/ai/prompts");
  const naty = { id: "naty", name: "Naty" } as never;
  const emily = { id: "emily", name: "Emily" } as never;
  const selected = {
    characters: [naty, emily],
    relationships: [{ id: "r", novel_id: "n", from_id: "naty", to_id: "emily", kind: "Ex amante de", note: "" }],
    places: [],
    facts: [],
  };
  const block = memoryBlock(selected as never, { characters: [naty, emily], relationships: selected.relationships, places: [], facts: [] } as never, [], null);
  assert.ok(block.includes("Naty → Ex amante de → Emily"), block);
});
