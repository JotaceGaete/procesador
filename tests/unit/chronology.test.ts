import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageAt,
  ageOf,
  birthRange,
  chronology,
  dateRange,
  describeAge,
  formatAge,
  formatPoint,
  parseAgeAnchor,
  parseStoryDate,
  parseWhen,
  timeline,
  type CharacterTime,
  type TimeMark,
} from "@/lib/chronology";

const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
const chapters = ids.map((id) => ({ id, title: "" }));
const mark = (chapter_id: string, when: TimeMark["when"], flashback = false): TimeMark => ({ chapter_id, when, flashback, label: "" });
const person = (p: Partial<CharacterTime> & { name: string }): CharacterTime => ({
  id: p.name,
  aliases: "",
  age_anchor: null,
  age_approx: false,
  death: null,
  ...p,
});
const age = (c: CharacterTime, marks: TimeMark[], i: number) => {
  const pts = timeline(ids, marks);
  return ageOf(c, pts[i], ids, pts) ?? ageAt(birthRange(c, ids, pts), pts[i], c.age_approx);
};

test("the case of the design: 21 in chapter 1 (1972), chapter 6 in 1977 → 26, the anchor unchanged", () => {
  const elena = person({ name: "Elena", age_anchor: { kind: "age_at", age: 21, at: { chapter_id: "c1" } } });
  const real = [mark("c1", { date: { year: 1972 } }), mark("c6", { date: { year: 1977 } })];
  // Read as the author wrote it: 1977 is five years after 1972.
  assert.deepEqual(age(elena, real, 5), { min: 26, max: 26, approx: false });
  // Five and a half years later: 26 or 27, depending on the birthday.
  assert.deepEqual(age(elena, [mark("c1", { date: { year: 1972, month: 1 } }), mark("c6", { date: { year: 1977, month: 7 } })], 5), { min: 26, max: 27, approx: false });
  // Different precision: the honest range of the dates.
  assert.deepEqual(age(elena, [mark("c1", { date: { year: 1972 } }), mark("c6", { date: { year: 1977, month: 3 } })], 5), { min: 25, max: 27, approx: false });
  // Going back: two years earlier, 19.
  assert.deepEqual(age(elena, [mark("c1", { date: { year: 1972 } }), mark("c2", { date: { year: 1970 } })], 1), { min: 19, max: 19, approx: false });
  const sameDay = [mark("c1", { date: { year: 1972, month: 3, day: 1 } }), mark("c6", { date: { year: 1977, month: 3, day: 1 } })];
  assert.deepEqual(age(elena, sameDay, 5), { min: 26, max: 26, approx: false });
  // Relative calendar: Año 0 and Año 5. And "cinco años después" without any year.
  assert.deepEqual(age(elena, [mark("c1", { date: { year: 0, month: 6, day: 1 } }), mark("c6", { date: { year: 5, month: 6, day: 1 } })], 5), { min: 26, max: 26, approx: false });
  assert.deepEqual(age(elena, [mark("c6", { after: { years: 5 } })], 5), { min: 26, max: 26, approx: false });
  // Inherited chapters keep the previous time.
  assert.deepEqual(age(elena, [mark("c6", { after: { years: 5 } })], 3), { min: 21, max: 21, approx: false });
});

test("birth anchors: a partial birth date is a range; frames never mix", () => {
  const b = person({ name: "B", age_anchor: { kind: "birth", date: { year: 1951 } } });
  assert.deepEqual(age(b, [mark("c1", { date: { year: 1972 } })], 0), { min: 20, max: 21, approx: false });
  assert.deepEqual(age(b, [mark("c1", { date: { year: 1972, month: 6 } })], 0), { min: 20, max: 21, approx: false });
  const exact = person({ name: "E", age_anchor: { kind: "birth", date: { year: 1951, month: 3, day: 12 } } });
  assert.deepEqual(age(exact, [mark("c1", { date: { year: 1972, month: 6 } })], 0), { min: 21, max: 21, approx: false });
  // A birth year can't be compared with a story that has no dates: unknown, not invented.
  assert.equal(age(b, [mark("c2", { after: { years: 3 } })], 1), null);
  assert.equal(formatAge({ min: 20, max: 21, approx: false }), "20–21 años");
  assert.equal(formatAge({ min: 39, max: 41, approx: true }), "≈ 40 años");
});

test("points are said as precisely as they are known", () => {
  const pts = timeline(ids, [mark("c1", { date: { year: 1972, month: 3, day: 12 } }), mark("c2", { date: { year: 1972, month: 3 } }), mark("c3", { date: { year: 1972 } }), mark("c4", { after: { months: 2 } })]);
  assert.deepEqual(pts.map((p) => formatPoint(p, "real")).slice(0, 4), ["12 de marzo de 1972", "marzo de 1972", "1972", "1972–1973"]);
  assert.equal(formatPoint(pts[4], "real"), "1972–1973");
  assert.ok(pts[4].estimated && !pts[3].estimated);
  assert.equal(formatPoint(timeline(["a"], [mark("a", { date: { year: 5, month: 6 } })])[0], "relative"), "Año 5, junio");
  assert.equal(formatPoint(timeline(["a", "b"], [mark("b", { after: { years: 5 } })])[1], "real"), "Inicio + 5 años");
  assert.equal(formatPoint(timeline(["a"], [])[0], "real"), "Inicio de la historia");
});

test("warnings: never errors that block, each with what it refers to", () => {
  const text = (i: number) => (i === 1 ? "Pedro llega." : i === 4 ? "Juan habla con Pedro." : "Nadie.");
  const input = {
    calendar: "real" as const,
    chapters: ids.map((id, i) => ({ id, title: "", content: text(i) })),
    marks: [mark("c1", { date: { year: 1955 } }), mark("c3", { date: { year: 1990 } }), mark("c4", { date: { year: 1985 } }), mark("c5", { date: { year: 1984 } }, true)],
    characters: [
      person({ name: "Pedro", age_anchor: { kind: "birth", date: { year: 1960 } } }),
      person({ name: "Juan", age_anchor: { kind: "birth", date: { year: 1958 } }, death: { year: 1980 } }),
    ],
    relationships: [{ from_id: "Juan", to_id: "Pedro", kind: "padre de" }],
  };
  const w = chronology(input).warnings;
  assert.deepEqual(w.map((x) => x.key).sort(), ["parent:Juan:Pedro", "regress:c4", "unborn:Pedro"]);
  assert.ok(w.some((x) => x.key === "unborn:Pedro" && x.level === "error" && /Pedro aparece en «Capítulo 2», antes de nacer/.test(x.message)));
  assert.ok(w.some((x) => x.key === "regress:c4" && x.level === "review"), "c4 goes back without saying so");
  assert.ok(!w.some((x) => x.key === "regress:c5"), "a flashback is not warned");
  assert.ok(w.some((x) => x.key === "parent:Juan:Pedro" && /Juan tendría como mucho 2 años al nacer Pedro/.test(x.message)));
  // Juan dies in 1980 and talks in chapter 5 (1984, a flashback): no warning; in a normal chapter, yes.
  assert.ok(!w.some((x) => x.key === "dead:Juan"));
  const w2 = chronology({ ...input, marks: input.marks.map((m) => ({ ...m, flashback: false })) }).warnings;
  assert.ok(w2.some((x) => x.key === "dead:Juan" && /Juan muere en 1980 pero aparece en «Capítulo 5»/.test(x.message)));
  // Approximate ages give a year of slack.
  const approx = chronology({ ...input, characters: [person({ name: "Pedro", age_anchor: { kind: "birth", date: { year: 1955, month: 6 } }, age_approx: true })] });
  assert.ok(!approx.warnings.some((x) => x.key.startsWith("unborn")));
});

test("validation: partial dates, intervals and anchors, with clear messages", () => {
  assert.deepEqual(parseStoryDate({ year: 1972, month: 2, day: 29 }), { year: 1972, month: 2, day: 29 });
  assert.throws(() => parseStoryDate({ year: 1971, month: 2, day: 29 }), /Día inválido/);
  assert.throws(() => parseStoryDate({ month: 3 }), /falta el año/);
  assert.throws(() => parseStoryDate({ year: 1972, day: 3 }), /necesita su mes/);
  assert.deepEqual(parseWhen({ after: { years: 5, months: 0 } }), { after: { years: 5 } });
  assert.throws(() => parseWhen({ after: {} }), /cuánto tiempo/);
  assert.deepEqual(parseAgeAnchor({ kind: "age_at", age: 21, at: { chapter_id: "c1" } }), { kind: "age_at", age: 21, at: { chapter_id: "c1" } });
  assert.equal(parseAgeAnchor(null), null);
  assert.throws(() => parseAgeAnchor({ kind: "x" }), /desconocido/);
  assert.deepEqual(dateRange({ year: 0 }).max - dateRange({ year: 0 }).min, 365, "year 0 is a leap year: 366 days");
});

test("describeAge: what the AI and the file say", () => {
  const elena = person({ name: "Elena", age_anchor: { kind: "age_at", age: 21, at: { chapter_id: "c1" } } });
  assert.equal(describeAge(elena, { min: 26, max: 26, approx: false }, chapters, "real"), "26 años (21 en el capítulo 1)");
  const b = person({ name: "B", age_anchor: { kind: "birth", date: { year: 1951 } } });
  assert.equal(describeAge(b, { min: 20, max: 21, approx: false }, chapters, "real"), "20–21 años (nació en 1951)");
  assert.equal(describeAge(b, null, chapters, "real"), null);
});
