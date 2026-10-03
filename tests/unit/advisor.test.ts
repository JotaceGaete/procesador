import { test } from "node:test";
import assert from "node:assert/strict";
import { echoes, novelMap, phraseRepetitions, presence } from "@/lib/advisor/stats";

const IMG = "[[imagen:11111111-2222-4333-8444-555555555555]]";
const chapters = [
  { id: "c1", title: "Uno", content: "Elena abrió la puerta del taller. Juan la miraba desde la ventana." },
  { id: "c2", title: "Dos", content: `Juan cruzó el puente.\n\n${IMG}\n\nNadie lo siguió.` },
  { id: "c3", title: "Tres", content: "Elena abrió la puerta del taller otra vez. Llovía." },
];
const people = [
  { id: "e", name: "Elena Ruiz", aliases: "" },
  { id: "j", name: "Juan", aliases: "el Viejo" },
  { id: "m", name: "Marta", aliases: "" },
];

test("presence: mentions per chapter, first and last, and the gap measured from the current chapter", () => {
  const [elena, juan, marta] = presence(chapters, people, 1);
  assert.deepEqual(elena.counts, [1, 0, 1]);
  assert.equal(elena.first, 0);
  assert.equal(elena.last, 2);
  // From chapter 2 (index 1), Elena was last seen in chapter 1: one chapter ago.
  assert.equal(elena.chaptersSince, 1);
  assert.ok(elena.wordsSince! > 10);
  assert.deepEqual(juan.counts, [1, 1, 0]);
  assert.equal(juan.chaptersSince, 0);
  // "Juan cruzó el puente. Nadie lo siguió." — the image marker doesn't count as words.
  assert.equal(juan.wordsSince, 7);
  assert.equal(marta.total, 0);
  assert.equal(marta.chaptersSince, null);
});

test("phrase repetitions: across chapters, with offsets that point at the real text", () => {
  const reps = phraseRepetitions(chapters);
  const door = reps.find((r) => r.text.toLowerCase().includes("abrió la puerta"))!;
  assert.ok(door, JSON.stringify(reps.map((r) => r.text)));
  assert.equal(door.text, "Elena abrió la puerta del taller");
  assert.deepEqual(door.occurrences.map((o) => o.chapterId), ["c1", "c3"]);
  for (const o of door.occurrences) {
    const c = chapters.find((x) => x.id === o.chapterId)!;
    assert.equal(c.content.slice(o.start, o.end), "Elena abrió la puerta del taller");
    assert.match(o.snippet, /taller/);
  }
  // Shorter phrases inside it ("abrió la puerta", "la puerta del taller") are not listed again.
  assert.equal(reps.filter((r) => r.occurrences.length === 2 && /puerta/.test(r.text)).length, 1);
  // Never across a sentence boundary, never function words only.
  assert.ok(!reps.some((r) => /\./.test(r.text)));
});

test("echoes: the same content word close by; names and function words are not echoes", () => {
  const chapter = {
    id: "x",
    title: "",
    content:
      "La lámpara temblaba sobre la mesa. Elena miró la lámpara sin decir nada. Elena volvió a mirar.\n\n" +
      "lejos ".repeat(60) +
      "Al final quedó la lámpara apagada.",
  };
  const found = echoes(chapter, people);
  const lamp = found.find((r) => r.text === "lámpara")!;
  assert.ok(lamp);
  // Only the two close ones; the third, 60 words later, is not an echo of them.
  assert.equal(lamp.occurrences.length, 2);
  assert.equal(chapter.content.slice(lamp.occurrences[0].start, lamp.occurrences[0].end), "lámpara");
  assert.ok(!found.some((r) => r.text === "Elena"));
  assert.ok(!found.some((r) => r.text === "la"));
});

test("novel map: words without image markers, who and where per chapter", () => {
  const p = presence(chapters, people, 2);
  const map = novelMap(chapters, p, []);
  assert.deepEqual(map.map((c) => c.characters), [["e", "j"], ["j"], ["e"]]);
  assert.equal(map[1].words, 7);
});

test("a long repeated phrase is reported once, whole; a shorter one only when it also appears elsewhere", () => {
  const long = "Juan Ortega cruzó despacio el patio de la casa vieja";
  const reps = phraseRepetitions([
    { id: "a", title: "", content: `${long}. Después llovió.` },
    { id: "b", title: "", content: `Pasaron años. ${long}. El patio de la casa seguía igual.` },
  ]);
  const whole = reps.filter((r) => r.text.includes("Ortega"));
  assert.equal(whole.length, 1, JSON.stringify(reps.map((r) => r.text)));
  assert.equal(whole[0].text, long);
  assert.equal(whole[0].occurrences.length, 2);
  // "patio de la casa" appears a third time, outside the long phrase: listed with all three.
  const patio = reps.find((r) => r.text === "patio de la casa")!;
  assert.ok(patio, JSON.stringify(reps.map((r) => r.text)));
  assert.equal(patio.occurrences.length, 3);
});
