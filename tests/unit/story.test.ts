import { test } from "node:test";
import assert from "node:assert/strict";
import { storySoFar, STORY_TOKENS, type StoryInput } from "../../src/lib/ai/story";
import type { Character, ChapterDigest, StoryThread } from "../../src/lib/types";

const pilar = { id: "p", name: "Pilar", aliases: "" } as Character;
const hector = { id: "h", name: "Héctor", aliases: "" } as Character;
const names = new Map([["p", "Pilar"], ["h", "Héctor"], ["m", "Marta"]]);

const chapters = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i}`,
  title: "",
  content: `Texto del capítulo ${i + 1}. Pilar camina. ANCLA-${i} y algo más.`,
  revision: 1,
}));
const CURRENT = "Inicio del cuarto. ABRE-ANTES aquí. Luego sigue. ABRE-DESPUES al final.";
const CURSOR = CURRENT.indexOf("Luego");

function digest(i: number, extra: Partial<ChapterDigest> = {}): ChapterDigest {
  return {
    chapter_id: `c${i}`,
    novel_id: "n",
    source_revision: 1,
    text_sketch: { n: 0, h: [] },
    summary: `Resumen ${i + 1}. Segunda frase del ${i + 1}.`,
    events: [{ text: `Suceso ${i + 1}`, characters: ["p"], quote: `ANCLA-${i}` }],
    presence: [{ character: "m", kind: "present" }],
    revelations: [],
    threads: [],
    notes: "",
    author_edited: false,
    model: "",
    updated_at: "",
    ...extra,
  };
}
const thread = (id: string, extra: Partial<StoryThread>): StoryThread => ({
  id,
  novel_id: "n",
  title: `Hilo ${id}`,
  description: "",
  kind: "mystery",
  status: "open",
  status_by: "advisor",
  origin: "advisor",
  confirmed: true,
  opened_chapter_id: "c0",
  last_chapter_id: null,
  closed_chapter_id: null,
  ...extra,
});

function input(extra: Partial<StoryInput> = {}): StoryInput {
  return {
    chapters,
    currentIndex: 3,
    liveContent: CURRENT,
    cursor: CURSOR,
    digests: [
      digest(0, { revelations: [{ text: "El testigo mintió", to: "p", quote: "" }] }),
      digest(2, { revelations: [{ text: "Marta tiene la carta", to: "p", quote: "" }], threads: [{ thread: "t1", change: "advanced", quote: "" }] }),
      digest(3, {
        summary: "FUTURO-DEL-ACTUAL",
        threads: [
          { thread: "t6", change: "opened", quote: "ABRE-ANTES" },
          { thread: "t7", change: "opened", quote: "ABRE-DESPUES" },
        ],
      }),
      digest(4, { summary: "FUTURO-CINCO", revelations: [{ text: "FUTURO-REVELACION", to: "p", quote: "" }] }),
    ],
    threads: [
      thread("t1", { status: "closed", closed_chapter_id: "c4" }),
      thread("t2", { status: "closed", closed_chapter_id: "c1" }),
      thread("t3", { opened_chapter_id: "c5" }),
      thread("t4", { confirmed: false }),
      thread("t5", { status: "abandoned" }),
      thread("t6", { opened_chapter_id: "c3" }),
      thread("t7", { opened_chapter_id: "c3" }),
      thread("t8", { origin: "author", confirmed: false, opened_chapter_id: null }),
    ],
    global: { novel_id: "n", summary: "RESUMEN-GLOBAL", based_on: {}, model: "", updated_at: "" },
    globalCurrent: true,
    atEnd: false,
    characters: [pilar, hector],
    names,
    includeManuscript: false,
    ...extra,
  };
}

test("story: only previous chapters, never the current one nor later ones", () => {
  const out = storySoFar(input());
  const all = [out.story, out.knowledge, out.threads].join("\n");
  for (const future of ["FUTURO-DEL-ACTUAL", "FUTURO-CINCO", "FUTURO-REVELACION", "RESUMEN-GLOBAL"]) assert.ok(!all.includes(future), future);
  assert.match(out.story!, /<ficha capitulo="Capítulo 1">/);
  assert.match(out.story!, /<ficha capitulo="Capítulo 3">/);
  assert.ok(!out.story!.includes("ANCLA"), "no quotes for the writer");
  assert.deepEqual(out.sections.story!.items.map((i) => [i.label, i.reason]), [["Capítulo 1", "una línea"], ["Capítulo 3", "en detalle"]]);
  assert.equal(out.sections.story!.label, "Lo ocurrido antes: 2 capítulos");
  assert.ok(out.notices.includes("El capítulo 2 no tiene ficha de lectura: la IA no sabe qué pasó en él. Puedes leerlo en Consejero → Lectura."));
});

test("story: a chapter where someone of the scene is present gets its summary, not one line", () => {
  const out = storySoFar(input({ characters: [pilar, { id: "m", name: "Marta", aliases: "" } as Character] }));
  assert.deepEqual(out.sections.story!.items.map((i) => i.reason), ["resumen", "en detalle"]);
  assert.match(out.story!, /Resumen 1\. Segunda frase del 1\./);
});

test("story: what the people of the scene know, up to here", () => {
  const out = storySoFar(input());
  assert.equal(out.knowledge, "- Pilar: El testigo mintió (Capítulo 1)\n- Pilar: Marta tiene la carta (Capítulo 3)");
  assert.equal(out.sections.knowledge!.label, "Lo que saben: Pilar (2)");
});

test("story: threads open at this point", () => {
  const out = storySoFar(input());
  const titles = out.sections.threads!.items.map((i) => i.label);
  // t1 closes later (still open here); t6 opens before the cursor; t8 is the author's.
  assert.deepEqual(titles.sort(), ["Hilo t1", "Hilo t6", "Hilo t8"]);
  assert.ok(!out.threads!.includes("se cierra"), "never says it closes later");
  assert.match(out.threads!, /«Hilo t1» · Misterio · se abre en Capítulo 1, última vez en Capítulo 3/);
  assert.ok(out.notices.some((n) => n.startsWith("1 hilo posible, sin confirmar, no se envía")));
});

test("story: the global summary only when nothing comes after", () => {
  assert.ok(!storySoFar(input()).story!.includes("RESUMEN-GLOBAL"));
  const end = storySoFar(input({ atEnd: true }));
  assert.match(end.story!, /<resumen_novela>\nRESUMEN-GLOBAL/);
  assert.equal(end.sections.story!.items[0].label, "Resumen de la novela");
  const stale = storySoFar(input({ atEnd: true, globalCurrent: false }));
  assert.match(stale.story!, /<resumen_novela version="anterior">/);
});

test("story: with the whole novel, no digests; knowledge and threads stay", () => {
  const out = storySoFar(input({ includeManuscript: true }));
  assert.equal(out.story, null);
  assert.equal(out.sections.story, null);
  assert.ok(out.knowledge && out.threads);
  assert.ok(!out.notices.some((n) => n.includes("ficha de lectura")));
});

test("story: a stale digest is marked", () => {
  const changed = chapters.map((c, i) => (i === 2 ? { ...c, revision: 5, content: "Otro texto completamente distinto, reescrito de cabo a rabo por el autor." } : c));
  const out = storySoFar(input({ chapters: changed }));
  assert.match(out.story!, /<ficha capitulo="Capítulo 3" version="anterior">/);
  assert.equal(out.sections.story!.items.find((i) => i.label === "Capítulo 3")!.note, "ficha desactualizada");
});

test("story: a long novel stays within budget, keeping the closest chapters in detail", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, title: "", content: "x", revision: 1 }));
  // Long first sentences: even one line per chapter does not fit.
  const long = (i: number) => digest(i, { summary: `${"palabra ".repeat(60)}${i}. Más.` });
  const out = storySoFar(input({ chapters: many, currentIndex: 59, digests: many.slice(0, 59).map((_, i) => long(i)), threads: [] }));
  assert.ok(out.sections.story!.tokens <= STORY_TOKENS);
  const reasons = out.sections.story!.items.filter((i) => i.reason).map((i) => [i.label, i.reason]);
  assert.deepEqual(reasons.slice(-2), [["Capítulo 58", "en detalle"], ["Capítulo 59", "en detalle"]]);
  assert.match(out.sections.story!.items.at(-1)!.label, /capítulos antiguos no caben/);
});

test("story: first chapter → nothing before, no notices", () => {
  const out = storySoFar(input({ currentIndex: 0, threads: [] }));
  assert.equal(out.story, null);
  assert.equal(out.knowledge, null);
  assert.deepEqual(out.notices, []);
});
