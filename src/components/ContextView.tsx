"use client";

import type { ContextSection, ContextSectionId } from "@/lib/types";
import { formatTokens } from "./format";

/** Sections that are lists of concrete things the author can unfold to check one by one. */
const LISTS: ContextSectionId[] = [
  "story",
  "guide",
  "characters",
  "knowledge",
  "places",
  "relationships",
  "facts",
  "threads",
  "passages",
];
/** Lists whose label already says what they hold. */
const LABELLED: ContextSectionId[] = ["guide", "story", "knowledge"];
/** Lists whose names fit in the line itself. */
const NAMED: ContextSectionId[] = ["characters", "places"];

/**
 * "Ver contexto": what the AI will take into account in this request, in the author's terms.
 * It comes from the same code that builds the request (dry run): nothing listed "just in
 * case", nothing sent without being listed. Procesador's instructions only count in the total.
 */
export default function ContextView({
  sections,
  total,
  instructions,
  includeManuscript,
  updating,
  notices = [],
}: {
  sections: ContextSection[];
  total: number;
  instructions: number;
  includeManuscript: boolean;
  /** The inputs changed and a new estimate is on its way. */
  updating?: boolean;
  /** What the AI does not know and the author may want to fix (chapters without a digest…). */
  notices?: string[];
}) {
  return (
    <div className="context-view" role="region" aria-label="Contexto que recibirá la IA" aria-busy={updating}>
      <p className="context-title">
        La IA tendrá en cuenta <span className="muted small">(tokens aprox.){updating ? " · actualizando…" : ""}</span>
      </p>
      <ul className="context-sections">
        {sections.map((s) => (
          <li key={s.id} data-section={s.id}>
            {LISTS.includes(s.id) ? (
              <details>
                <summary>
                  {s.label}
                  {NAMED.includes(s.id) ? `: ${s.items.map((i) => i.label).join(", ")}` : LABELLED.includes(s.id) ? "" : `: ${s.items.length}`}
                  <span className="muted"> · ≈{formatTokens(s.tokens)}</span>
                </summary>
                <ul className="context-items">
                  {s.items.map((i, k) => (
                    <li key={k}>
                      <span className="item-label">{i.label}</span>
                      {i.reason && <span className="muted"> · {i.reason}</span>}
                      {i.note && <span className="muted"> · {i.note}</span>}
                      {i.detail && <span className="item-detail muted">{i.detail}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <span>
                {s.label}
                {s.id !== "argument" && s.items.length > 0 && ` — ${s.items.map((i) => i.label).join(" · ")}`}
                <span className="muted"> · ≈{formatTokens(s.tokens)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Total aproximado: ≈{formatTokens(total)} tokens
        {instructions > 0 && `, de ellos ≈${formatTokens(instructions)} de instrucciones de Procesador al modelo`}.
      </p>
      {notices.map((n) => (
        <p key={n} className="muted small context-notice">
          {n}
        </p>
      ))}
      {!includeManuscript && (
        <p className="muted small">No lee la novela completa: sólo lo que aparece aquí.</p>
      )}
    </div>
  );
}
