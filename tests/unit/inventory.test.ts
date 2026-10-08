import { test } from "node:test";
import assert from "node:assert/strict";
import { guideSection, memorySectionsFor, sceneTextSections } from "../../src/lib/ai/inventory";
import { selectMemory } from "../../src/lib/ai/context";
import type { Character, Fact, Memory, Place, Relationship } from "../../src/lib/types";

const character = (id: string, name: string, extra: Partial<Character> = {}) =>
  ({ id, name, aliases: "", ...extra }) as Character;
const memory: Memory = {
  characters: [character("p", "Pilar", { role: "jueza" }), character("h", "Héctor"), character("m", "Marta")],
  relationships: [
    { id: "r1", from_id: "p", to_id: "h", kind: "teme a", note: "" },
    { id: "r2", from_id: "m", to_id: "p", kind: "odia a", note: "" },
  ] as Relationship[],
  places: [{ id: "x", name: "El puerto", aliases: "", description: "Muelle", notes: "" }] as Place[],
  facts: [
    { id: "f1", text: "Pilar perdió el juicio.", character_ids: ["p"], status: "approved", chapter_id: null, place_id: null, story_time: "", note: "" },
    { id: "f2", text: "Sugerido.", character_ids: ["p"], status: "suggested", chapter_id: null, place_id: null, story_time: "", note: "" },
  ] as Fact[],
} as Memory;

test("inventory: only what selectMemory picked, each with why", () => {
  const selected = selectMemory(memory, { text: "Pilar en El puerto", characterIds: ["h"], chapterId: "c", chapterOrder: ["c"] });
  const sections = memorySectionsFor({
    selected,
    memory,
    chapters: [{ id: "c", title: "" }],
    currentChapterId: "c",
    chosenCharacters: ["h"],
    chosenCharacterReason: "elegido",
    sources: [{ reason: "en el argumento", text: "Pilar en El puerto" }],
  });
  assert.deepEqual(sections.map((s) => s.id), ["characters", "places", "relationships", "facts"]);
  assert.deepEqual(sections[0].items.map((i) => [i.label, i.reason]), [["Héctor", "elegido"], ["Pilar", "en el argumento"]]);
  assert.deepEqual(sections[2].items.map((i) => i.label), ["Pilar → teme a → Héctor"]);
  assert.deepEqual(sections[3].items.map((i) => i.label), ["Pilar perdió el juicio."]);
  assert.ok(sections.every((s) => s.tokens > 0));
});

test("inventory: nothing selected → no memory sections at all", () => {
  const selected = selectMemory(memory, { text: "nadie", characterIds: [], chapterId: "c", chapterOrder: ["c"] });
  assert.deepEqual(
    memorySectionsFor({ selected, memory, chapters: [], currentChapterId: "c", chosenCharacters: [], chosenCharacterReason: "", sources: [] }),
    [],
  );
});

test("inventory: guide lists the parts that are filled; an empty guide says so", () => {
  // The Asistente's guide: the style only; the synopsis and notes never go (they are the plan).
  const full = guideSection({ guide: { genre: "Drama" } }, "x".repeat(35));
  assert.deepEqual(full.items.map((i) => i.label), ["Mundo"]);
  assert.equal(full.tokens, 10);
  const empty = guideSection({ guide: {} }, "x");
  assert.match(empty.label, /sólo el título/);
  assert.match(empty.items[0].label, /Sin guía de estilo/);
});

test("inventory: scene text says before/after and the previous chapter only when sent", () => {
  const a = sceneTextSections({ chapterIndex: 0, chapterTitle: "", before: "", after: "", previousChapterTail: null, previousIndex: -1, previousTitle: "", argument: "Arg" });
  assert.deepEqual(a.text.map((s) => s.id), ["chapter"]);
  assert.equal(a.text[0].items[0].label, "La escena va al principio del capítulo");
  const b = sceneTextSections({ chapterIndex: 1, chapterTitle: "Dos", before: "uno dos tres", after: "cuatro", previousChapterTail: "fin", previousIndex: 0, previousTitle: "", argument: "Arg" });
  assert.deepEqual(b.text.map((s) => s.id), ["chapter", "previous"]);
  assert.deepEqual(b.text[0].items.map((i) => i.label), ["≈3 palabras antes del cursor", "≈1 palabra después del cursor"]);
  assert.equal(b.text[1].items[0].label, "Capítulo 1: últimas ≈1 palabra");
});
