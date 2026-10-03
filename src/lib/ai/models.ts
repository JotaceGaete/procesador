import type { AIRole, ProviderId } from "../types";

/**
 * Model per provider and role (docs/consejero.md): writing (Asistente), advice
 * (Consejero) and a cheaper one for analysis and summaries. Each is configured on
 * its own; until it is, a role uses the writing model.
 *
 *   ANTHROPIC_MODEL           ANTHROPIC_MODEL_ADVISE    ANTHROPIC_MODEL_DIGEST
 *   OPENAI_MODEL              OPENAI_MODEL_ADVISE       OPENAI_MODEL_DIGEST
 *   XAI_MODEL                 XAI_MODEL_ADVISE          XAI_MODEL_DIGEST
 */

const PREFIX: Record<ProviderId, string> = { anthropic: "ANTHROPIC", openai: "OPENAI", xai: "XAI" };
const DEFAULT_MODEL: Record<ProviderId, string> = { anthropic: "claude-opus-5-5", openai: "gpt-5.5", xai: "grok-4" };
const ROLE_SUFFIX: Record<AIRole, string> = { write: "", advise: "_ADVISE", digest: "_DIGEST" };

export function modelFor(provider: ProviderId, role: AIRole = "write"): string {
  const base = process.env[`${PREFIX[provider]}_MODEL`] || DEFAULT_MODEL[provider];
  return (role !== "write" && process.env[`${PREFIX[provider]}_MODEL${ROLE_SUFFIX[role]}`]) || base;
}

/**
 * Prices in US$ per million tokens, from AI_PRICES (JSON), e.g.
 *   {"claude-opus-5-5": {"input": 5, "cached": 0.5, "output": 25}}
 * Prices change and differ by account, so none are built in: without them the
 * author sees tokens only.
 */
interface Price {
  input: number;
  cached?: number;
  output: number;
}

export function priceOf(model: string): Price | null {
  try {
    const table = JSON.parse(process.env.AI_PRICES || "{}") as Record<string, Price>;
    const p = table[model];
    return p && Number.isFinite(p.input) && Number.isFinite(p.output) ? p : null;
  } catch {
    return null;
  }
}

/** Estimated cost of one request. `input` includes the cached tokens. */
export function costUsd(model: string, input: number, cached: number, output: number): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const fresh = Math.max(0, input - cached);
  return (fresh * p.input + cached * (p.cached ?? p.input) + output * p.output) / 1_000_000;
}

/**
 * Size above which the panel asks before sending (AI_CONFIRM_TOKENS). Normal
 * queries never ask; only exceptionally large ones, such as a deep read of a long novel.
 */
export function confirmTokens(): number {
  const n = Number(process.env.AI_CONFIRM_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 150_000;
}
