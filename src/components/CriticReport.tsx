"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/types";
import { CRITERIA, EFFECTS, EXPERIENCE, VERDICTS, formatScore, labelOf } from "@/lib/critic/criteria";
import type { CritiqueView } from "@/lib/critic/types";
import Modal from "./Modal";

/**
 * The Crítico Literario (docs/critico.md): the report on one finished chapter, and its history.
 * It judges; it never changes the text. The only things the author does here are evaluate,
 * answer the report (theirs alone) and go to a quoted passage.
 */

type Outcome = { done: true; critique: CritiqueView } | { done: false; confirm: { tokens: number; limit: number } };

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const criterionLabel = (k: string) => CRITERIA.find((c) => c.key === k)?.label ?? k;

export default function CriticReport(props: {
  chapterId: string;
  chapterTitle: string;
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  /** Saves the open chapter first: the Crítico reads the chapter as saved. */
  flush(): Promise<boolean>;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  onClose(): void;
}) {
  const { chapterId, providers } = props;
  const [list, setList] = useState<CritiqueView[] | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [provider, setProvider] = useState<ProviderId | null>(props.defaultProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ tokens: number; limit: number } | null>(null);

  useEffect(() => {
    api<CritiqueView[]>(`/api/chapters/${chapterId}/critiques`)
      .then((l) => {
        setList(l);
        setShown(l[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [chapterId]);

  async function evaluate(approvedTokens?: number) {
    if (!provider) return;
    setBusy(true);
    setError("");
    setConfirm(null);
    try {
      if (!(await props.flush())) throw new Error("No se pudo guardar el capítulo: el Crítico lee el capítulo guardado.");
      const r = await api<Outcome>(`/api/chapters/${chapterId}/critiques`, { method: "POST", json: { provider, approvedTokens } });
      if (!r.done) return setConfirm(r.confirm);
      setList((l) => [r.critique, ...(l ?? [])]);
      setShown(r.critique.id);
      setHistory(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const update = (id: string, patch: Partial<CritiqueView>) => setList((l) => l?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? l);
  const remove = async (id: string) => {
    await api(`/api/critiques/${id}`, { method: "DELETE" }).catch((e: Error) => setError(e.message));
    const rest = (list ?? []).filter((c) => c.id !== id);
    setList(rest);
    setShown(rest[0]?.id ?? null);
  };

  const critique = list?.find((c) => c.id === shown) ?? null;
  const go = (quote: string) => {
    const at = critique?.at[quote];
    if (!at) return;
    props.onClose();
    props.onGoTo(chapterId, at.start, at.end, quote);
  };

  const evaluateBar = (
    <div className="critic-actions">
      <button className="btn primary" disabled={busy || !provider} onClick={() => evaluate()}>
        {busy ? "Leyendo y evaluando…" : critique ? "Volver a evaluar" : "Evaluar capítulo"}
      </button>
      {providers.length > 1 && (
        <label className="small">
          <span className="muted">Con </span>
          <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={busy}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      )}
      {list && list.length > 1 && (
        <button className="link small" onClick={() => setHistory((h) => !h)} aria-pressed={history}>
          Historial ({list.length})
        </button>
      )}
    </div>
  );

  return (
    <Modal title={`Crítico · ${props.chapterTitle}`} onClose={props.onClose} wide>
      <div className="critic">
        <p className="muted small critic-tagline">Juzga el capítulo como un lector exigente. No cambia el texto: tú decides qué hacer con su juicio.</p>
        {!providers.length && <p className="notice small">No hay ningún proveedor de IA configurado.</p>}
        {evaluateBar}
        {confirm && (
          <p className="notice small">
            Esta evaluación enviaría unos {confirm.tokens.toLocaleString("es")} tokens, por encima del umbral de{" "}
            {confirm.limit.toLocaleString("es")}.{" "}
            <button className="link" onClick={() => evaluate(confirm.tokens)}>
              Evaluar igualmente
            </button>
          </p>
        )}
        {error && <p className="error small">{error}</p>}
        {list === null && !error && <p className="muted small">Cargando…</p>}
        {list?.length === 0 && !busy && (
          <p className="muted">
            Aún no hay ninguna evaluación de este capítulo. El Crítico lo lee entero, con la Guía y las fichas de los capítulos
            anteriores, y te da una nota por criterio con citas del texto, su experiencia como lector y un veredicto.
          </p>
        )}
        {history && list && (
          <ul className="critic-history">
            {list.map((c) => (
              <li key={c.id}>
                <button className={`link${c.id === shown ? " on" : ""}`} onClick={() => setShown(c.id)}>
                  {when(c.created_at)} · {labelOf(VERDICTS, c.verdict)} · {formatScore(c.overall_score)}
                </button>
                <span className="muted small">
                  {" "}
                  {PROVIDER_LABELS[c.provider] ?? c.provider}
                  {c.status !== "current" ? " · versión anterior" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {critique && <Report critique={critique} go={go} onUpdate={update} onDelete={remove} />}
      </div>
    </Modal>
  );
}

function Quote({ quote, verified, at, go }: { quote: string; verified: boolean; at: { start: number } | null | undefined; go(q: string): void }) {
  if (!quote) return null;
  return (
    <span className="critic-quote">
      «{quote}»{" "}
      {verified && at ? (
        <button className="link small" onClick={() => go(quote)} title="Ir al fragmento">
          Ir
        </button>
      ) : (
        <span className="muted small">{verified ? "(ya no está en el texto)" : "(sin cita verificable)"}</span>
      )}
    </span>
  );
}

function Report({
  critique: c,
  go,
  onUpdate,
  onDelete,
}: {
  critique: CritiqueView;
  go(q: string): void;
  onUpdate(id: string, patch: Partial<CritiqueView>): void;
  onDelete(id: string): void;
}) {
  const [note, setNote] = useState(c.author_note);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  // Another report shown: its own note. (Not on saving this one's, which would hide «Nota guardada».)
  useEffect(() => {
    setNote(c.author_note);
    setSaved("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per report
  }, [c.id]);

  const respond = async (patch: { response?: "agree" | "disagree" | null; note?: string }) => {
    setError("");
    try {
      await api(`/api/critiques/${c.id}`, { method: "PATCH", json: patch });
      onUpdate(c.id, {
        ...(patch.response !== undefined ? { author_response: patch.response } : {}),
        ...(patch.note !== undefined ? { author_note: patch.note.trim() } : {}),
      });
      if (patch.note !== undefined) setSaved("Nota guardada.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const q = (x: { quote: string; verified: boolean }) => <Quote quote={x.quote} verified={x.verified} at={c.at[x.quote]} go={go} />;
  const ctx = c.context;

  return (
    <article className="critic-report" aria-label="Informe del Crítico">
      <header className="critic-head">
        <span className={`critic-verdict v-${c.verdict}`}>{labelOf(VERDICTS, c.verdict)}</span>
        <span className="critic-overall">
          Nota global <strong>{formatScore(c.overall_score)}</strong>
        </span>
        <span className="muted small">media de los criterios {formatScore(c.average)}</span>
      </header>
      <p className="muted small">
        {when(c.created_at)} · {PROVIDER_LABELS[c.provider] ?? c.provider} ({c.model})
        {c.status === "current" ? " · versión actual del capítulo" : c.status === "touched" ? " · el capítulo tiene retoques desde entonces" : ""}
      </p>
      {c.status === "stale" && (
        <p className="notice small changed">Evaluado sobre una versión anterior del capítulo: el texto cambió de forma sustancial desde entonces.</p>
      )}
      <p className="critic-verdict-text">{c.verdict_text}</p>
      <p className="small">
        <span className="muted">Tipo de capítulo: </span>
        {c.chapter_kind}
      </p>

      <section>
        <h3>Experiencia del lector</h3>
        <p>
          {c.experience.effects.map((e) => (
            <span key={e} className={`tag e-${e}`}>
              {labelOf(EXPERIENCE, e)}
            </span>
          ))}{" "}
          {c.experience.summary}
        </p>
        <ol className="critic-stretches">
          {c.experience.stretches.map((s, i) => (
            <li key={i}>
              <span className={`tag e-${s.effect}`}>{labelOf(EFFECTS, s.effect)}</span> {s.note} {q(s)}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3>Calificaciones</h3>
        <table className="critic-scores">
          <thead>
            <tr>
              <th>Criterio</th>
              <th>Nota</th>
              <th>Por qué</th>
            </tr>
          </thead>
          <tbody>
            {c.scores.map((s) => (
              <tr key={s.criterion}>
                <th scope="row">{criterionLabel(s.criterion)}</th>
                <td className="critic-score">{formatScore(s.score)}</td>
                <td>
                  {s.rationale}
                  {s.impression && <span className="muted small impression"> Impresión: ninguna cita se encontró en el texto.</span>}
                  {s.refs.map((r, i) => (
                    <div key={i}>{q(r)}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="critic-points">
        <div>
          <h3>Lo mejor</h3>
          <ul>
            {c.strengths.map((p, i) => (
              <li key={i}>
                {p.text} {q(p)}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Lo más débil</h3>
          <ul>
            {c.weaknesses.map((p, i) => (
              <li key={i}>
                {p.text} {q(p)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {c.contradictions.length > 0 && (
        <section>
          <h3>Contradicciones</h3>
          <ul className="critic-contradictions">
            {c.contradictions.map((x, i) => (
              <li key={i} className={x.confirmed ? "confirmed" : "unconfirmed"}>
                <span className="tag">{x.confirmed ? "Confirmada en el manuscrito" : "No confirmada en el manuscrito"}</span> {x.description}
                <div>{q({ quote: x.quote, verified: x.quoteVerified })}</div>
                {x.sourceQuote && (
                  <div className="muted small">
                    Frente a {x.sourceChapter ? `el capítulo ${x.sourceChapter}` : "un pasaje anterior"}: «{x.sourceQuote}»
                    {x.sourceVerified ? "" : " (no aparece en el manuscrito)"}
                  </div>
                )}
                {!x.confirmed && (
                  <div className="muted small">
                    No debe pesar en la evaluación: puede venir de una ficha, del resumen o de la Memoria, no del texto.
                    {x.affects.length > 0 && ` El Crítico dijo que afectó a: ${x.affects.map(criterionLabel).join(", ")}.`}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="critic-response">
        <h3>Tu respuesta</h3>
        <p className="muted small">Es sólo para ti: no cambia el informe y el Crítico no la lee.</p>
        <div className="critic-actions">
          <button
            className={`btn${c.author_response === "agree" ? " primary" : ""}`}
            aria-pressed={c.author_response === "agree"}
            onClick={() => respond({ response: c.author_response === "agree" ? null : "agree" })}
          >
            De acuerdo
          </button>
          <button
            className={`btn${c.author_response === "disagree" ? " primary" : ""}`}
            aria-pressed={c.author_response === "disagree"}
            onClick={() => respond({ response: c.author_response === "disagree" ? null : "disagree" })}
          >
            En desacuerdo
          </button>
        </div>
        <textarea
          rows={3}
          value={note}
          maxLength={2000}
          placeholder="Nota personal sobre este juicio…"
          onChange={(e) => {
            setNote(e.target.value);
            setSaved("");
          }}
          aria-label="Nota personal"
        />
        <div className="critic-actions">
          <button className="btn" disabled={note.trim() === c.author_note} onClick={() => respond({ note })}>
            Guardar nota
          </button>
          {saved && <span className="muted small">{saved}</span>}
          <span className="spacer" />
          <button className="link small" onClick={() => onDelete(c.id)}>
            Eliminar este informe
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
      </section>

      <p className="muted small critic-read">
        Leyó: {ctx.parts.map((p) => p.label).join(", ")}
        {ctx.missingDigests > 0 && ` · ${ctx.missingDigests} capítulos anteriores sin ficha`}
        {ctx.staleDigests > 0 && ` · ${ctx.staleDigests} fichas desactualizadas`} · {ctx.input.toLocaleString("es")} tokens de entrada
        {ctx.cached ? ` (${ctx.cached.toLocaleString("es")} en caché)` : ""} → {ctx.output.toLocaleString("es")}
        {ctx.costUsd != null ? ` · ≈ US$${ctx.costUsd.toFixed(3)}` : ""}
      </p>
    </article>
  );
}
