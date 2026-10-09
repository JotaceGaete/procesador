// Capítulos en reserva (docs/capitulos-reserva.md): the pure pieces of the isolation and of
// the numbering. The database functions are in tests/schema/run.mjs; every AI route, end to
// end, in tests/e2e/reserva.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inScope, scopeMemory } from "@/lib/supabase";
import { buildManuscript, chapterLabel, selectMemory } from "@/lib/ai/context";
import { chapterHeading } from "@/lib/presentation";
import { bookModel, type ExportSource } from "@/lib/export/model";
import { backupTexts, type BackupData } from "@/lib/backup";
import { storyManuscriptSection } from "@/lib/ai/inventory";
import type { Character, Fact, Memory } from "@/lib/types";
import { SOURCE } from "./export-sample";

const M1 = { id: "m1", title: "", reserved: false };
const M2 = { id: "m2", title: "La manta", reserved: false };
const R1 = { id: "r1", title: "La boda", reserved: true };
const R2 = { id: "r2", title: "", reserved: true };
// As novel_outline returns them: the manuscript in order, then the reserve.
const OUTLINE = [M1, M2, R1, R2];

test("scope: without an open chapter, only the manuscript", () => {
  assert.deepEqual(inScope(OUTLINE).map((c) => c.id), ["m1", "m2"]);
  assert.deepEqual(inScope(OUTLINE, null).map((c) => c.id), ["m1", "m2"]);
});

test("scope: a manuscript chapter open adds nothing", () => {
  assert.deepEqual(inScope(OUTLINE, "m2").map((c) => c.id), ["m1", "m2"]);
});

test("scope: a chapter in reserve open goes after the manuscript, and no other chapter in reserve", () => {
  assert.deepEqual(inScope(OUTLINE, "r2").map((c) => c.id), ["m1", "m2", "r2"]);
  assert.deepEqual(inScope(OUTLINE, "r1").map((c) => c.id), ["m1", "m2", "r1"]);
  // Even if the rows come in another order (by position across groups).
  assert.deepEqual(inScope([R1, M2, R2, M1], "r1").map((c) => c.id), ["m2", "m1", "r1"]);
  // An id that isn't a chapter in reserve adds nothing.
  assert.deepEqual(inScope(OUTLINE, "x").map((c) => c.id), ["m1", "m2"]);
});

const character = (id: string, anchorChapter: string | null): Character =>
  ({
    id,
    name: id,
    aliases: "",
    age_anchor: anchorChapter ? { kind: "age_at", age: 30, at: { chapter_id: anchorChapter } } : { kind: "birth", date: { year: 1950 } },
  }) as unknown as Character;
const fact = (id: string, chapter: string | null): Fact =>
  ({ id, text: `Elena: hecho ${id}`, chapter_id: chapter, place_id: null, story_time: "", note: "", status: "approved", character_ids: [] }) as unknown as Fact;
const MEMORY: Memory = {
  characters: [character("Elena", "r1"), character("Juan", "m1"), character("Marta", null)],
  relationships: [],
  places: [],
  facts: [fact("libre", null), fact("del-1", "m1"), fact("de-reserva", "r1"), fact("de-otra-reserva", "r2")],
};

test("memory: facts tied to a chapter out of scope never travel; the rest stays", () => {
  const main = scopeMemory(MEMORY, new Set(["m1", "m2"]));
  assert.deepEqual(main.facts.map((f) => f.id), ["libre", "del-1"]);
  const open = scopeMemory(MEMORY, new Set(["m1", "m2", "r1"]));
  assert.deepEqual(open.facts.map((f) => f.id), ["libre", "del-1", "de-reserva"]);
  // The Memoria itself is not touched.
  assert.equal(MEMORY.facts.length, 4);
});

test("memory: an age anchored in a chapter out of scope is not sent; others stay", () => {
  const main = scopeMemory(MEMORY, new Set(["m1", "m2"]));
  assert.equal(main.characters.find((c) => c.id === "Elena")!.age_anchor, null);
  assert.deepEqual(main.characters.find((c) => c.id === "Juan")!.age_anchor, MEMORY.characters[1].age_anchor);
  assert.deepEqual(main.characters.find((c) => c.id === "Marta")!.age_anchor, MEMORY.characters[2].age_anchor);
  assert.ok(MEMORY.characters[0].age_anchor, "the author's Memoria keeps it");
});

test("memory: before the scope, a fact of an unknown chapter was sent (the leak this closes)", () => {
  // selectMemory treats a chapter it doesn't know as "not later": it would send the fact.
  const all = selectMemory(MEMORY, { text: "Elena", characterIds: [], chapterId: "m2", chapterOrder: ["m1", "m2"], noLaterThan: "m2" });
  assert.ok(all.facts.some((f) => f.id === "de-reserva"));
  const scoped = selectMemory(scopeMemory(MEMORY, new Set(["m1", "m2"])), {
    text: "Elena",
    characterIds: [],
    chapterId: "m2",
    chapterOrder: ["m1", "m2"],
    noLaterThan: "m2",
  });
  assert.ok(!scoped.facts.some((f) => f.id.includes("reserva")));
});

test("numbering: the number is the place in the manuscript, never the title", () => {
  assert.equal(chapterLabel(0, ""), "Capítulo 1");
  assert.equal(chapterLabel(1, "La manta"), "Capítulo 2: La manta");
  // A stored default title doesn't fight with the real place.
  assert.equal(chapterLabel(4, "Capítulo 2"), "Capítulo 5");
  assert.equal(chapterLabel(2, "La boda", true), "Capítulo en reserva: La boda");
  assert.equal(chapterLabel(7, "", true), "Capítulo en reserva (sin título)");
  assert.deepEqual(chapterHeading(2, "La boda", true), { number: "En reserva", title: "La boda" });
  assert.deepEqual(chapterHeading(2, "La boda"), { number: "Capítulo 3", title: "La boda" });
});

test("manuscript for the model: the open chapter in reserve is labelled as such, unnumbered", () => {
  const ms = buildManuscript(
    [
      { id: "m1", title: "", content: "Uno." },
      { id: "r1", title: "La boda", content: "Texto de la boda.", reserved: true },
    ],
    { id: "r1", content: "Texto vivo de la boda." },
  );
  assert.match(ms.text, /## Capítulo 1\n\nUno\./);
  assert.match(ms.text, /## Capítulo en reserva: La boda\n\nTexto vivo de la boda\./);
  assert.doesNotMatch(ms.text, /Capítulo 2/);
  assert.match(storyManuscriptSection(ms.text, 1, true).items[0].label, /manuscrito \(1 capítulo\) y este capítulo en reserva/);
});

const WITH_RESERVE: ExportSource = {
  ...SOURCE,
  chapters: [
    SOURCE.chapters[0],
    { id: "r1", title: "La boda", content: "RESERVA-NO-EXPORTAR\n\n[[imagen:aaaaaaaa-0000-4000-8000-00000000000a]]", reserved: true },
    SOURCE.chapters[1],
  ],
  images: {
    ...SOURCE.images,
    manuscript: [
      ...SOURCE.images.manuscript,
      { ...SOURCE.images.manuscript[0], id: "aaaaaaaa-0000-4000-8000-00000000000a", chapter_id: "r1" },
    ],
  },
};

test("export: chapters in reserve are not part of the book, and the numbering skips them", () => {
  const m = bookModel(WITH_RESERVE);
  assert.equal(m.chapters.length, 2);
  assert.deepEqual(
    m.chapters.map((c) => c.number),
    ["Capítulo 1", "Capítulo 2"],
  );
  assert.ok(!JSON.stringify(m.chapters).includes("RESERVA-NO-EXPORTAR"));
  assert.equal(m.words, bookModel(SOURCE).words, "the words are the book's");
  // Its image is neither exported nor reported as "unplaced"; the author is told why.
  assert.ok(m.checks.some((c) => c.message === "1 capítulo en reserva no se exporta (ni su imagen)."));
  assert.ok(!m.checks.some((c) => /sin colocar/.test(c.message)));
  assert.deepEqual(m.files.map((f) => f.id).sort(), bookModel(SOURCE).files.map((f) => f.id).sort());
});

test("backup: keeps everything, the reserve marked and after the manuscript", () => {
  const data = {
    format: "procesador-backup",
    version: 1,
    exported_at: "2026-10-09T12:00:00Z",
    novel: { id: "n", title: "La casa", synopsis: "", notes: "", plot: "", guide: {}, book: {} },
    chapters: [
      { id: "m1", title: "", content: "Uno.", reserved: false },
      { id: "r1", title: "La boda", content: "Texto de la boda.", reserved: true },
    ],
    images: { manuscript: [], characters: [], files: [] },
  } as unknown as BackupData;
  const files = backupTexts(data);
  const novel = files.find((f) => f.name === "novela.md")!.text;
  assert.match(novel, /## Capítulo 1\n\nUno\.\n\n## Capítulo en reserva: La boda\n\nTexto de la boda\./);
  assert.ok(files.some((f) => f.name.startsWith("capitulos/2 Capítulo en reserva") && f.text === "Texto de la boda."));
  assert.match(files.find((f) => f.name === "procesador.json")!.text, /"reserved": true/);
});
