"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import type { Observation, StoredObservation } from "@/lib/types";

/**
 * A proposal of the Consejero in Conversar: just the idea, as a friend would put it on the
 * table, with what to do with it. No kind, no confidence, no list of risks (that is Analizar).
 * A quote it relies on, if verified, as one discreet line with «Ir».
 */
export default function ProposalCard(p: {
  o: Observation | StoredObservation;
  tag?: { label: string; from: string | null } | null;
  label(chapterId: string): string;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  /** Stored proposals only (the live answer has no actions yet). */
  onDevelop?(o: StoredObservation): void;
  onHandoff?(o: StoredObservation): void;
  onChanged?(o: StoredObservation): void;
  busy?: boolean;
}) {
  const o = p.o;
  const stored = "id" in o ? (o as StoredObservation) : null;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const setStatus = async (status: string) => {
    if (!stored || !p.onChanged) return;
    setWorking(true);
    setError("");
    try {
      p.onChanged(await api<StoredObservation>(`/api/observations/${stored.id}`, { method: "PATCH", json: { status } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (stored?.status === "dismissed") {
    return (
      <li className="proposal dismissed">
        <span className="muted small">
          Descartada: {p.tag ? `${p.tag.label} · ` : ""}
          {o.title} ·{" "}
        </span>
        <button className="link small" disabled={working} onClick={() => setStatus("new")}>
          Restaurar
        </button>
      </li>
    );
  }

  const lines = o.body.split("\n").filter((l) => l.trim());
  const who = lines.find((l) => l.startsWith("Personajes: "));
  const text = lines.filter((l) => l !== who).map((l) => l.replace(/^(Qué podría ocurrir|Por qué funciona aquí|Qué aprovecha|Consecuencias|Riesgos): /, ""));
  const ref = o.refs.find((r) => r.verified && r.at);

  return (
    <li className={`proposal${stored?.status === "saved" ? " saved" : ""}`}>
      <p className="proposal-head">
        {p.tag && (
          <span className="obs-label" title={p.tag.from ? `Versión de ${p.tag.from}` : undefined}>
            {p.tag.from ? `${p.tag.label} · versión de ${p.tag.from}` : `Propuesta ${p.tag.label}`}
          </span>
        )}
        {stored?.status === "saved" && <span className="tag">guardada</span>}
      </p>
      <p className="proposal-title">{o.title}</p>
      {text.map((l, i) => (
        <p key={i} className="proposal-body">
          {l}
        </p>
      ))}
      {who && <p className="muted small">{who}</p>}
      {ref && (
        <p className="muted small proposal-ref">
          Se apoya en {p.label(ref.chapterId)}: «{ref.quote}»{" "}
          <button className="link small" onClick={() => p.onGoTo(ref.chapterId, ref.at!.start, ref.at!.end, ref.quote)}>
            Ir
          </button>
        </p>
      )}
      {stored && (
        <div className="proposal-actions">
          {p.onDevelop && (
            <button className="link" disabled={p.busy} onClick={() => p.onDevelop!(stored)}>
              Desarrollar idea
            </button>
          )}
          {p.onHandoff && (
            <button className="link strong" disabled={p.busy} onClick={() => p.onHandoff!(stored)}>
              Enviar al Asistente
            </button>
          )}
          {stored.status !== "saved" ? (
            <button className="link" disabled={working} onClick={() => setStatus("saved")} title="Queda en Guardadas; es una idea, no un hecho">
              Guardar idea
            </button>
          ) : (
            <button className="link" disabled={working} onClick={() => setStatus("new")}>
              Quitar de guardadas
            </button>
          )}
          <button className="link muted" disabled={working} onClick={() => setStatus("dismissed")}>
            Descartar
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </li>
  );
}
