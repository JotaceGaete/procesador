"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { chapterLabel } from "@/lib/ai/context";
import { api, noticeLock, readPref, writePref } from "@/lib/client";
import {
  ADVISOR_ACTIONS,
  PROVIDER_LABELS,
  type AdvisorMessage,
  type ConversationSummary,
  type Fact,
  type Memory,
  type StoredObservation,
  type StoryThread,
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
import ObservationCard, { type CardActions } from "./ObservationCard";
import { conversationCards, currentFocus } from "@/lib/advisor/cards";
import { conversationPlan, lastProposal, wantsHandoff, wantsSave, type AdvisorMode, type SceneBrief } from "@/lib/advisor/converse";
import ProposalCard from "./ProposalCard";
import SceneBriefEditor from "./SceneBriefEditor";

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
  /** «Enviar al Asistente» from Conversar: the scene order the author reviewed. */
  onSendBrief(b: SceneBrief): void;
  memory: Memory;
  /** Saves the open chapter, so what an observation relied on is the saved revision. */
  flush(): Promise<boolean>;
  onFactAdded(f: Fact): void;
}

type Ask = {
  action?: AdvisorAction;
  question?: string;
  useSelection: boolean;
  /** "Seguir con esta": the card the question is about. */
  anchorId?: string;
  /** After a pause: the material the author approved, and up to how many tokens. */
  preload?: unknown[];
  approvedTokens?: number;
};
type Material = { label: string; tokens: number }[];

/** "Consultó además: …", discreet, under an answer that used lectura profunda. */
function MaterialLine({ items, rounds }: { items: Material; rounds?: number }) {
  if (!items.length) return null;
  const tokens = items.reduce((n, i) => n + i.tokens, 0);
  return (
    <p className="material-line muted small">
      Consultó además: {items.map((i) => i.label).join(" · ")} — ≈{formatTokens(tokens)} tokens
      {rounds ? ` en ${rounds} ${rounds === 1 ? "ronda" : "rondas"}` : ""}
    </p>
  );
}
type Unread = { id: string; title: string; estimate: number };

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
  const [plan, setPlan] = useState<{ label: string; detail: string; mode?: AdvisorMode } | null>(null);
  // Conversar (a companion; the default) or Analizar (the full evaluation), remembered per novel.
  const [mode, setModeState] = useState<AdvisorMode>("conversar");
  useEffect(() => setModeState(readPref(`advisorMode:${p.novelId}`) === "analizar" ? "analizar" : "conversar"), [p.novelId]);
  const setMode = (m: AdvisorMode) => {
    setModeState(m);
    writePref(`advisorMode:${p.novelId}`, m);
  };
  // «Enviar al Asistente»: the brief being prepared or reviewed.
  const [brief, setBrief] = useState<{ loading: boolean; data: SceneBrief | null; error: string } | null>(null);
  const [newDecision, setNewDecision] = useState("");
  const [text, setText] = useState("");
  const [cards, setCards] = useState<Observation[] | null>(null);
  const [labels, setLabels] = useState<{ label: string; from: string | null }[] | null>(null);
  // The author let the proposal in course go: the next message is not about it.
  const [released, setReleased] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [parts, setParts] = useState<ContextPart[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [rounds, setRounds] = useState<string[]>([]);
  const [material, setMaterial] = useState<{ items: Material; rounds: number } | null>(null);
  const [deep, setDeep] = useState(true);
  useEffect(() => setDeep(readPref("deepReading") !== "0"), []);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  // Conversations: the open one (null: a new one starts with the next question) and its history.
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<AdvisorMessage[]>([]);
  // The live answer was stored and now shows in the history.
  const [stored, setStored] = useState(false);
  const [threads, setThreads] = useState<StoryThread[]>([]);

  const loadList = useCallback(async () => {
    setConversations(await api<ConversationSummary[]>(`/api/novels/${p.novelId}/conversations`).catch(() => []));
  }, [p.novelId]);
  const loadThreads = useCallback(async () => {
    setThreads(await api<StoryThread[]>(`/api/novels/${p.novelId}/threads`).catch(() => []));
  }, [p.novelId]);
  // keepLast: after a stored answer, "Probar con" still repeats it.
  const open = useCallback(async (id: string | null, keepLast = false) => {
    setConversationId(id);
    // Remembered per novel: switching views or reloading comes back to it.
    writePref(`conversation:${p.novelId}`, id ?? "");
    if (!keepLast) {
      setLast(null);
      setStored(false);
    }
    setReleased(false);
    setHistory(id ? (await api<{ messages: AdvisorMessage[] }>(`/api/conversations/${id}`)).messages : []);
  }, [p.novelId]);
  useEffect(() => {
    loadList();
    loadThreads();
    const last = readPref(`conversation:${p.novelId}`);
    if (last) open(last).catch(() => open(null));
  }, [loadList, loadThreads, open, p.novelId]);

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
      conversationId,
      deep,
      mode,
      anchorId: ask.anchorId,
      release: released && !ask.anchorId,
      preload: ask.preload,
      approvedTokens: ask.approvedTokens,
    };
  }

  async function post(path: string, json: unknown, signal: AbortSignal) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json), signal });
    if (res.status === 401) window.location.href = "/login";
    await noticeLock(res);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    return res;
  }

  async function run(ask: Ask, using: ProviderId) {
    abort.current?.abort();
    setStored(false);
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setLast({ ...ask, provider: using });
    setText("");
    setCards(null);
    setLabels(null);
    setInvalid(false);
    setNotice(null);
    setParts(null);
    setUsage(null);
    setPlan(null);
    setRounds([]);
    setMaterial(null);
    let pause: { tokens: number; requests: unknown[]; items: string[] } | null = null;
    let savedTo: string | null = null;
    try {
      await p.flush();
      // What it would read, and which chapters it would like read first.
      const dry = await (await post("/api/advisor", { ...body(ask, using), dryRun: true }, controller.signal)).json();
      setPlan(dry.plan);
      const unread: Unread[] = dry.unread ?? [];
      const reading = unread.reduce((n, u) => n + u.estimate, 0);
      // Normal queries go out without asking; only an exceptionally large one is confirmed.
      if (dry.total + reading > p.confirmTokens) {
        const extra = unread.length ? ` (incluye leer ${unread.length} capítulos sin ficha)` : "";
        if (!confirm(`Esta consulta enviará unos ${formatTokens(dry.total + reading)} tokens${extra}. ¿Continuar?`)) {
          setNotice("Consulta cancelada: no se envió nada.");
          return;
        }
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
          else if (e.type === "reset") setText("");
          else if (e.type === "reading")
            setRounds((r) => [...r, `${e.round ? `Ronda ${e.round}` : "Aprobado"}: ${e.items.join(" · ")}`]);
          else if (e.type === "material") setMaterial({ items: e.items, rounds: e.rounds });
          else if (e.type === "confirm") pause = e;
          else if (e.type === "context") setParts(e.parts);
          else if (e.type === "plan") setPlan({ label: e.label, detail: e.detail, mode: e.mode });
          else if (e.type === "usage") setUsage(e);
          else if (e.type === "observations") {
            setCards(e.items);
            setLabels(e.labels ?? null);
            setInvalid(Boolean(e.invalid));
          } else if (e.type === "saved") savedTo = e.conversationId;
          else if (e.type === "refusal" || e.type === "error") setNotice(e.message);
          else if (e.type === "truncated") setNotice("La respuesta se cortó por longitud.");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNotice((e as Error).message);
    } finally {
      setProgress(null);
      if (abort.current === controller) setRunning(false);
    }
    // Paused before reading beyond the extraordinary threshold: the author decides.
    if (pause) {
      const p0 = pause as { tokens: number; requests: unknown[]; items: string[] };
      const what = p0.items.length ? `\n\nYa pidió: ${p0.items.join(" · ")}.` : "";
      if (confirm(`Para responder, el Consejero quiere seguir leyendo: la consulta llegaría a unos ${formatTokens(p0.tokens)} tokens.${what}\n\n¿Continuar?`)) {
        return run({ ...ask, preload: p0.requests, approvedTokens: p0.tokens }, using);
      }
      setNotice("Lectura profunda detenida: no se leyó más material. Puedes preguntar sin lectura profunda.");
      return;
    }
    // Stored: it now belongs to the conversation's history, where its cards can be acted on.
    if (savedTo) {
      setStored(true);
      setReleased(false);
      // Threads may have changed (reading chapters first, or elsewhere): the cards act on the current ones.
      await Promise.all([open(savedTo, true), loadThreads()]);
      if (ask.question) setQuestion("");
      await loadList();
    }
  }

  const ask = (a: Ask) => p.provider && run(a, p.provider);
  const others = p.providers.filter((x) => x !== last?.provider);
  const update = (o: StoredObservation) =>
    setHistory((h) => h.map((m) => ({ ...m, observations: m.observations.map((x) => (x.id === o.id ? o : x)) })));
  const actions: CardActions = {
    novelId: p.novelId,
    memory: p.memory,
    threads,
    label,
    onChanged: update,
    onThreadsChanged: loadThreads,
    onFactAdded: p.onFactAdded,
    onAskAgain: (o) =>
      ask({ question: `Vuelve a comprobar esta observación con el texto actual: «${o.title}». ${o.body}`, useSelection: false }),
  };
  const lastAdvisor = [...history].reverse().find((m) => m.role === "advisor");
  // Labels of the cards (A, B, B2…) and the proposal being developed, as the server sees them.
  const tags = new Map(conversationCards(history).map((c) => [c.id, { label: c.label, from: c.from }]));
  const focus = released ? null : currentFocus(history);
  const follow = (o: StoredObservation) => {
    const tag = tags.get(o.id);
    ask({ question: `Sigamos con ${tag ? `${o.kind === "alternative" && !tag.from ? "el camino " : ""}${tag.label}` : "esta propuesta"}: «${o.title}».`, anchorId: o.id, useSelection: false });
  };
  const creative = ADVISOR_ACTIONS.filter((a) => a.group === "crear");
  const review = ADVISOR_ACTIONS.filter((a) => a.group === "revisar");
  const quick = (a: (typeof ADVISOR_ACTIONS)[number]) =>
    a.ask
      ? () => {
          // "¿Qué pasa si…?": the author writes the possibility.
          setQuestion((q) => (q.trim() ? q : a.ask!));
          requestAnimationFrame(() => {
            const t = input.current;
            if (!t) return;
            t.focus();
            t.setSelectionRange(t.value.length, t.value.length);
          });
        }
      : () => ask({ action: a.id, useSelection });

  // Conversar: what the author decided and ruled out in this conversation (editable).
  const decided = conversationPlan(history);
  const planEdit = async (json: unknown) => {
    if (!conversationId) return;
    await api(`/api/conversations/${conversationId}`, { method: "PATCH", json: { plan: json } });
    await open(conversationId, true);
  };
  const removeFrom = (kind: "decisions" | "discarded", item: { text: string; message: number }) => {
    const m = history[item.message];
    const list = (m?.context?.[kind] ?? []).filter((x) => x !== item.text);
    return planEdit({ messageId: m.id, [kind]: list });
  };
  // «Enviar al Asistente»: the brief, prepared from the conversation, for the author to review.
  async function handoff(anchorId: string | null) {
    if (!conversationId || !p.provider) return;
    setBrief({ loading: true, data: null, error: "" });
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: true, novelId: p.novelId, conversationId, anchorId, provider: p.provider }),
      });
      if (res.status === 401) window.location.href = "/login";
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
      setBrief({ loading: false, data: json as SceneBrief, error: "" });
    } catch (e) {
      setBrief({ loading: false, data: null, error: (e as Error).message });
    }
  }
  const cardsNow = conversationCards(history);
  const onTable = () => (focus ? cardsNow.find((c) => c.id === focus.id) ?? null : lastProposal(cardsNow));
  // What the author types: «envíala al Asistente» and «guárdala» act on the proposal on the
  // table without asking the model; anything else is a message.
  function submit() {
    const q = question.trim();
    if (!q) return;
    const card = mode === "conversar" && conversationId ? onTable() : null;
    if (card && wantsHandoff(q)) {
      setQuestion("");
      return handoff(card.id);
    }
    if (card && wantsSave(q)) {
      setQuestion("");
      return api<StoredObservation>(`/api/observations/${card.id}`, { method: "PATCH", json: { status: "saved" } }).then(update);
    }
    ask({ question: q, useSelection });
  }
  const conversing = mode === "conversar";
  const develop = (o: StoredObservation) => ask({ question: "Desarróllala.", anchorId: o.id, useSelection: false });

  // The answer on its way: in Conversar, like a chat turn (the text and at most a proposal);
  // in Analizar, with its plan, reading rounds and cards.
  const chatTurn = (plan?.mode ?? mode) === "conversar";
  const liveResult = last && !stored && (chatTurn ? (
        <section className="result advisor-result chat" aria-live="polite" data-origin="consejero: respuesta en curso (conversar)">
          {plan?.detail && <p className="muted small plan">{plan.detail}</p>}
          {progress && <p className="muted small" role="status">{progress}</p>}
          {visible(text) && (
            <div className="markdown">
              <ReactMarkdown>{visible(text)}</ReactMarkdown>
            </div>
          )}
          {running && !text && !progress && <p className="muted">Pensando…</p>}
          {cards && cards.length > 0 && (
            <ul className="proposals">
              {cards.map((o, k) => (
                <ProposalCard key={k} o={o} tag={labels?.[k]} label={label} onGoTo={p.onGoTo} />
              ))}
            </ul>
          )}
          {notice && <p className="notice">{notice}</p>}
          {!running && (parts || usage) && <UsageLine parts={parts} usage={usage} />}
        </section>
      ) : (        <section className="result advisor-result" aria-live="polite" data-origin="consejero: respuesta en curso (estado last/text de AdvisorConsult)">
          {plan && (
            <p className="muted small plan">
              {last.question ? "Entendí la pregunta como: " : ""}
              <strong>{plan.label}</strong>
              {plan.detail ? ` · ${plan.detail}` : ""}
            </p>
          )}
          {progress && <p className="muted small" role="status">{progress}</p>}
          {rounds.length > 0 && (
            <ul className="rounds muted small" aria-label="Lectura profunda">
              {rounds.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {visible(text) && (
            <div className="markdown">
              <ReactMarkdown>{visible(text)}</ReactMarkdown>
            </div>
          )}
          {running && !text && !progress && <p className="muted">Pensando…</p>}
          {cards && cards.length > 0 && (
            <ul className="observations">
              {cards.map((o, k) => (
                <ObservationCard key={k} o={o} label={label} onGoTo={p.onGoTo} onSendToAssistant={p.onSendToAssistant} tag={labels?.[k]} />
              ))}
            </ul>
          )}
          {invalid && <p className="notice small">Las observaciones llegaron mal formadas y no se muestran; el texto sí.</p>}
          {notice && <p className="notice">{notice}</p>}
          {material && <MaterialLine items={material.items} rounds={material.rounds} />}
          {!running && (parts || usage) && <UsageLine parts={parts} usage={usage} />}
        </section>
      
      ));

  return (
    <div className={`consult${conversing ? " conversing" : ""}`}>
      <div className="conversation-bar">
        <select
          aria-label="Conversación"
          value={conversationId ?? ""}
          disabled={running}
          onChange={(e) => open(e.target.value || null)}
        >
          <option value="">Nueva conversación</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || "Sin título"}
            </option>
          ))}
        </select>
        {conversationId && (
          <>
            <button className="link small" disabled={running} onClick={() => open(null)}>
              Nueva
            </button>
            <button
              className="link small danger"
              disabled={running}
              onClick={async () => {
                if (!confirm("¿Eliminar esta conversación? Las observaciones guardadas se conservan.")) return;
                await api(`/api/conversations/${conversationId}`, { method: "DELETE" });
                await open(null);
                await loadList();
              }}
            >
              Eliminar
            </button>
          </>
        )}
      </div>
      {history.length > 0 && (
        <ol className="history" aria-label="Conversación" data-origin="consejero: historial (conversación guardada)">
          {history.map((m, k) =>
            m.role === "author" ? (
              <li key={m.id} className="turn author">
                {m.context?.anchor && <span className="turn-anchor small">sobre {m.context.anchor.label}</span>}
                {m.content}
              </li>
            ) : m.context?.mode === "conversar" ? (
              <li key={m.id} className="turn advisor chat">
                {m.content && (
                  <div className="markdown">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                )}
                {m.observations.length > 0 && (
                  <ul className="proposals">
                    {m.observations.map((o) => (
                      <ProposalCard
                        key={o.id}
                        o={o}
                        tag={tags.get(o.id)}
                        label={label}
                        onGoTo={p.onGoTo}
                        onChanged={update}
                        busy={running || !p.provider}
                        onDevelop={develop}
                        onHandoff={(x) => handoff(x.id)}
                      />
                    ))}
                  </ul>
                )}
                {m === lastAdvisor && m.context?.parts && <UsageLine parts={m.context.parts} usage={m.context.usage ?? null} />}
              </li>
            ) : (
              <li key={m.id} className="turn advisor">
                {m.context?.plan && (
                  <p className="muted small plan">
                    {history[k - 1]?.content !== m.context.plan.label ? "Entendí la pregunta como: " : ""}
                    <strong>{m.context.plan.label}</strong>
                    {m.context.plan.detail ? ` · ${m.context.plan.detail}` : ""}
                  </p>
                )}
                {m.content && (
                  <div className="markdown">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                )}
                {m.observations.length > 0 && (
                  <ul className="observations">
                    {m.observations.map((o) => (
                      <ObservationCard
                        key={o.id}
                        o={o}
                        label={label}
                        onGoTo={p.onGoTo}
                        onSendToAssistant={p.onSendToAssistant}
                        actions={actions}
                        tag={tags.get(o.id)}
                        onFollow={running || !p.provider ? undefined : follow}
                      />
                    ))}
                  </ul>
                )}
                {m.context?.material && <MaterialLine items={m.context.material} rounds={m.context.rounds} />}
                {m === lastAdvisor && m.context?.parts && <UsageLine parts={m.context.parts} usage={m.context.usage ?? null} />}
              </li>
            ),
          )}
        </ol>
      )}
      <div className="mode-switch" role="group" aria-label="Modo del Consejero">
        {(
          [
            ["conversar", "Conversar", "Un compañero: respuestas breves, una propuesta, tus decisiones como dirección"],
            ["analizar", "Analizar", "La evaluación completa: observaciones con citas, coherencia, ritmo, cabos y alternativas"],
          ] as const
        ).map(([id, text, hint]) => (
          <button key={id} className={mode === id ? "on" : undefined} aria-pressed={mode === id} title={hint} disabled={running} onClick={() => setMode(id)}>
            {text}
          </button>
        ))}
      </div>
      {conversing ? (
        <div className="advisor-quick" role="group" aria-label="Acciones del Consejero">
          <p className="quick-row">
            {(
              [
                [ADVISOR_ACTIONS.find((a) => a.id === "seguir")!, "¿Cómo continúo?"],
                [ADVISOR_ACTIONS.find((a) => a.id === "caminos")!, "Dame opciones"],
                [ADVISOR_ACTIONS.find((a) => a.id === "giro")!, "Necesito un giro"],
                [ADVISOR_ACTIONS.find((a) => a.id === "consecuencias")!, "¿Qué pasa si…?"],
              ] as const
            ).map(([a, text]) => (
              <button key={a.id} className="quick" title={a.hint} disabled={running || !p.provider} onClick={quick(a)}>
                {text}
              </button>
            ))}
          </p>
        </div>
      ) : (
      <div className="advisor-quick" role="group" aria-label="Acciones del Consejero">
        <p className="quick-row">
          <span className="quick-label muted small">Pensar juntos</span>
          {creative.map((a) => (
            <button key={a.id} className="quick" title={a.hint} disabled={running || !p.provider} onClick={quick(a)}>
              {a.label}
            </button>
          ))}
        </p>
        <p className="quick-row">
          <span className="quick-label muted small">Revisar</span>
          {review.map((a) => (
            <button key={a.id} className="quick" title={a.hint} disabled={running || !p.provider} onClick={quick(a)}>
              {a.label}
            </button>
          ))}
        </p>
      </div>
      )}
      {!conversing && p.selection && (
        <label className="check small">
          <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} />
          <span>Sobre la selección (Analizar, Coherencia y Subir tensión)</span>
        </label>
      )}
      {!conversing && (
      <label className="check small" title="Si lo necesita, el Consejero pide fichas, pasajes o capítulos concretos, con límites. Nunca la novela completa.">
        <input
          type="checkbox"
          checked={deep}
          onChange={(e) => {
            setDeep(e.target.checked);
            writePref("deepReading", e.target.checked ? "1" : "0");
          }}
        />
        <span>Lectura profunda: puede pedir más material si lo necesita</span>
      </label>
      )}
      {conversing && (decided.decisions.length > 0 || decided.discarded.length > 0 || conversationId) && (
        <details className="plan-bar" open={decided.decisions.length > 0 || decided.discarded.length > 0}>
          <summary className="small">
            Decidido en esta conversación{decided.decisions.length ? ` (${decided.decisions.length})` : ""}
            {decided.discarded.length ? ` · descartado (${decided.discarded.length})` : ""}
          </summary>
          <ul className="small">
            {decided.decisions.map((d, i) => (
              <li key={`d${i}`}>
                {d.text}{" "}
                <button className="link small" title="Ya no es una decisión" aria-label={`Quitar decisión: ${d.text}`} onClick={() => removeFrom("decisions", d)}>
                  ✕
                </button>{" "}
                <button
                  className="link small"
                  title="Añadir a Memoria como hecho sugerido (no es canon hasta que lo apruebes)"
                  onClick={async () => {
                    const f = await api<Fact>(`/api/novels/${p.novelId}/memory/facts`, { method: "POST", json: { text: d.text, status: "suggested" } });
                    p.onFactAdded(f);
                  }}
                >
                  A Memoria
                </button>
              </li>
            ))}
            {decided.discarded.map((d, i) => (
              <li key={`x${i}`} className="muted">
                Descartado: {d.text}{" "}
                <button className="link small" aria-label={`Quitar descartado: ${d.text}`} onClick={() => removeFrom("discarded", d)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {conversationId && (
            <form
              className="plan-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (newDecision.trim()) planEdit({ add: newDecision.trim() }).then(() => setNewDecision(""));
              }}
            >
              <input value={newDecision} onChange={(e) => setNewDecision(e.target.value)} placeholder="Añadir una decisión…" aria-label="Nueva decisión" />
            </form>
          )}
        </details>
      )}
      {brief && (
        <div className="brief-box" data-origin="consejero: encargo para el Asistente">
          {brief.loading && <p className="muted small" role="status">Preparando el encargo para el Asistente…</p>}
          {brief.error && (
            <p className="error small">
              {brief.error}{" "}
              <button className="link small" onClick={() => setBrief(null)}>
                Cerrar
              </button>
            </p>
          )}
          {brief.data && (
            <SceneBriefEditor
              brief={brief.data}
              memory={p.memory}
              onCancel={() => setBrief(null)}
              onSend={(b) => {
                setBrief(null);
                p.onSendBrief(b);
              }}
            />
          )}
        </div>
      )}
      {conversing && liveResult}
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {focus && (
          <p className="focus-chip small" aria-live="polite">
            Desarrollando <strong>{focus.label}</strong> «{focus.title}» ·{" "}
            <button type="button" className="link small" disabled={running} onClick={() => setReleased(true)} title="Tu próximo mensaje no será sobre esta propuesta">
              Soltar
            </button>
          </p>
        )}
        <textarea
          ref={input}
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            conversing
              ? conversationId
                ? "Sigue la conversación… Ej.: Me gusta, desarróllala. · Envíala al Asistente."
                : "Cuéntale al Consejero… Ej.: No sé cómo seguir. · Quiero que Waldo haya sido novio de Pola."
              : conversationId
                ? "Sigue la conversación… Ej.: Me gusta el segundo, pero quiero que aparezca Nacho."
                : "Piensa con el Consejero… Ej.: No sé cómo continuar. · ¿Qué pasa si Elena descubre la carta?"
          }
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
              {conversing ? "Enviar" : "Preguntar"}
            </button>
          )}
        </div>
      </form>
      {!p.provider && <p className="error">No hay proveedor de IA configurado.</p>}

      {!conversing && liveResult}
      {last && !running && others.length > 0 && (
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
    </div>
  );
}
