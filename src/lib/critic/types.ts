import type { ContextPart, ProviderId } from "../types";
import type { CriterionKey, EffectKey, ExperienceKey, VerdictKey } from "./criteria";

/**
 * A report of the Crítico Literario (docs/critico.md), as stored in chapter_critiques.
 * Quotes are short and literal, verified against the manuscript when the report was made.
 */

export interface CritiqueQuote {
  quote: string;
  /** Found in the chapter when it was evaluated. */
  verified: boolean;
}

export interface CriterionScore {
  criterion: CriterionKey;
  /** 1.0 to 10.0, one decimal; null = «no aplica» (only dialogue). */
  score: number | null;
  rationale: string;
  refs: CritiqueQuote[];
  /** No quote of it was found in the text: an impression, not a finding. */
  impression: boolean;
}

export interface Stretch extends CritiqueQuote {
  effect: EffectKey;
  note: string;
}

export interface ReaderExperience {
  /** The explicit conclusion: entertains, moves, bores, loses interest (one or two). */
  effects: ExperienceKey[];
  summary: string;
  /** In the order of the chapter. */
  stretches: Stretch[];
}

export interface CritiquePoint extends CritiqueQuote {
  text: string;
}

/**
 * A contradiction the Crítico found. It only counts (confirmed) when both passages are in
 * the manuscript: one that comes only from a digest, a summary or the Memoria never lowers a
 * score (Juan's adjustment 3).
 */
export interface Contradiction {
  description: string;
  /** The passage of the evaluated chapter. */
  quote: string;
  quoteVerified: boolean;
  /** The earlier passage it contradicts, as the Crítico quoted it. */
  sourceQuote: string;
  /** 1-based chapter where sourceQuote is in the manuscript (corrected by the server), or null. */
  sourceChapter: number | null;
  sourceVerified: boolean;
  confirmed: boolean;
  /** Criteria whose score it lowered, as the Crítico said. */
  affects: CriterionKey[];
}

export interface CritiqueContext {
  parts: ContextPart[];
  /** Earlier chapters without a digest, and with an outdated one. */
  missingDigests: number;
  staleDigests: number;
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
}

export interface Critique {
  id: string;
  novel_id: string;
  chapter_id: string;
  source_revision: number;
  text_sketch: { n: number; h: number[] };
  chapter_kind: string;
  scores: CriterionScore[];
  /** Mean of the scores that apply, for comparison with the overall score. */
  average: number;
  overall_score: number;
  verdict: VerdictKey;
  verdict_text: string;
  experience: ReaderExperience;
  strengths: CritiquePoint[];
  weaknesses: CritiquePoint[];
  contradictions: Contradiction[];
  context: CritiqueContext;
  provider: ProviderId;
  model: string;
  author_response: "agree" | "disagree" | null;
  author_note: string;
  created_at: string;
  updated_at: string;
}

/** A report as the panel receives it: whether the chapter changed since, and where each quote is now. */
export interface CritiqueView extends Critique {
  status: "current" | "touched" | "stale";
  /** For «Ir»: each quote of the evaluated chapter, where it is in the current text (null if gone). */
  at: Record<string, { start: number; end: number } | null>;
}
