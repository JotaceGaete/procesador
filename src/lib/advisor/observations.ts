import type { Observation, ObservationKind, ObservationRef } from "../types";
import { findQuote } from "./quotes";

/**
 * The Consejero's answer: Markdown for the author, then the observations as JSON inside
 * <observaciones>…</observaciones>. Every reference is checked against the manuscript
 * (decision 5): a quote is "verified" only if it is literally in the text. If the model
 * put it in the wrong chapter but it is elsewhere, it points to where it really is. One
 * that is nowhere is kept as written but marked, and lowers the card's confidence. A card
 * with no verified reference is shown as an impression, not as a finding.
 */

export const OBS_OPEN = "<observaciones>";
const OBS_CLOSE = "</observaciones>";

const KINDS: ObservationKind[] = ["problem", "repetition", "contradiction", "thread", "opportunity", "alternative", "pacing"];
const LEVELS = ["high", "medium", "low"] as const;

/** The Markdown part (what streamed before the tag) and the raw JSON of the observations. */
export function splitAnswer(text: string): { markdown: string; json: string | null } {
  const i = text.indexOf(OBS_OPEN);
  if (i === -1) return { markdown: text.trim(), json: null };
  const j = text.indexOf(OBS_CLOSE, i);
  return { markdown: text.slice(0, i).trim(), json: text.slice(i + OBS_OPEN.length, j === -1 ? undefined : j).trim() };
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");

/**
 * The sections of a proposal (Consejero creativo), in the order the author reads them.
 * They are stored inside the card's body, one per line, so no column is needed; the
 * panel shows each label in bold.
 */
export const PROPOSAL_SECTIONS: [string, string][] = [
  ["ocurre", "Qué podría ocurrir"],
  ["porque", "Por qué funciona aquí"],
  ["aprovecha", "Qué aprovecha"],
  ["consecuencias", "Consecuencias"],
  ["riesgos", "Riesgos"],
  ["personajes", "Personajes"],
];

function sections(r: Record<string, unknown>): string {
  return PROPOSAL_SECTIONS.map(([key, label]) => {
    const v = r[key];
    const text = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : str(v, 900);
    return text ? `${label}: ${text.replace(/\s*\n+\s*/g, " ")}` : "";
  })
    .filter(Boolean)
    .join("\n");
}

export function verifyObservations(
  raw: unknown,
  chapters: { id: string; content: string }[],
  max = 12,
): Observation[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : null;
  if (!list) throw new Error("Las observaciones deben ser una lista.");
  const out: Observation[] = [];
  for (const o of list.slice(0, max)) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const title = str(r.title ?? r.titulo, 200);
    // A proposal may come in sections; they go after whatever body it has.
    const body = [str(r.body ?? r.explicacion, 3000), sections(r)].filter(Boolean).join("\n").slice(0, 3000);
    if (!title && !body) continue;
    const kind = (KINDS.includes(r.kind as ObservationKind) ? r.kind : "problem") as ObservationKind;
    let level = LEVELS.indexOf((r.confidence ?? r.confianza) as (typeof LEVELS)[number]);
    if (level === -1) level = 1;

    const refs: ObservationRef[] = [];
    const rawRefs = Array.isArray(r.refs ?? r.referencias) ? ((r.refs ?? r.referencias) as unknown[]) : [];
    for (const ref of rawRefs.slice(0, 6)) {
      if (!ref || typeof ref !== "object") continue;
      const x = ref as Record<string, unknown>;
      const quote = str(x.quote ?? x.cita, 500);
      if (!quote) continue;
      const n = Number(x.chapter ?? x.capitulo);
      const claimed = Number.isInteger(n) && n >= 1 && n <= chapters.length ? n - 1 : -1;
      // The chapter it names first, then the rest of the novel.
      const order = claimed === -1 ? chapters.map((_, i) => i) : [claimed, ...chapters.map((_, i) => i).filter((i) => i !== claimed)];
      let found: ObservationRef | null = null;
      for (const i of order) {
        const at = findQuote(chapters[i].content, quote);
        if (at) {
          found = { chapterId: chapters[i].id, quote: chapters[i].content.slice(at.start, at.end), verified: true, at };
          break;
        }
      }
      refs.push(found ?? { chapterId: claimed === -1 ? "" : chapters[claimed].id, quote, verified: false, at: null });
    }
    // A quote that isn't in the text lowers the confidence one step.
    if (refs.some((x) => !x.verified)) level = Math.min(2, level + 1);
    out.push({ kind, title: title || body.slice(0, 80), body, confidence: LEVELS[level], refs, verified: refs.some((x) => x.verified) });
  }
  return out;
}
