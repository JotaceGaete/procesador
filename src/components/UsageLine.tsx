"use client";

import type { ContextPart, Usage } from "@/lib/types";
import { formatTokens, formatUsd } from "./format";

/** Discreet: what the AI read (estimated) and what the provider reported it used. */
export default function UsageLine({ parts, usage }: { parts: ContextPart[] | null; usage: Usage | null }) {
  const read = parts
    ?.filter((p) => p.tokens > 0)
    .map((p) => `${p.label.toLowerCase()} ≈${formatTokens(p.tokens)}`)
    .join(" · ");
  return (
    <p className="usage-line muted small">
      {read && <span>Leyó: {read}.</span>}{" "}
      {usage && (
        <span title={usage.model}>
          {formatTokens(usage.input)} tokens de entrada
          {usage.cached > 0 && ` (${formatTokens(usage.cached)} en caché)`} → {formatTokens(usage.output)} de salida
          {usage.costUsd != null && ` · ≈ ${formatUsd(usage.costUsd)}`}
        </span>
      )}
    </p>
  );
}

