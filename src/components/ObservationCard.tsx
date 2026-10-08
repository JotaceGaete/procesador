"use client";

import { useState } from "react";
import {
  OBSERVATION_LABELS,
  type Fact,
  type Memory,
  type Observation,
  type StoredObservation,
  type StoryThread,
} from "@/lib/types";
import { api } from "@/lib/client";

/** Labels of a proposal's sections, as the server writes them in its body (observations.ts). */
const SECTION = /^(Qué podría ocurrir|Por qué funciona aquí|Qué aprovecha|Consecuencias|Riesgos|Personajes): /;

/**
 * What goes to the Asistente as a scene's argument: what would happen (and who), not the
 * reasons, consequences or risks, which are for the author.
 */
function argument(o: Observation): string {
  const lines = o.body.split("\n");
  if (!lines.some((l) => SECTION.test(l))) return `${o.title}. ${o.body}`;
  const pick = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? "";
  const who = pick("Personajes");
  return [`${o.title}.`, pick("Qué podría ocurrir"), who && `Personajes: ${who}.`].filter(Boolean).join(" ");
}

/** The body, with the sections of a proposal (one per line) under their label. */
function Body({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.some((l) => SECTION.test(l))) return <p className="obs-body">{text}</p>;
  return (
    <dl className="obs-body obs-sections">
      {lines.map((l, i) => {
        const m = l.match(SECTION);
        return m ? (
          <div key={i}>
            <dt>{m[1]}</dt>
            <dd>{l.slice(m[0].length)}</dd>
          </div>
        ) : (
          <div key={i}>
            <dd>{l}</dd>
          </div>
        );
      })}
    </dl>
  );
}

const CONFIDENCE = { high: "confianza alta", medium: "confianza media", low: "confianza baja" };

export interface CardActions {
  novelId: string;
  memory: Memory;
  threads: StoryThread[];
  label(chapterId: string): string;
  onChanged(o: StoredObservation): void;
  onThreadsChanged(): void;
  onFactAdded(f: Fact): void;
  /** Ask the Consejero to reconsider it, in its conversation. */
  onAskAgain?(o: StoredObservation): void;
}

/**
 * One observation of the Consejero: kind, confidence, explanation and references checked
 * against the text, with "Ir". Stored ones can be saved, dismissed, resolved, checked
 * again after an edit, turned into a suggested fact, or acted on as a thread. None of
 * these actions writes in the manuscript.
 */
export default function ObservationCard(p: {
  o: Observation | StoredObservation;
  label(chapterId: string): string;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  onSendToAssistant(text: string): void;
  actions?: CardActions;
  /** Its label in the conversation (A, B, B2 — a version of B). */
  tag?: { label: string; from: string | null } | null;
  /** "Seguir con esta": the next message is about this card. */
  onFollow?(o: StoredObservation): void;
}) {
  const o = p.o;
  const stored = "id" in o ? (o as StoredObservation) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fact, setFact] = useState<{ text: string; chapterId: string } | null>(null);
  const [factDone, setFactDone] = useState(false);
  const a = p.actions;

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const setStatus = (status: string) =>
    act(async () => a!.onChanged(await api<StoredObservation>(`/api/observations/${stored!.id}`, { method: "PATCH", json: { status } })));

  if (stored?.status === "dismissed") {
    return (
      <li className="observation dismissed">
        <span className="muted small">
          Descartada: {p.tag ? `${p.tag.label} · ` : ""}
          {o.title} ·{" "}
        </span>
        <button className="link small" disabled={busy} onClick={() => setStatus("new")}>
          Restaurar
        </button>
      </li>
    );
  }

  // A thread named in the observation, for "Marcar cabo cerrado"; none: "Crear cabo".
  const text = `${o.title} ${o.body}`.toLocaleLowerCase("es");
  const thread = a?.threads.find((t) => text.includes(t.title.toLocaleLowerCase("es")));
  const changed = stored?.changed ?? [];

  return (
    <li className={`observation obs-${o.kind}${o.verified ? "" : " unverified"}${stored?.status === "saved" ? " saved" : ""}`}>
      <p className="obs-head">
        {p.tag && (
          <span className="obs-label" title={p.tag.from ? `Versión de ${p.tag.from}` : undefined}>
            {o.kind === "alternative" && !p.tag.from ? `Camino ${p.tag.label}` : p.tag.label}
            {p.tag.from ? ` · versión de ${p.tag.from}` : ""}
          </span>
        )}
        <span className="obs-kind">{OBSERVATION_LABELS[o.kind]}</span>
        <span className="muted small"> · {CONFIDENCE[o.confidence]}</span>
        {stored?.status === "saved" && <span className="tag">guardada</span>}
        {stored?.status === "resolved" && <span className="tag">resuelta</span>}
      </p>
      <p className="obs-title">{o.title}</p>
      {o.body && <Body text={o.body} />}
      {o.refs.length > 0 && (
        <ul className="obs-refs">
          {o.refs.map((r, j) => (
            <li key={j} className={r.verified ? "verified" : "unverified"}>
              {r.verified && r.at ? (
                <>
                  <span className="muted small">{p.label(r.chapterId)}:</span> «{r.quote}»{" "}
                  <button className="link small" onClick={() => p.onGoTo(r.chapterId, r.at!.start, r.at!.end, r.quote)}>
                    Ir
                  </button>
                </>
              ) : (
                <>
                  «{r.quote}» <span className="muted small">— no aparece en el texto</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!o.verified && <p className="muted small impression">Impresión: sin cita verificable en el manuscrito.</p>}
      {changed.length > 0 && (
        <p className="notice small changed">
          Basada en una versión anterior de {changed.map((id) => p.label(id)).join(", ")}.
        </p>
      )}

      <div className="obs-actions small">
        {stored && p.onFollow && (o.kind === "alternative" || o.kind === "opportunity") && (
          <button className="link" title="Tu próximo mensaje será sobre esta propuesta" onClick={() => p.onFollow!(stored)}>
            Seguir con esta
          </button>
        )}
        {o.kind === "alternative" && (
          <button className="link" onClick={() => p.onSendToAssistant(argument(o))}>
            Enviar al Asistente
          </button>
        )}
        {stored && a && (
          <>
            {stored.status === "new" && (
              <>
                <button className="link" disabled={busy} onClick={() => setStatus("saved")}>
                  Guardar
                </button>
                <button className="link" disabled={busy} onClick={() => setStatus("dismissed")}>
                  Descartar
                </button>
              </>
            )}
            {stored.status === "saved" && (
              <button className="link" disabled={busy} onClick={() => setStatus("resolved")}>
                Marcar resuelta
              </button>
            )}
            {stored.status === "resolved" && (
              <button className="link" disabled={busy} onClick={() => setStatus("saved")}>
                Reabrir
              </button>
            )}
            {changed.length > 0 && (
              <button
                className="link"
                disabled={busy}
                title="Busca de nuevo sus citas en el texto actual (sin IA)"
                onClick={() => act(async () => a.onChanged(await api<StoredObservation>(`/api/observations/${stored.id}/recheck`, { method: "POST" })))}
              >
                Volver a comprobar
              </button>
            )}
            {a.onAskAgain && changed.length > 0 && (
              <button className="link" disabled={busy} onClick={() => a.onAskAgain!(stored)}>
                Preguntar de nuevo
              </button>
            )}
            {!factDone && (o.kind === "contradiction" || o.kind === "problem" || o.kind === "thread") && (
              <button
                className="link"
                disabled={busy}
                onClick={() => setFact(fact ? null : { text: o.body || o.title, chapterId: o.refs.find((r) => r.verified)?.chapterId ?? "" })}
              >
                Proponer hecho
              </button>
            )}
            {o.kind === "thread" &&
              (thread ? (
                thread.status === "open" && (
                  <button
                    className="link"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await api(`/api/threads/${thread.id}`, { method: "PATCH", json: { status: "closed" } });
                        a.onThreadsChanged();
                      })
                    }
                  >
                    Marcar cabo «{thread.title}» cerrado
                  </button>
                )
              ) : (
                <button
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/novels/${a.novelId}/threads`, { method: "POST", json: { title: o.title } });
                      a.onThreadsChanged();
                    })
                  }
                >
                  Crear cabo
                </button>
              ))}
          </>
        )}
      </div>

      {fact && a && (
        <form
          className="propose-fact"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              // Characters named in the fact are linked to it; the author reviews it in Memoria.
              const lower = fact.text.toLocaleLowerCase("es");
              const characterIds = a.memory.characters.filter((c) => lower.includes(c.name.toLocaleLowerCase("es"))).map((c) => c.id);
              const created = await api<Fact>(`/api/novels/${a.novelId}/memory/facts`, {
                method: "POST",
                json: { text: fact.text, chapter_id: fact.chapterId || null, character_ids: characterIds, status: "suggested" },
              });
              a.onFactAdded(created);
              setFact(null);
              setFactDone(true);
            });
          }}
        >
          <textarea
            rows={3}
            value={fact.text}
            onChange={(e) => setFact({ ...fact, text: e.target.value })}
            aria-label="Hecho propuesto"
          />
          <p className="muted small">Se añade a Memoria como sugerido: no cuenta como canon hasta que lo apruebes.</p>
          <button className="btn" disabled={busy || !fact.text.trim()}>
            Añadir a Memoria
          </button>{" "}
          <button type="button" className="link small" onClick={() => setFact(null)}>
            Cancelar
          </button>
        </form>
      )}
      {factDone && <p className="muted small">Hecho propuesto en Memoria, pendiente de tu aprobación.</p>}
      {error && <p className="error small">{error}</p>}
    </li>
  );
}
