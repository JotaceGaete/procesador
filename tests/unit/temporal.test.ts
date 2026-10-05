import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMemory } from "@/lib/ai/context";
import { memorySectionsFor, storyManuscriptSection, draftSection } from "@/lib/ai/inventory";
import { scenePrompt } from "@/lib/ai/prompts";
import { character, fact } from "./fixtures";
import type { Memory } from "@/lib/types";

const order = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);
const elena = character({ name: "Elena", role: "Protagonista", secrets: "Guarda las cartas de su madre.", arc: "Aprende a confiar." });
const memory: Memory = {
  characters: [elena],
  relationships: [],
  places: [],
  facts: [
    fact({ text: "Elena vive en el puerto.", character_ids: ["Elena"] }),
    fact({ text: "Elena perdió a su madre.", chapter_id: "c3", character_ids: ["Elena"], story_time: "Invierno de 1971" }),
    fact({ text: "Elena llega a la casa.", chapter_id: "c5", character_ids: ["Elena"] }),
    fact({ text: "REVELACION-20: Elena es hija de Pedro.", chapter_id: "c20", character_ids: ["Elena"] }),
  ],
};

test("writing a scene (noLaterThan): facts of later chapters are left out and counted, not sent as «later»", () => {
  const sel = selectMemory(memory, { text: "Elena", characterIds: [], chapterId: "c5", chapterOrder: order, noLaterThan: "c5" });
  assert.deepEqual(
    sel.facts.map((f) => f.text),
    ["Elena vive en el puerto.", "Elena perdió a su madre.", "Elena llega a la casa."],
    "without a chapter (known from the start), earlier, and this chapter's",
  );
  assert.equal(sel.later, 1);
  // Without it (editing, consistency checks) the later fact still goes, marked as later.
  const edit = selectMemory(memory, { text: "Elena", characterIds: [], chapterId: "c5", chapterOrder: order });
  assert.ok(edit.facts.some((f) => f.text.startsWith("REVELACION-20")));
  assert.equal(edit.later, 0);
});

test("Ver contexto: a character's file shows what goes, field by field; a fact shows its time", () => {
  const selected = selectMemory(memory, { text: "Elena", characterIds: ["Elena"], chapterId: "c5", chapterOrder: order, noLaterThan: "c5" });
  const sections = memorySectionsFor({
    selected,
    memory,
    chapters: order.map((id) => ({ id, title: "" })),
    currentChapterId: "c5",
    chosenCharacters: ["Elena"],
    chosenCharacterReason: "elegido",
    sources: [],
  });
  const detail = sections.find((s) => s.id === "characters")!.items[0].detail!;
  assert.equal(detail, "Rol: Protagonista\nSecretos: Guarda las cartas de su madre.\nArco narrativo: Aprende a confiar.");
  const facts = sections.find((s) => s.id === "facts")!.items;
  assert.match(facts.find((f) => f.label.startsWith("Elena perdió"))!.note!, /Capítulo 3 · Elena · Invierno de 1971/);
  assert.ok(!facts.some((f) => f.label.includes("REVELACION-20")));
});

test("«Leer toda la historia hasta aquí»: what the section says, and the prompt knows nothing after the mark", () => {
  assert.equal(storyManuscriptSection("Uno dos tres.", 7).items[0].label, "Los capítulos 1 a 7 y el 8 hasta el cursor · ≈3 palabras");
  assert.equal(storyManuscriptSection("Uno.", 0).items[0].label, "El capítulo 1 hasta el cursor · ≈1 palabra");
  assert.match(draftSection("Juan entró despacio.").items[0].label, /La propuesta anterior · ≈3 palabras/);
  const prompt = scenePrompt({ argument: "Sigue.", length: "media", chapter: "Capítulo 5", previousChapterTail: null, before: "", after: "", mark: "⟦X⟧" });
  assert.match(prompt, /termina con ⟦X⟧/);
  assert.match(prompt, /lo que viene después no lo conoces/);
  assert.doesNotMatch(prompt, /si hay texto después, enlaza/);
});
