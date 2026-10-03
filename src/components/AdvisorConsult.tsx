"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { chapterLabel } from "@/lib/ai/context";
import {
  ADVISOR_ACTIONS,
  OBSERVATION_LABELS,
  PROVIDER_LABELS,
  type AdvisorAction,
  type AssistEvent,
  type ChapterInfo,
  type ContextPart,
  type Observation,
  type ProviderId,
  type Usage,
} from "@/lib/types";
import type { Selection } from "./ChapterEditor";
import { formatTokens } from "./format";
import UsageLine from "./UsageLine";

interface Props {
  novelId: string;
  chapterId: string;
  chapters: ChapterInfo[];
  provider: ProviderId | null;
  providers: ProviderId[];
  onProvider(p: ProviderId): void;
  selection: Selection | null;
  confirmTokens: number;
  getContent(): string;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  /** An alternative of "¿Cómo seguir?" goes to the Asistente as the argument of a scene. */
  onSendToAssistant(text: string): void;
}

type Ask = { action?: AdvisorAction; question?: string; useSelection: boolean };
type Unread = { id: string; title: string; estimate: number };

const CONFIDENCE = { high: "confianza alta", medium: "confianza media", low: "confianza baja" };
const OPEN_TAG = "<observaciones>";

/** What streamed, without the observations block (or a half-written opening tag). */
function visible(text: string) {
  const i = text.indexOf(OPEN_TAG);
  if (i !== -1) return text.slice(0, i).trim();
  for (let n = OPEN_TAG.length - 1; n > 0; n--) if (text.endsWith(OPEN_TAG.slice(0, n))) return text.slice(0, -n);
  return text;
}

/**
 * Consultar (docs/consejero.md, phase 3): quick actions and free questions. The answer
 * is advice, never text for the manuscript; each observation shows its references,
 * checked against the text, with "Ir".
 */
export default function AdvisorConsult(p: Props) {
  const [question, setQuestion] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [last, setLast] = useState<(Ask & { provider: ProviderId }) | null>(null);
  const [plan, setPlan] = useState<{ label: string; detail: string } | null>(null);
  const [text, setText] = useState("");
  const [cards, setCards] = useState<Observation[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [parts, setParts] = useState<ContextPart[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const index = new Map(p.chapters.map((c, i) => [c.id, i]));
  const label = (id: string) => (index.has(id) ? chapterLabel(index.get(id)!, p.chapters[index.get(id)!].title) : "capítulo desconocido");

  function body(ask: Ask, using: ProviderId | null) {
    return {
      novelId: p.novelId,
      chapterId: p.chapterId,
      content: p.getContent(),
      action: ask.action,
      question: ask.question,
      selection: ask.useSelection && p.selection ? { start: p.selection.start, end: p.selection.end } : null,
      provider: using,
    };
  }

  async function post(path: string, json: unknown, signal: AbortSignal) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json), signal });
    if (res.status === 401) window.location.href = "/login";
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    return res;
  }

  async function run(ask: Ask, using: ProviderId) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setLast({ ...ask, provider: using });
    setText("");
    setCards(null);
    setInvalid(false);
    setNotice(null);
    setParts(null);
    setUsage(null);
    setPlan(null);
    try {
      // What it would read, and which chapters it would like read first.
      const dry = await (await post("/api/advisor", { ...body(ask, using), dryRun: true }, controller.signal)).json();
      setPlan(dry.plan);
      const unread: Unread[] = dry.unread ?? [];
      const reading = unread.reduce((n, u) => n + u.estimate, 0);
      // Normal queries go out without asking; only an exceptionally large one is confirmed.
      if (dry.total + reading > p.confirmTokens) {
        const extra = unread.length ? ` (incluye leer ${unread.length} capítulos sin ficha)` : "";
        if (!confirm(`Esta consulta enviará unos ${formatTokens(dry.total + reading)} tokens${extra}. ¿Continuar?`)) return;
      }
      const failed: string[] = [];
      for (const [i, u] of unread.entries()) {
        setProgress(`Leyendo ${u.title} para tener su ficha (${i + 1} de ${unread.length})…`);
        try {
          await post(`/api/chapters/${u.id}/digest`, { provider: using }, controller.signal);
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          // Without that digest the answer still comes; the context says what was missing.
          failed.push(`${u.title}: ${(e as Error).message}`);
        }
      }
      setProgress(null);
      if (failed.length) setNotice(`No se pudieron leer: ${failed.join("; ")}`);

      const res = await post("/api/advisor", body(ask, using), controller.signal);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AssistEvent;
          if (e.type === "text") setText((t) => t + e.text);
          else if (e.type === "context") setParts(e.parts);
          else if (e.type === "plan") setPlan({ label: e.label, detail: e.detail });
          else if (e.type === "usage") setUsage(e);
          else if (e.type === "observations") {
            setCards(e.items);
            setInvalid(Boolean(e.invalid));
          } else if (e.type === "refusal" || e.type === "error") setNotice(e.message);
          else if (e.type === "truncated") setNotice("La respuesta se cortó por longitud.");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNotice((e as Error).message);
    } finally {
      setProgress(null);
      if (abort.current === controller) setRunning(false);
    }
  }

  const ask = (a: Ask) => p.provider && run(a, p.provider);
  const others = p.providers.filter((x) => x !== last?.provider);

  return (
    <div className="consult">
      <div className="actions advisor-actions" role="group" aria-label="Acciones del Consejero">
        {ADVISOR_ACTIONS.map((a) => (
          <button key={a.id} title={a.hint} disabled={running || !p.provider} onClick={() => ask({ action: a.id, useSelection })}>
            {a.label}
          </button>
        ))}
      </div>
      {p.selection && (
        <label className="check small">
          <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} />
          <span>Sobre la selección (Analizar y Coherencia)</span>
        </label>
      )}
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) ask({ question: question.trim(), useSelection });
        }}
      >
        <textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pregúntale al Consejero… Ej.: ¿Revelo demasiado pronto lo de la carta?"
          aria-label="Pregunta al Consejero"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="ask-row">
          <span className="muted small">Piensa contigo; no cambia el texto.</span>
          <span className="spacer" />
          {running ? (
            <button type="button" className="btn ghost" onClick={() => abort.current?.abort()}>
              Detener
            </button>
          ) : (
            <button className="btn" disabled={!question.trim() || !p.provider}>
              Preguntar
            </button>
          )}
        </div>
      </form>
      {!p.provider && <p className="error">No hay proveedor de IA configurado.</p>}

      {last && (
        <section className="result advisor-result" aria-live="polite">
          {plan && (
            <p className="muted small plan">
              {last.question ? "Entendí la pregunta como: " : ""}
              <strong>{plan.label}</strong>
              {plan.detail ? ` · ${plan.detail}` : ""}
            </p>
          )}
          {progress && <p className="muted small" role="status">{progress}</p>}
          {visible(text) && (
            <div className="markdown">
              <ReactMarkdown>{visible(text)}</ReactMarkdown>
            </div>
          )}
          {running && !text && !progress && <p className="muted">Pensando…</p>}
          {cards && cards.length > 0 && (
            <ul className="observations">
              {cards.map((o, i) => (
                <li key={i} className={`observation obs-${o.kind}${o.verified ? "" : " unverified"}`}>
                  <p className="obs-head">
                    <span className="obs-kind">{OBSERVATION_LABELS[o.kind]}</span>
                    <span className="muted small"> · {CONFIDENCE[o.confidence]}</span>
                  </p>
                  <p className="obs-title">{o.title}</p>
                  {o.body && <p className="obs-body">{o.body}</p>}
                  {o.refs.length > 0 && (
                    <ul className="obs-refs">
                      {o.refs.map((r, j) => (
                        <li key={j} className={r.verified ? "verified" : "unverified"}>
                          {r.verified && r.at ? (
                            <>
                              <span className="muted small">{label(r.chapterId)}:</span> «{r.quote}»{" "}
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
                  {!o.verified && (
                    <p className="muted small impression">Impresión: sin cita verificable en el manuscrito.</p>
                  )}
                  {o.kind === "alternative" && (
                    <button className="link small" onClick={() => p.onSendToAssistant(`${o.title}. ${o.body}`)}>
                      Enviar al Asistente
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {invalid && <p className="notice small">Las observaciones llegaron mal formadas y no se muestran; el texto sí.</p>}
          {notice && <p className="notice">{notice}</p>}
          {!running && (parts || usage) && <UsageLine parts={parts} usage={usage} />}
          {!running && others.length > 0 && (
            <p className="retry-with muted small">
              Probar con{" "}
              {others.map((x, i) => (
                <span key={x}>
                  {i > 0 && " · "}
                  <button
                    className="link"
                    onClick={() => {
                      p.onProvider(x);
                      run(last, x);
                    }}
                  >
                    {PROVIDER_LABELS[x]}
                  </button>
                </span>
              ))}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
