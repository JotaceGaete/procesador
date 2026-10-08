"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, noticeLock } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { ReadingState, ChapterReading } from "@/lib/advisor/reading";
import {
  THREAD_KINDS,
  THREAD_STATUS_LABELS,
  type Memory,
  type ProviderId,
  type StoryThread,
  type ThreadKind,
} from "@/lib/types";
import { formatTokens } from "./format";

interface Props {
  novelId: string;
  chapterId: string;
  memory: Memory;
  provider: ProviderId | null;
  /** Saves the open chapter: a reading is always of the saved text. */
  flush(): Promise<boolean>;
  onAutoDigest(on: boolean): void;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
}

const STATUS: Record<ChapterReading["status"], string> = {
  current: "Al día",
  touched: "Al día, con retoques",
  stale: "Desactualizada",
  missing: "Sin leer",
};
const CHANGE: Record<string, string> = { opened: "se abre", advanced: "avanza", closed: "se cierra" };

/**
 * Cabos y lecturas (docs/consejero.md, phase 2): the reading of the novel, chapter by
 * chapter, its threads and the global summary. An index for reading, never a second
 * Memory; every quote is checked against the text and can be followed with "Ir".
 */
export default function AdvisorReading(props: Props) {
  const { novelId, chapterId, memory, provider, flush, onAutoDigest, onGoTo } = props;
  const [state, setState] = useState<ReadingState | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<ReadingState>(`/api/novels/${novelId}/reading`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [novelId]);

  useEffect(() => {
    load();
  }, [load, chapterId, memory]);
  useEffect(() => () => abort.current?.abort(), []);

  if (!state) return <p className="muted small">{error || "Cargando la lectura…"}</p>;

  const names = new Map([...memory.characters].map((c) => [c.id, c.name]));
  const index = new Map(state.chapters.map((c, i) => [c.id, i]));
  const label = (id: string | null) => (id && index.has(id) ? chapterLabel(index.get(id)!, state.chapters[index.get(id)!].title) : "—");
  const upToDate = state.chapters.filter((c) => c.status === "current" || c.status === "touched").length;
  // Never read, or changed substantially; the author's corrections are left alone.
  const pending = state.chapters.filter(
    (c) => (c.status === "missing" || (c.status === "stale" && !c.digest?.author_edited)) && c.words > 0,
  );
  const needsGlobal = !state.novel || state.novel.status === "stale" || pending.length > 0;
  const total = pending.reduce((n, c) => n + c.estimate, 0) + (needsGlobal ? state.novelEstimate : 0);

  async function call(path: string, body: unknown, signal?: AbortSignal) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) window.location.href = "/login";
    await noticeLock(res);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
  }

  /** Reads the given chapters one by one (one request each), then the global summary. */
  async function read(list: ChapterReading[], opts: { global: boolean; force?: boolean }) {
    if (!provider) return;
    const size = list.reduce((n, c) => n + c.estimate, 0) + (opts.global ? state!.novelEstimate : 0);
    if (size > state!.confirmTokens && !confirm(`Leer ${list.length} capítulos enviará unos ${formatTokens(size)} tokens. ¿Continuar?`))
      return;
    if (list.some((c) => c.id === chapterId) && !(await flush())) {
      setError("No se pudo guardar el capítulo abierto; no se leyó.");
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setError("");
    try {
      for (const [i, c] of list.entries()) {
        setProgress(`Leyendo ${chapterLabel(index.get(c.id)!, c.title)} (${i + 1} de ${list.length})…`);
        await call(`/api/chapters/${c.id}/digest`, { provider, force: opts.force }, controller.signal);
      }
      if (opts.global) {
        setProgress("Rehaciendo el resumen global…");
        await call(`/api/novels/${novelId}/digest`, { provider }, controller.signal);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setProgress(null);
      abort.current = null;
      await load();
    }
  }

  async function patchThread(t: StoryThread, patch: Record<string, unknown>) {
    try {
      await api(`/api/threads/${t.id}`, { method: "PATCH", json: patch });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  }

  const busy = progress !== null;

  return (
    <div className="advisor-reading">
      <section aria-label="Lectura de la novela" className="reading-head">
        <p>
          <strong>
            {upToDate} de {state.chapters.length}
          </strong>{" "}
          capítulos leídos y al día.
        </p>
        {busy ? (
          <p className="muted small" role="status">
            {progress}{" "}
            <button className="link" onClick={() => abort.current?.abort()}>
              Detener
            </button>
          </p>
        ) : (
          (pending.length > 0 || needsGlobal) && (
            <button
              className="btn"
              disabled={!provider || upToDate + pending.length === 0}
              onClick={() => read(pending, { global: true })}
            >
              {pending.length ? `Actualizar la lectura (${pending.length} cap.)` : "Rehacer el resumen global"} · ≈
              {formatTokens(total)} tokens
            </button>
          )
        )}
        <label className="check small">
          <input
            type="checkbox"
            checked={state.auto}
            onChange={async (e) => {
              const on = e.target.checked;
              setState({ ...state, auto: on });
              await api(`/api/novels/${novelId}`, { method: "PATCH", json: { auto_digest: on } }).catch((x: Error) =>
                setError(x.message),
              );
              onAutoDigest(on);
            }}
          />
          <span>Releer un capítulo al dejarlo, si cambió de forma sustancial</span>
        </label>
        {error && <p className="error small">{error}</p>}
      </section>

      <section aria-label="Resumen global">
        <h3>Resumen global</h3>
        {state.novel ? (
          <>
            {state.novel.status === "stale" && (
              <p className="notice small">Hecho con fichas anteriores: alguna cambió desde entonces.</p>
            )}
            <details>
              <summary className="small">Leer el resumen</summary>
              <p className="prose small-prose">{state.novel.summary}</p>
            </details>
          </>
        ) : (
          <p className="muted small">Aún no hay resumen global.</p>
        )}
      </section>

      <section aria-label="Cabos">
        <h3>Cabos</h3>
        {state.threads.length ? (
          <ul className="threads">
            {state.threads.map((t) => (
              <ThreadItem
                key={t.id}
                thread={t}
                others={state.threads.filter((x) => x.id !== t.id)}
                label={label}
                disabled={busy}
                onPatch={(p) => patchThread(t, p)}
                onMerge={async (into) => {
                  await api(`/api/threads/${t.id}/merge`, { method: "POST", json: { into } }).catch((x: Error) =>
                    setError(x.message),
                  );
                  await load();
                }}
                onDelete={async () => {
                  if (!confirm(`¿Eliminar el cabo «${t.title}»?`)) return;
                  await api(`/api/threads/${t.id}`, { method: "DELETE" }).catch((x: Error) => setError(x.message));
                  await load();
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="muted small">Sin cabos todavía. Aparecen al leer los capítulos, o puedes añadirlos.</p>
        )}
        <NewThread
          onAdd={async (title, kind) => {
            await api(`/api/novels/${novelId}/threads`, { method: "POST", json: { title, kind } }).catch((x: Error) =>
              setError(x.message),
            );
            await load();
          }}
        />
      </section>

      <section aria-label="Fichas de capítulo">
        <h3>Fichas de capítulo</h3>
        <ol className="digests">
          {state.chapters.map((c, i) => (
            <ChapterItem
              key={c.id}
              chapter={c}
              label={chapterLabel(i, c.title)}
              current={c.id === chapterId}
              names={names}
              threads={state.threads}
              disabled={busy || !provider}
              onRead={() => {
                if (c.digest?.author_edited && !confirm("Esta ficha tiene correcciones tuyas. ¿Releer el capítulo y reemplazarlas?")) return;
                read([c], { global: false, force: c.digest?.author_edited });
              }}
              onEdit={async (summary) => {
                await api(`/api/chapters/${c.id}/digest`, { method: "PATCH", json: { summary } }).catch((x: Error) =>
                  setError(x.message),
                );
                await load();
              }}
              onGoTo={onGoTo}
            />
          ))}
        </ol>
      </section>
    </div>
  );
}

function ThreadItem(p: {
  thread: StoryThread;
  others: StoryThread[];
  label(id: string | null): string;
  disabled: boolean;
  onPatch(patch: Record<string, unknown>): void;
  onMerge(into: string): void;
  onDelete(): void;
}) {
  const t = p.thread;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const kind = THREAD_KINDS.find((k) => k.id === t.kind)?.label ?? "Otro";
  return (
    <li className={`thread ${t.status}${t.confirmed ? "" : " possible"}`}>
      {editing ? (
        <form
          className="inline-edit"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (title.trim() && title !== t.title) p.onPatch({ title });
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Título del cabo" autoFocus />
          <button className="link small">Guardar</button>
        </form>
      ) : (
        <p className="thread-title">
          {t.title}{" "}
          <span className="muted small">
            · {kind} · {THREAD_STATUS_LABELS[t.status]}
            {t.status_by === "author" ? " (tú)" : ""}
          </span>
          {!t.confirmed && <span className="tag">posible cabo</span>}
        </p>
      )}
      <p className="muted small">
        Se abre en {p.label(t.opened_chapter_id)} · última vez en {p.label(t.last_chapter_id)}
        {t.closed_chapter_id ? ` · se cierra en ${p.label(t.closed_chapter_id)}` : ""}
      </p>
      <div className="thread-actions small">
        {!t.confirmed && (
          <button className="link" disabled={p.disabled} onClick={() => p.onPatch({ confirmed: true })}>
            Confirmar
          </button>
        )}
        <button className="link" disabled={p.disabled} onClick={() => setEditing(true)}>
          Renombrar
        </button>
        {t.status === "open" ? (
          <>
            <button className="link" disabled={p.disabled} onClick={() => p.onPatch({ status: "closed" })}>
              Cerrar
            </button>
            <button className="link" disabled={p.disabled} onClick={() => p.onPatch({ status: "abandoned" })}>
              Abandonar
            </button>
          </>
        ) : (
          <button className="link" disabled={p.disabled} onClick={() => p.onPatch({ status: "open" })}>
            Reabrir
          </button>
        )}
        {t.status_by === "author" && (
          <button
            className="link"
            disabled={p.disabled}
            onClick={() => p.onPatch({ status: null })}
            title="El estado vuelve a ser el que indica la lectura de los capítulos"
          >
            Según la lectura
          </button>
        )}
        {p.others.length > 0 && (
          <select
            aria-label="Fusionar con"
            value=""
            disabled={p.disabled}
            onChange={(e) => e.target.value && p.onMerge(e.target.value)}
          >
            <option value="">Fusionar con…</option>
            {p.others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        )}
        <button className="link danger" disabled={p.disabled} onClick={p.onDelete}>
          Eliminar
        </button>
      </div>
    </li>
  );
}

function NewThread({ onAdd }: { onAdd(title: string, kind: ThreadKind): Promise<void> }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ThreadKind>("conflict");
  return (
    <form
      className="new-thread"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await onAdd(title.trim(), kind);
        setTitle("");
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nuevo cabo…" aria-label="Nuevo cabo" />
      <select value={kind} onChange={(e) => setKind(e.target.value as ThreadKind)} aria-label="Tipo">
        {THREAD_KINDS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      <button className="link small" disabled={!title.trim()}>
        Añadir
      </button>
    </form>
  );
}

function Quote(p: { chapterId: string; quote: string; at: { start: number; end: number } | null; onGoTo: Props["onGoTo"] }) {
  if (!p.quote) return <span className="muted small"> · sin cita verificable</span>;
  if (!p.at) return <span className="muted small"> · «{p.quote}» (ya no está en el texto)</span>;
  return (
    <span className="small">
      {" "}
      · «{p.quote}»{" "}
      <button className="link" onClick={() => p.onGoTo(p.chapterId, p.at!.start, p.at!.end, p.quote)} title="Ir al fragmento">
        Ir
      </button>
    </span>
  );
}

function ChapterItem(p: {
  chapter: ChapterReading;
  label: string;
  current: boolean;
  names: Map<string, string>;
  threads: StoryThread[];
  disabled: boolean;
  onRead(): void;
  onEdit(summary: string): Promise<void>;
  onGoTo: Props["onGoTo"];
}) {
  const c = p.chapter;
  const d = c.digest;
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(d?.summary ?? "");
  useEffect(() => setSummary(d?.summary ?? ""), [d?.summary]);
  const thread = (id: string) => p.threads.find((t) => t.id === id)?.title ?? "cabo eliminado";
  return (
    <li className={`digest ${c.status}${p.current ? " open-chapter" : ""}`}>
      <div className="digest-head">
        <span className="map-title">{p.label}</span>
        <span className={`state-badge ${c.status}`}>{STATUS[c.status]}</span>
        {d?.author_edited && <span className="tag">corregida por ti</span>}
        <span className="spacer" />
        <button className="link small" disabled={p.disabled || c.words === 0} onClick={p.onRead}>
          {d ? "Releer" : "Leer"}
        </button>
      </div>
      {d?.author_edited && c.status !== "current" && (
        <p className="notice small">El capítulo cambió: tu corrección puede haber quedado vieja.</p>
      )}
      {d && (
        <details>
          <summary className="small">Ficha</summary>
          {editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await p.onEdit(summary);
                setEditing(false);
              }}
            >
              <textarea rows={6} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Resumen del capítulo" />
              <button className="link small">Guardar</button>{" "}
              <button type="button" className="link small" onClick={() => setEditing(false)}>
                Cancelar
              </button>
            </form>
          ) : (
            <p className="prose small-prose">
              {d.summary}{" "}
              <button className="link small" onClick={() => setEditing(true)}>
                Corregir
              </button>
            </p>
          )}
          {d.events.length > 0 && (
            <>
              <h4>Acontecimientos</h4>
              <ul>
                {d.events.map((e, i) => (
                  <li key={i}>
                    {e.text}
                    {e.characters.length > 0 && (
                      <span className="muted small"> ({e.characters.map((id) => p.names.get(id) ?? "?").join(", ")})</span>
                    )}
                    <Quote chapterId={c.id} quote={e.quote} at={e.at} onGoTo={p.onGoTo} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.presence.length > 0 && (
            <p className="small">
              <span className="muted">En escena: </span>
              {d.presence
                .filter((x) => x.kind === "present")
                .map((x) => p.names.get(x.character))
                .filter(Boolean)
                .join(", ") || "—"}
              {d.presence.some((x) => x.kind === "mentioned") && (
                <>
                  <span className="muted"> · nombrados: </span>
                  {d.presence
                    .filter((x) => x.kind === "mentioned")
                    .map((x) => p.names.get(x.character))
                    .filter(Boolean)
                    .join(", ")}
                </>
              )}
            </p>
          )}
          {d.revelations.length > 0 && (
            <>
              <h4>Revelaciones</h4>
              <ul>
                {d.revelations.map((r, i) => (
                  <li key={i}>
                    {r.text} <span className="muted small">→ {r.to === "lector" ? "el lector" : (p.names.get(r.to) ?? "?")}</span>
                    <Quote chapterId={c.id} quote={r.quote} at={r.at} onGoTo={p.onGoTo} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.threads.length > 0 && (
            <>
              <h4>Cabos</h4>
              <ul>
                {d.threads.map((t, i) => (
                  <li key={i}>
                    {thread(t.thread)} <span className="muted small">{CHANGE[t.change]}</span>
                    <Quote chapterId={c.id} quote={t.quote} at={t.at} onGoTo={p.onGoTo} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {d.notes && <p className="muted small">{d.notes}</p>}
        </details>
      )}
    </li>
  );
}
