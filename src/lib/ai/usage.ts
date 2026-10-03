import { db } from "../supabase";
import type { ProviderId, Usage } from "../types";

export type UsagePurpose = "assist" | "advise" | "digest";

/** One row per AI request. A failure to log never breaks the answer the author is reading. */
export async function recordUsage(novelId: string, purpose: UsagePurpose, provider: ProviderId, u: Usage) {
  const { error } = await db().from("ai_usage").insert({
    novel_id: novelId,
    purpose,
    provider,
    model: u.model,
    input_tokens: u.input,
    cached_tokens: u.cached,
    output_tokens: u.output,
    cost_usd: u.costUsd,
  });
  if (error) console.error("[ai_usage]", error.message);
}

export interface MonthUsage {
  requests: number;
  input: number;
  cached: number;
  output: number;
  /** Sum of the requests that have a price; null when none has one. */
  costUsd: number | null;
}

/** This calendar month's usage for a novel (UTC). */
export async function monthUsage(novelId: string, now = new Date()): Promise<MonthUsage> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db()
    .from("ai_usage")
    .select("input_tokens, cached_tokens, output_tokens, cost_usd")
    .eq("novel_id", novelId)
    .gte("created_at", from);
  if (error) throw error;
  const total: MonthUsage = { requests: data.length, input: 0, cached: 0, output: 0, costUsd: null };
  for (const r of data) {
    total.input += r.input_tokens;
    total.cached += r.cached_tokens;
    total.output += r.output_tokens;
    if (r.cost_usd != null) total.costUsd = (total.costUsd ?? 0) + Number(r.cost_usd);
  }
  return total;
}
