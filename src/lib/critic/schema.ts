import { findQuote } from "../advisor/quotes";
import { CRITERIA, EFFECTS, EXPERIENCE, MAY_NOT_APPLY, VERDICTS, type CriterionKey, type ExperienceKey } from "./criteria";
import type { Contradiction, CriterionScore, CritiquePoint, ReaderExperience, Stretch } from "./types";

/**
 * Validation of the Crítico's answer (docs/critico.md). The server checks everything before
 * storing it: the scale, every criterion, the closed sets, the length of each field (a
 * critic that returns rewritten prose is refused) and every quote against the manuscript.
 *
 * `strict` is the first answer. A mistake there (a missing criterion, a contradiction that the
 * manuscript does not confirm but that lowered a score) is sent back to the model once, with
 * the reason. The second answer is taken leniently: what still fails is marked, never hidden.
 */

export class CritiqueError extends Error {}

/** Longest quote accepted: a longer one is no longer a quote but a copy of the text. */
export const QUOTE_MAX = 300;

export interface ParsedCritique {
  chapter_kind: string;
  experience: ReaderExperience;
  scores: CriterionScore[];
  average: number;
  overall_score: number;
  strengths: CritiquePoint[];
  weaknesses: CritiquePoint[];
  contradictions: Contradiction[];
  verdict: (typeof VERDICTS)[number]["key"];
  verdict_text: string;
}

export interface ParseOptions {
  /** The evaluated chapter, as saved. */
  text: string;
  /** Every chapter up to and including the evaluated one, in order (the manuscript to check against). */
  manuscript: string[];
  strict: boolean;
}

const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const arr = (x: unknown) => (Array.isArray(x) ? x : []);
const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().replace(/\s+\n/g, "\n").slice(0, max) : "");

/** «7,5», "7.5" or 7.5 → 7.5; anything else, or out of 1–10, → NaN. One decimal. */
export function readScore(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim().replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 10) return NaN;
  return Math.round(n * 10) / 10;
}

export function parseCritique(raw: unknown, o: ParseOptions): ParsedCritique {
  const r = obj(raw);
  if (!r) throw new CritiqueError("La respuesta no es un objeto.");
  const problems: string[] = [];
  const fail = (m: string) => {
    if (o.strict) problems.push(m);
  };

  const quote = (x: unknown): { quote: string; verified: boolean } => {
    const q = str(x, 2000).replace(/^[«"“]+|[»"”]+$/g, "").trim();
    if (q.length > QUOTE_MAX) {
      fail(`Una cita tiene ${q.length} caracteres: las citas deben ser breves (máximo ${QUOTE_MAX}), nunca un fragmento reescrito.`);
      return { quote: q.slice(0, QUOTE_MAX), verified: false };
    }
    return { quote: q, verified: !!q && findQuote(o.text, q) !== null };
  };

  const chapter_kind = str(r.chapter_kind, 300);
  if (!chapter_kind) throw new CritiqueError('Falta "chapter_kind": qué tipo de capítulo es.');

  // Reader experience: the explicit conclusion and its stretches, in the order of the chapter.
  const e = obj(r.experience);
  if (!e) throw new CritiqueError('Falta "experience".');
  const effects = [...new Set(arr(e.effects).filter((x): x is ExperienceKey => EXPERIENCE.some((k) => k.key === x)))].slice(0, 2);
  if (!effects.length) throw new CritiqueError(`"experience.effects" debe tener uno o dos de: ${EXPERIENCE.map((k) => k.key).join(", ")}.`);
  const summary = str(e.summary, 1200);
  if (!summary) throw new CritiqueError('Falta "experience.summary": la conclusión sobre la experiencia del lector.');
  const stretches: Stretch[] = arr(e.stretches)
    .map(obj)
    .filter((s): s is Record<string, unknown> => !!s && EFFECTS.some((k) => k.key === s.effect))
    .slice(0, 8)
    .map((s) => ({ effect: s.effect as Stretch["effect"], note: str(s.note, 400), ...quote(s.quote) }));
  if (!stretches.length) throw new CritiqueError('"experience.stretches" debe señalar los tramos del capítulo.');
  const place = (q: string) => (q ? (findQuote(o.text, q)?.start ?? Infinity) : Infinity);
  stretches.sort((a, b) => place(a.quote) - place(b.quote));

  // One score per criterion, in the given order.
  const given = arr(r.scores).map(obj).filter((s): s is Record<string, unknown> => !!s);
  const scores: CriterionScore[] = [];
  for (const c of CRITERIA) {
    const s = given.find((x) => x.criterion === c.key);
    if (!s) {
      if (o.strict) throw new CritiqueError(`Falta la nota de "${c.key}". Hay que calificar todos los criterios.`);
      continue;
    }
    const mayBeNull = MAY_NOT_APPLY.includes(c.key);
    const score = s.score === null && mayBeNull ? null : readScore(s.score);
    if (score !== null && Number.isNaN(score))
      throw new CritiqueError(`La nota de "${c.key}" debe ser un número de 1 a 10 con un decimal${mayBeNull ? " (o null si no aplica)" : ""}.`);
    const refs = arr(s.quotes).slice(0, 4).map(quote).filter((q) => q.quote);
    if (score !== null && !refs.length) fail(`La nota de "${c.key}" no tiene ninguna cita del capítulo.`);
    scores.push({
      criterion: c.key,
      score,
      rationale: str(s.rationale, 900),
      refs,
      impression: score !== null && !refs.some((q) => q.verified),
    });
  }
  if (!scores.length) throw new CritiqueError("No hay ninguna nota.");
  const applied = scores.map((s) => s.score).filter((n): n is number => n !== null);
  const average = applied.length ? Math.round((applied.reduce((a, b) => a + b, 0) / applied.length) * 10) / 10 : 0;

  const overall_score = readScore(r.overall_score);
  if (Number.isNaN(overall_score)) throw new CritiqueError('"overall_score" debe ser un número de 1 a 10 con un decimal.');

  const points = (x: unknown, name: string) => {
    const list = arr(x)
      .map(obj)
      .filter((p): p is Record<string, unknown> => !!p && !!str(p.text, 10))
      .slice(0, 3)
      .map((p) => ({ text: str(p.text, 500), ...quote(p.quote) }));
    if (!list.length) fail(`"${name}" no puede estar vacío.`);
    return list;
  };
  const strengths = points(r.strengths, "strengths");
  const weaknesses = points(r.weaknesses, "weaknesses");

  // Contradictions count only when both passages are in the manuscript (Juan's adjustment 3).
  const contradictions: Contradiction[] = arr(r.contradictions)
    .map(obj)
    .filter((c): c is Record<string, unknown> => !!c && !!str(c.description, 10))
    .slice(0, 6)
    .map((c) => {
      const here = quote(c.quote);
      const sourceQuote = str(c.source_quote, QUOTE_MAX).replace(/^[«"“]+|[»"”]+$/g, "").trim();
      const said = Number(c.source_chapter);
      // The chapter it names first, then any other up to this one (a quote in the wrong chapter is corrected).
      const order = [said - 1, ...o.manuscript.keys()].filter((i, k, all) => i >= 0 && i < o.manuscript.length && all.indexOf(i) === k);
      const found = sourceQuote ? order.find((i) => findQuote(o.manuscript[i], sourceQuote) !== null) : undefined;
      const affects = [...new Set(arr(c.affects).filter((k): k is CriterionKey => CRITERIA.some((x) => x.key === k)))];
      return {
        description: str(c.description, 600),
        quote: here.quote,
        quoteVerified: here.verified,
        sourceQuote,
        sourceChapter: found === undefined ? null : found + 1,
        sourceVerified: found !== undefined,
        confirmed: here.verified && found !== undefined,
        affects,
      };
    });
  const weighed = contradictions.filter((c) => !c.confirmed && c.affects.length);
  if (weighed.length)
    fail(
      `Estas contradicciones no se confirman en el manuscrito y, sin embargo, bajaron notas: ${weighed
        .map((c) => `«${c.description}»`)
        .join("; ")}. El manuscrito manda: si no puedes citar literalmente los dos pasajes del manuscrito, deja "affects" vacío y califica sin tenerlas en cuenta.`,
    );

  const verdict = VERDICTS.find((v) => v.key === r.verdict)?.key;
  if (!verdict) throw new CritiqueError(`"verdict" debe ser uno de: ${VERDICTS.map((v) => v.key).join(", ")}.`);
  const verdict_text = str(r.verdict_text, 1500);
  if (!verdict_text) throw new CritiqueError('Falta "verdict_text".');

  if (problems.length) throw new CritiqueError(problems.join("\n"));
  return {
    chapter_kind,
    experience: { effects, summary, stretches },
    scores,
    average,
    overall_score,
    strengths,
    weaknesses,
    contradictions,
    verdict,
    verdict_text,
  };
}
