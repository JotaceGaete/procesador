import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManuscript,
  estimateTokens,
  excerpts,
  manuscriptRange,
  nameMatcher,
  nearbyRange,
  relevantCharacters,
  selectMemory,
} from "@/lib/ai/context";
import { character, fact, place } from "./fixtures";
import type { Memory } from "@/lib/types";

const juan = character({ name: "Juan Ortega", aliases: "el Flaco" });
const elena = character({ name: "Elena" });
const marta = character({ name: "Marta" });
const rosa = character({ name: "Rosa" });

test("names match the full name, the first name and aliases, as whole words", () => {
  const m = nameMatcher(juan)!;
  assert.ok(m.test("y Juan se fue"));
  assert.ok(m.test("lo llamaban el flaco"));
  assert.ok(!m.test("Juanito llegó"));
  assert.ok(!nameMatcher(character({ name: "Ana" }))!.test("la mañana"), "short names never match inside words");
  assert.ok(nameMatcher(character({ name: "Ana" }))!.test("—Ana, ven."), "punctuation is a word boundary");
});

test("relevant characters: chosen first, then the ones named in the text", () => {
  const all = [juan, elena, marta, rosa];
  assert.deepEqual(
    relevantCharacters(all, [], "Juan habló con Elena").map((c) => c.name),
    ["Juan Ortega", "Elena"],
  );
  assert.deepEqual(
    relevantCharacters(all, [marta.id], "nada").map((c) => c.name),
    ["Marta"],
  );
});

test("nearby context is bounded and contains the selection", () => {
  const text = "x".repeat(20_000);
  const r = nearbyRange(text, { start: 10_000, end: 10_100 });
  assert.ok(r.start <= 10_000 && r.end >= 10_100);
  assert.ok(r.end - r.start < 7000);
});

// A ~1M-character novel in 10 chapters where Juan appears in one paragraph out of ten.
const para = (i: number) =>
  i % 10 === 0 ? `Juan miró la puerta sin decir nada, ${i}.` : `Llovía sobre la ciudad sin que nadie lo notara, otra vez, ${i}.`;
const chapters = Array.from({ length: 10 }, (_, c) => ({
  id: `c${c}`,
  title: c === 3 ? "El incendio" : `Capítulo ${c + 1}`,
  content: Array.from({ length: 1500 }, (_, i) => para(i)).join("\n\n"),
}));

test("manuscript joins chapters with headers and uses the live text of the current one", () => {
  const ms = buildManuscript(chapters, { id: "c5", content: "TEXTO VIVO" });
  assert.ok(ms.text.includes("## Capítulo 4: El incendio"), "custom titles kept");
  assert.ok(ms.text.includes("## Capítulo 5\n"), "default titles shown by position");
  assert.equal(ms.chapters[5].content, "TEXTO VIVO");
  assert.equal(ms.text.slice(ms.chapters[5].start, ms.chapters[5].end), "TEXTO VIVO");
});

test("passages: within budget, spread over the whole novel, labelled by chapter, excluding the selection", () => {
  const ms = buildManuscript(chapters, { id: "c5", content: chapters[5].content });
  const near = nearbyRange(chapters[5].content, { start: 30_000, end: 30_100 });
  const ex = excerpts(ms, juan, manuscriptRange(ms, "c5", near))!;
  assert.ok(ex.length <= 12_500, `budget exceeded: ${ex.length}`);
  assert.ok(ex.includes("[Capítulo 1]") && ex.includes("[Capítulo 10]") && ex.includes("[Capítulo 4: El incendio]"));
  assert.match(ex, /pasajes más con Juan Ortega/);
  assert.ok(estimateTokens(ex.length) < estimateTokens(ms.text.length) / 50, "passages are a small fraction of the novel");
});

const memory: Memory = {
  characters: [juan, elena, marta, rosa],
  relationships: [
    { id: "r1", novel_id: "n", from_id: elena.id, to_id: juan.id, kind: "desconfía de", note: "" },
    { id: "r2", novel_id: "n", from_id: rosa.id, to_id: marta.id, kind: "vecina de", note: "" },
  ],
  places: [place({ id: "p1", name: "Casa de Elena", aliases: "la casa" }), place({ id: "p2", name: "El puerto" })],
  facts: [
    fact({ text: "Juan perdió dos dedos.", character_ids: [juan.id] }),
    fact({ text: "Rosa vio todo desde la ventana.", character_ids: [rosa.id] }),
    fact({ text: "La casa tiene la cocina pequeña.", place_id: "p1" }),
    fact({ text: "Sugerencia sin aprobar sobre Juan.", character_ids: [juan.id], status: "suggested" }),
    fact({ text: "Marta habló con Elena.", chapter_id: "c7" }),
  ],
};

test("memory selection for a scene or a consistency check", () => {
  const sel = selectMemory(memory, {
    text: "Juan llega. Elena está en la casa.",
    characterIds: [],
    chapterId: "c5",
    chapterOrder: chapters.map((c) => c.id),
  });
  assert.deepEqual(
    sel.characters.map((c) => c.name),
    ["Juan Ortega", "Elena"],
  );
  assert.deepEqual(
    sel.relationships.map((r) => r.id),
    ["r1"],
    "only relationships between relevant characters",
  );
  assert.deepEqual(
    sel.places.map((p) => p.id),
    ["p1"],
    "places matched by alias",
  );
  const texts = sel.facts.map((f) => f.text);
  assert.ok(texts.includes("Juan perdió dos dedos."), "fact linked to a relevant character");
  assert.ok(texts.includes("La casa tiene la cocina pequeña."), "fact linked to a relevant place");
  assert.ok(texts.includes("Marta habló con Elena."), "fact naming a relevant character");
  assert.ok(!texts.some((t) => t.startsWith("Rosa")), "unrelated facts left out");
  assert.ok(!texts.some((t) => t.startsWith("Sugerencia")), "suggested (unapproved) facts never used");
});

test("memory selection focused on one character brings its relationships and the other end", () => {
  const sel = selectMemory(memory, {
    text: "Juan y Marta",
    characterIds: [elena.id],
    chapterId: "c5",
    chapterOrder: [],
    focus: true,
  });
  assert.equal(sel.characters[0].name, "Elena");
  assert.deepEqual(
    sel.relationships.map((r) => r.id),
    ["r1"],
  );
  assert.ok(sel.characters.some((c) => c.name === "Juan Ortega"));
});
