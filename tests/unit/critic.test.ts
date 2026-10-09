// Crítico Literario (docs/critico.md): the validation of its report, its instructions and its
// model. Deterministic: what the server accepts and stores, not the quality of a real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CritiqueError, parseCritique, readScore } from "@/lib/critic/schema";
import { CRITIC_INSTRUCTIONS, criticPrompt } from "@/lib/critic/prompts";
import { CRITERIA, formatScore } from "@/lib/critic/criteria";
import { modelFor } from "@/lib/ai/models";

const CH1 = "Elena conocía el puerto desde niña. Su padre la llevaba los domingos a ver los barcos.";
const CH2 =
  "Elena bajó al puerto por primera vez en su vida. El viento olía a sal y a gasoil. Nadie la esperaba en el muelle. «¿Te perdiste?», le preguntó un estibador.";

/** A valid answer, as a model would write it; `patch` changes parts of it. */
function answer(patch: Record<string, unknown> = {}) {
  return {
    chapter_kind: "Capítulo íntimo y lento",
    experience: {
      stretches: [
        { effect: "decae", note: "El final se apaga.", quote: "Nadie la esperaba en el muelle" },
        { effect: "engancha", note: "El comienzo.", quote: "Elena bajó al puerto por primera vez" },
      ],
      effects: ["emociona"],
      summary: "Emociona en el comienzo y pierde interés en el muelle.",
    },
    scores: CRITERIA.map((c) => ({ criterion: c.key, score: "7,5", rationale: "Bien.", quotes: ["El viento olía a sal"] })),
    overall_score: 7.46,
    strengths: [{ text: "El olfato", quote: "El viento olía a sal y a gasoil" }],
    weaknesses: [{ text: "El final", quote: "Nadie la esperaba en el muelle" }],
    contradictions: [],
    verdict: "solido",
    verdict_text: "Sólido.",
    ...patch,
  };
}
const opts = (strict = true) => ({ text: CH2, manuscript: [CH1, CH2], strict });

test("scores: 1 to 10 with one decimal, as a number or «7,5»; anything else is refused", () => {
  assert.equal(readScore(7.46), 7.5);
  assert.equal(readScore("7,5"), 7.5);
  assert.equal(readScore("10"), 10);
  assert.equal(readScore(1), 1);
  for (const bad of [0, 0.9, 10.1, "siete", null, undefined, NaN]) assert.ok(Number.isNaN(readScore(bad)), String(bad));
  assert.equal(formatScore(7.5), "7,5");
  assert.equal(formatScore(8), "8,0");
  assert.equal(formatScore(null), "no aplica");

  const r = parseCritique(answer(), opts());
  assert.equal(r.overall_score, 7.5);
  assert.ok(r.scores.every((s) => s.score === 7.5));
  assert.equal(r.average, 7.5);
  assert.throws(() => parseCritique(answer({ overall_score: 11 }), opts()), CritiqueError);
  const bad = answer();
  (bad.scores as { score: unknown }[])[2].score = 0;
  assert.throws(() => parseCritique(bad, opts()), /tension/);
});

test("every criterion is scored; only dialogue may be «no aplica», and the average leaves it out", () => {
  const missing = answer({ scores: answer().scores.filter((s) => s.criterion !== "ritmo") });
  assert.throws(() => parseCritique(missing, opts()), /ritmo/);
  // The retry is taken leniently: a missing criterion is left out, not invented.
  assert.equal(parseCritique(missing, opts(false)).scores.length, CRITERIA.length - 1);

  const noDialogue = answer();
  (noDialogue.scores as { criterion: string; score: unknown }[]).find((s) => s.criterion === "dialogos")!.score = null;
  (noDialogue.scores as { criterion: string; score: unknown }[]).find((s) => s.criterion === "interes")!.score = 3.5;
  const r = parseCritique(noDialogue, opts());
  assert.equal(r.scores.find((s) => s.criterion === "dialogos")!.score, null);
  assert.equal(r.average, Math.round(((7.5 * 7 + 3.5) / 8) * 10) / 10);

  const nullRhythm = answer();
  (nullRhythm.scores as { criterion: string; score: unknown }[]).find((s) => s.criterion === "ritmo")!.score = null;
  assert.throws(() => parseCritique(nullRhythm, opts()), /ritmo/);
});

test("quotes are verified against the chapter; a score without one found is an impression", () => {
  const a = answer();
  (a.scores as { criterion: string; quotes: string[] }[]).find((s) => s.criterion === "prosa")!.quotes = ["una frase que nunca dijo"];
  const r = parseCritique(a, opts());
  const prosa = r.scores.find((s) => s.criterion === "prosa")!;
  assert.deepEqual(prosa.refs, [{ quote: "una frase que nunca dijo", verified: false }]);
  assert.equal(prosa.impression, true);
  assert.ok(r.scores.filter((s) => s.criterion !== "prosa").every((s) => !s.impression && s.refs[0].verified));
  // Quotes forgive what a model changes without changing the words: «comillas», case, spacing.
  const b = answer({ strengths: [{ text: "x", quote: "«¿te perdiste?»,  LE preguntó" }] });
  assert.equal(parseCritique(b, opts()).strengths[0].verified, true);
  // A score without any quote: sent back once; on the retry, kept and marked.
  const c = answer();
  (c.scores as { quotes: string[] }[])[0].quotes = [];
  assert.throws(() => parseCritique(c, opts()), /ninguna cita/);
  assert.equal(parseCritique(c, opts(false)).scores[0].impression, true);
});

test("no rewriting: a long «quote» is refused, and every field has a ceiling", () => {
  const a = answer({ weaknesses: [{ text: "x", quote: `${CH2} ${CH2} ${CH2} ${CH2}` }] });
  assert.throws(() => parseCritique(a, opts()), /citas deben ser breves/);
  const lenient = parseCritique(a, opts(false));
  assert.ok(lenient.weaknesses[0].quote.length <= 300 && !lenient.weaknesses[0].verified);
  const long = parseCritique(answer({ verdict_text: "x".repeat(5000) }), opts());
  assert.ok(long.verdict_text.length <= 1500);
});

test("reader experience: an explicit conclusion and its stretches, in the order of the chapter", () => {
  const r = parseCritique(answer(), opts());
  assert.deepEqual(r.experience.effects, ["emociona"]);
  assert.match(r.experience.summary, /pierde interés/);
  assert.deepEqual(r.experience.stretches.map((s) => s.effect), ["engancha", "decae"], "sorted by where they are");
  assert.ok(r.experience.stretches.every((s) => s.verified));
  assert.throws(() => parseCritique(answer({ experience: { ...answer().experience, effects: ["divierte"] } }), opts()), /effects/);
  assert.throws(() => parseCritique(answer({ experience: { ...answer().experience, summary: "" } }), opts()), /summary/);
});

test("verdict from the closed set: excelente, sólido, irregular, no funciona todavía", () => {
  for (const v of ["excelente", "solido", "irregular", "no_funciona"]) assert.equal(parseCritique(answer({ verdict: v }), opts()).verdict, v);
  assert.throws(() => parseCritique(answer({ verdict: "aceptable" }), opts()), /verdict/);
});

test("contradictions count only when both passages are in the manuscript", () => {
  // Both quoted literally (the earlier one in chapter 1): confirmed, and it may weigh.
  const real = parseCritique(
    answer({
      contradictions: [
        {
          description: "Elena ya conocía el puerto",
          quote: "bajó al puerto por primera vez",
          source_chapter: 2, // the wrong chapter: corrected
          source_quote: "Elena conocía el puerto desde niña",
          affects: ["funcion", "inventado"],
        },
      ],
    }),
    opts(),
  ).contradictions[0];
  assert.equal(real.confirmed, true);
  assert.equal(real.sourceChapter, 1);
  assert.deepEqual(real.affects, ["funcion"]);

  // Only a digest says so (the earlier passage is not in the manuscript), and it lowered a score:
  // sent back with the reason; on the retry it is kept, unconfirmed, never hidden.
  const fromDigest = answer({
    contradictions: [
      { description: "Según la ficha, Elena odiaba el mar", quote: "El viento olía a sal", source_chapter: 1, source_quote: "Elena odiaba el mar", affects: ["funcion"] },
    ],
  });
  assert.throws(() => parseCritique(fromDigest, opts()), /no se confirman en el manuscrito.*El manuscrito manda/s);
  const kept = parseCritique(fromDigest, opts(false)).contradictions[0];
  assert.equal(kept.confirmed, false);
  assert.equal(kept.sourceVerified, false);
  assert.equal(kept.sourceChapter, null);

  // Unconfirmed but lowering nothing: fine on the first answer.
  const harmless = answer({ contradictions: [{ ...(fromDigest.contradictions as object[])[0], affects: [] }] });
  assert.equal(parseCritique(harmless, opts()).contradictions[0].confirmed, false);

  // The passage of the evaluated chapter must be there too.
  const inventedHere = answer({
    contradictions: [{ description: "x", quote: "Elena nunca bajó", source_chapter: 1, source_quote: "Elena conocía el puerto desde niña", affects: ["funcion"] }],
  });
  assert.throws(() => parseCritique(inventedHere, opts()), /no se confirman/);
});

test("instructions: a demanding critic that never rewrites, pausado no es aburrido, adult fiction by its craft", () => {
  const I = CRITIC_INSTRUCTIONS;
  assert.match(I, /^<critico-literario>/);
  assert.match(I, /No reescribes ni propones texto alternativo/);
  assert.match(I, /No eres complaciente/);
  assert.match(I, /mediocre o aburrido/);
  assert.match(I, /Pausado no es aburrido/);
  assert.match(I, /declara qué tipo de capítulo es/);
  assert.match(I, /con un decimal/);
  assert.match(I, /La respetabilidad moral de lo que ocurre no es un criterio literario/);
  assert.match(I, /sexo, violencia o ambigüedad moral no baja ni sube ninguna nota/);
  assert.match(I, /El manuscrito manda/);
  assert.match(I, /no es la media|no la media/);
  for (const c of CRITERIA) assert.ok(I.includes(`"${c.key}"`), c.key);
  // Nothing in it softens: no «apropiado», no «con delicadeza», no warnings.
  assert.doesNotMatch(I.replace(/«hacerla más apropiada»/, ""), /apropiad|delicadeza|advertencia de contenido/i);
});

test("the request: the chapter whole, what came before, never the plan or the Consejero", () => {
  const p = criticPrompt({
    label: "Capítulo 2: El puerto",
    text: CH2,
    guide: "# Guía Maestra\n\n- Tono: melancólico",
    novelSummary: "Elena vuelve a su ciudad.",
    earlier: [{ label: "Capítulo 1", summary: "Infancia de Elena.", quotes: ["Elena conocía el puerto desde niña"], outdated: true }],
    missingDigests: [],
    previousEnding: { label: "Capítulo 1", text: CH1 },
    threads: ["La carta"],
    characters: ["Elena\nEdad: 30"],
  });
  assert.ok(p.includes(`<capitulo-evaluado titulo="Capítulo 2: El puerto">\n${CH2}\n</capitulo-evaluado>`), "the whole chapter");
  assert.match(p, /<ficha capitulo="Capítulo 1" desactualizada="sí">/);
  assert.match(p, /Pasajes literales del manuscrito:\n- «Elena conocía el puerto desde niña»/);
  assert.match(p, /<final-del-capitulo-anterior capitulo="Capítulo 1">/);
  assert.match(p, /Tono: melancólico/);
  assert.doesNotMatch(p, /sinopsis|argumento general|observaciones|conversación/i);
});

test("the Crítico's model: its own, else the Consejero's, else the writing one", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL_ADVISE;
    delete process.env.ANTHROPIC_MODEL_CRITIC;
    assert.equal(modelFor("anthropic", "critic"), "claude-opus-5-5");
    process.env.ANTHROPIC_MODEL_ADVISE = "modelo-consejero";
    assert.equal(modelFor("anthropic", "critic"), "modelo-consejero");
    process.env.ANTHROPIC_MODEL_CRITIC = "modelo-critico";
    assert.equal(modelFor("anthropic", "critic"), "modelo-critico");
    assert.equal(modelFor("anthropic", "advise"), "modelo-consejero", "the Consejero keeps its own");
  } finally {
    process.env = saved;
  }
});
