"use client";

import type { DiffOp } from "@/lib/diff";
import { MARKER_RE, SEPARATOR_RE } from "@/lib/manuscript";

/**
 * Two texts compared, for a writer (docs/versiones.md, docs/asistente-contexto.md): the
 * prose itself, with what is added highlighted and what is removed struck through. No
 * line numbers, no +/- signs. Images and scene breaks show as what they are, never as
 * their markers. Long unchanged stretches show only their ends.
 */

/** Unchanged stretches longer than this show only their ends. */
const CONTEXT_CHARS = 240;

const MARKS = new RegExp(`${MARKER_RE.source}|${SEPARATOR_RE.source}`, "gi");

/** Text with its markers drawn: «Imagen: …» and the scene break. */
function Prose({ text, describe }: { text: string; describe?: (id: string) => string }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKS)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push(
      m[1] ? (
        <span key={m.index} className="diff-mark">
          Imagen{describe?.(m[1].toLowerCase()) ? `: ${describe(m[1].toLowerCase())}` : ""}
        </span>
      ) : (
        <span key={m.index} className="diff-mark">
          ⁂ cambio de escena
        </span>
      ),
    );
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export default function DiffView({
  ops,
  label,
  describe,
  full = false,
}: {
  ops: DiffOp[];
  label: string;
  /** An image's description (alt or caption), by id. */
  describe?: (id: string) => string;
  /** The whole text, without shortening unchanged stretches. */
  full?: boolean;
}) {
  return (
    <div className="diff" aria-label={label}>
      {ops.map((o, i) => {
        if (o.kind === "add")
          return (
            <ins key={i}>
              <Prose text={o.text} describe={describe} />
            </ins>
          );
        if (o.kind === "del")
          return (
            <del key={i}>
              <Prose text={o.text} describe={describe} />
            </del>
          );
        if (full || o.text.length <= CONTEXT_CHARS * 2 + 40)
          return (
            <span key={i}>
              <Prose text={o.text} describe={describe} />
            </span>
          );
        const head = i === 0 ? "" : o.text.slice(0, CONTEXT_CHARS);
        const tail = i === ops.length - 1 ? "" : o.text.slice(-CONTEXT_CHARS);
        return (
          <span key={i}>
            <Prose text={head} describe={describe} />
            <span className="diff-gap muted">{"\n[…]\n"}</span>
            <Prose text={tail} describe={describe} />
          </span>
        );
      })}
    </div>
  );
}
