import "server-only";
import { getMemory } from "../supabase";
import { nameMatcher } from "../ai/context";
import { formatCharacter } from "../ai/prompts";
import { completeJson, InvalidOutput } from "../ai/structured";
import { recordUsage } from "../ai/usage";
import type { ProviderId } from "../types";
import { COMPARE_CRITERIA, COMPARE_INSTRUCTIONS } from "./prompts";

/**
 * Juicio comparativo (docs/consejero.md, «Revisar escena»): after a rewrite of a scene, the
 * Consejero compares it with the author's version. A recommendation, never a decision: the
 * panel shows it next to the comparison, and «Reemplazar» stays the author's.
 */

export type Winner = "original" | "propuesta" | "empate";

export interface Comparison {
  verdict: "mejor" | "igual" | "peor";
  summary: string;
  criteria: { name: string; winner: Winner; why: string }[];
  losses: string[];
  changes: string[];
}

export const COMPARE_LIMIT = 30_000;

const strings = (x: unknown) =>
  (Array.isArray(x) ? x : []).filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 500)).slice(0, 8);

/** The model's answer as a Comparison, or InvalidOutput (one retry, then an error). */
export function parseComparison(raw: unknown): Comparison {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.verdict !== "mejor" && r.verdict !== "igual" && r.verdict !== "peor") throw new InvalidOutput('"verdict" debe ser "mejor", "igual" o "peor".');
  if (typeof r.summary !== "string" || !r.summary.trim()) throw new InvalidOutput('Falta "summary".');
  const given = (Array.isArray(r.criteria) ? r.criteria : []).filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  const criteria = COMPARE_CRITERIA.flatMap((name) => {
    const c = given.find((x) => typeof x.name === "string" && x.name.trim().toLocaleLowerCase("es") === name.toLocaleLowerCase("es"));
    if (!c) return [];
    const winner: Winner = c.winner === "original" || c.winner === "propuesta" ? c.winner : "empate";
    return [{ name, winner, why: typeof c.why === "string" ? c.why.trim().slice(0, 400) : "" }];
  });
  return { verdict: r.verdict, summary: r.summary.trim().slice(0, 800), criteria, losses: strings(r.losses), changes: strings(r.changes) };
}

/** The prompt: the people of the scene from the Memoria (and who they are to each other), then both versions. */
export function comparePrompt(p: {
  original: string;
  proposal: string;
  characters: { name: string; block: string }[];
  relationships: string[];
}): string {
  const memory = [
    p.characters.length && `## Personajes\n\n${p.characters.map((c) => c.block).join("\n\n")}`,
    p.relationships.length && `## Relaciones\n${p.relationships.join("\n")}`,
  ].filter(Boolean);
  return [
    memory.length ? `<memoria>\n${memory.join("\n\n")}\n</memoria>` : "",
    `<original>\n${p.original}\n</original>`,
    `<propuesta>\n${p.proposal}\n</propuesta>`,
    "Compara las dos versiones.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function compareVersions(opts: {
  novelId: string;
  original: string;
  proposal: string;
  provider: ProviderId;
  signal: AbortSignal;
}): Promise<Comparison> {
  const memory = await getMemory(opts.novelId);
  const text = `${opts.original}\n${opts.proposal}`;
  const people = memory.characters.filter((c) => nameMatcher(c)?.test(text));
  const ids = new Set(people.map((c) => c.id));
  const name = (id: string) => memory.characters.find((c) => c.id === id)?.name ?? "?";
  const relationships = memory.relationships
    .filter((r) => ids.has(r.from_id) && ids.has(r.to_id))
    .map((r) => `- ${name(r.from_id)} → ${r.kind} → ${name(r.to_id)}${r.note.trim() ? ` (${r.note.trim()})` : ""}`);
  const { value } = await completeJson(
    opts.provider,
    {
      instructions: COMPARE_INSTRUCTIONS,
      manuscript: null,
      project: "",
      prompt: comparePrompt({
        original: opts.original,
        proposal: opts.proposal,
        characters: people.map((c) => ({ name: c.name, block: formatCharacter(c) })),
        relationships,
      }),
      signal: opts.signal,
      role: "advise",
      maxOutputTokens: 2000,
    },
    parseComparison,
    (u) => recordUsage(opts.novelId, "advise", opts.provider, u),
  );
  return value;
}
