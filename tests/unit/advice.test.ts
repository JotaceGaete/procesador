import { test } from "node:test";
import assert from "node:assert/strict";
import { planQuestion } from "@/lib/advisor/planner";
import { splitAnswer, verifyObservations } from "@/lib/advisor/observations";

const ctx = {
  characters: [
    { id: "e", name: "Elena Ruiz", aliases: "la Rubia" },
    { id: "j", name: "Juan", aliases: "" },
  ],
  places: [{ id: "p", name: "Valparaíso", aliases: "el puerto" }],
  chapters: [{ title: "La llegada" }, { title: "" }, { title: "Tormenta en el puerto" }, { title: "" }],
  threads: [{ id: "t", title: "La carta de Marta" }],
};

test("planner: intent words pick the recipe; names, chapters and threads are recognised", () => {
  assert.equal(planQuestion("¿Cómo sigo desde aquí?", ctx).action, "seguir");
  assert.equal(planQuestion("¿Qué expresiones repito demasiado?", ctx).action, "repeticiones");
  assert.equal(planQuestion("¿Revelo demasiado pronto lo de la herencia?", ctx).action, "coherencia");
  assert.equal(planQuestion("¿Qué cabos dejé sin resolver?", ctx).action, "cabos");
  assert.equal(planQuestion("¿Qué personajes estoy desaprovechando?", ctx).action, "personajes");
  assert.equal(planQuestion("¿Funciona el ritmo de este capítulo?", ctx).action, "analizar");

  const p = planQuestion("¿Es coherente lo que sabe la Rubia en el capítulo 2 y el 4 sobre Valparaíso?", ctx);
  assert.equal(p.action, "coherencia");
  assert.deepEqual(p.characterIds, ["e"]);
  assert.deepEqual(p.placeIds, ["p"]);
  assert.deepEqual(p.chapterIndexes, [1, 3]);

  assert.deepEqual(planQuestion("Compara con «Tormenta en el puerto»", ctx).chapterIndexes, [2], "by title");
  assert.deepEqual(planQuestion("capítulo 9", ctx).chapterIndexes, [], "out of range");
  // Only a name: about that character. Only a thread: about threads.
  assert.equal(planQuestion("¿Y Juan?", ctx).action, "personajes");
  const t = planQuestion("¿Qué hago con la carta de Marta?", ctx);
  assert.deepEqual([t.action, t.threadIds], ["cabos", ["t"]]);
});

const CH = [
  { id: "c1", content: "Elena juró que nunca había visto el mar. Juan se rió." },
  { id: "c2", content: "Elena recordó los veranos en Cartagena, frente al mar." },
];

test("observations: quotes verified in their chapter, moved to where they really are, or marked", () => {
  const [o, moved, impression] = verifyObservations(
    [
      {
        kind: "contradiction",
        title: "El mar",
        body: "Dice que nunca vio el mar y luego recuerda veranos en la costa.",
        confidence: "high",
        refs: [
          { chapter: 1, quote: "nunca había visto el mar" },
          { chapter: 2, quote: "«los veranos en Cartagena»" },
        ],
      },
      { kind: "repetition", title: "Risa", body: "", confidence: "medium", refs: [{ chapter: 2, quote: "Juan se rió" }] },
      { kind: "weird", title: "Una impresión", body: "Algo flojo.", confidence: "high", refs: [{ chapter: 1, quote: "una frase que no está" }] },
    ],
    CH,
  );
  assert.equal(o.verified, true);
  assert.equal(o.confidence, "high");
  assert.deepEqual(
    o.refs.map((r) => [r.chapterId, r.quote, r.verified]),
    [
      ["c1", "nunca había visto el mar", true],
      ["c2", "los veranos en Cartagena", true],
    ],
  );
  assert.equal(CH[0].content.slice(o.refs[0].at!.start, o.refs[0].at!.end), "nunca había visto el mar");
  assert.deepEqual([moved.refs[0].chapterId, moved.refs[0].verified], ["c1", true], "found in chapter 1, not 2");
  assert.equal(impression.kind, "problem", "unknown kind falls back");
  assert.equal(impression.verified, false);
  assert.equal(impression.refs[0].at, null);
  assert.equal(impression.confidence, "medium", "an unverifiable quote lowers the confidence");
});

test("observations: structure errors are rejected; empty cards dropped; the answer splits at the tag", () => {
  assert.throws(() => verifyObservations({ nope: 1 }, CH));
  assert.equal(verifyObservations([{ kind: "problem" }, "x", null], CH).length, 0);
  assert.equal(verifyObservations({ items: [{ title: "A" }] }, CH).length, 1);
  const s = splitAnswer("## Lectura\nBien.\n\n<observaciones>\n[]\n</observaciones>\n");
  assert.deepEqual(s, { markdown: "## Lectura\nBien.", json: "[]" });
  assert.deepEqual(splitAnswer("Sólo texto."), { markdown: "Sólo texto.", json: null });
});
