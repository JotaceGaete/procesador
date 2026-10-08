"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DiffOp } from "@/lib/diff";
import { present } from "@/lib/presentation";
import DiffView from "./DiffView";

/**
 * A proposal of the Asistente, read in large (docs/asistente-contexto.md): the scene or the
 * rewritten fragment set as the book sets it (paragraphs, italics, scene breaks), with the
 * same actions as in the panel. Only a view: the proposal lives in the panel, so closing this
 * loses nothing.
 */
export default function ProposalReader({
  title,
  where,
  text,
  changes,
  original,
  words,
  primary,
  primaryDisabled,
  notice,
  onPrimary,
  onRetry,
  onDiscard,
  onClose,
}: {
  title: string;
  /** Where it goes, in the author's terms. */
  where: string;
  /** The proposal, in the manuscript's format. */
  text: string;
  /** A rewrite: what changes, and the author's text as it is. */
  changes?: DiffOp[];
  original?: string;
  words: number;
  primary: string;
  primaryDisabled: boolean;
  notice?: string | null;
  onPrimary(): void;
  onRetry(): void;
  onDiscard(): void;
  onClose(): void;
}) {
  const [view, setView] = useState<"proposal" | "changes" | "original">("proposal");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="reader-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="proposal-reader" role="dialog" aria-modal="true" aria-label={title}>
        <header className="reader-head">
          <div>
            <h2>{title}</h2>
            <p className="muted small">
              {where} · ≈{words.toLocaleString("es")} palabras
            </p>
          </div>
          <span className="spacer" />
          <button className="link" onClick={onClose}>
            Volver al manuscrito
          </button>
        </header>
        {changes && (
          <div className="tabs reader-tabs" role="group" aria-label="Cómo ver la propuesta">
            {(
              [
                ["proposal", "Propuesta"],
                ["changes", "Cambios"],
                ["original", "Tu texto"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={view === id ? "on" : undefined} aria-pressed={view === id} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="reader-body">
          {view === "changes" && changes ? (
            <DiffView ops={changes} label="Cambios que propone la IA" full />
          ) : (
            <article className="reading reader-text" aria-label={view === "original" ? "Tu texto" : "Propuesta"}>
              {present(view === "original" && original !== undefined ? original : text).map((b, n) =>
                b.kind === "para" ? (
                  <p key={n} className={b.first ? "first" : undefined}>
                    {b.spans.map((s, j) => (s.italic ? <em key={j}>{s.text}</em> : s.text))}
                  </p>
                ) : b.kind === "break" ? (
                  <hr key={n} className="scene-break" aria-label="Cambio de escena" />
                ) : (
                  <p key={n} className="reader-image muted small">
                    Imagen
                  </p>
                ),
              )}
            </article>
          )}
        </div>
        <footer className="reader-foot">
          {notice && (
            <p className="notice" role="alert">
              {notice}
            </p>
          )}
          <button className="btn primary" disabled={primaryDisabled} onClick={onPrimary}>
            {primary}
          </button>
          <button className="btn ghost" onClick={onRetry}>
            Otra versión
          </button>
          <button className="btn ghost" onClick={onDiscard}>
            Descartar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
