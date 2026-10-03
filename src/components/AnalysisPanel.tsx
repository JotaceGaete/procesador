"use client";

import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ACTIONS, PROVIDER_LABELS, type AnalysisAction, type AnalysisEvent, type Character, type ProviderId } from "@/lib/types";
import { estimateTokens } from "@/lib/ai/context";
import { readPref, writePref } from "@/lib/client";
import type { Selection } from "./Workspace";

interface Props {
  hidden: boolean;
  onClose: () => void;
  getContent: () => string;
  manuscriptChars: number;
  selection: Selection | null;
  characters: Character[];
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  onApply: (original: Selection, rewrite: string) => boolean;
}

type Notice = { kind: "refusal" | "error" | "truncated"; message: string } | null;

const OPEN_TAG = "<reescritura>";
const REWRITE_RE = /<reescritura>([\s\S]*?)(?:<\/reescritura>|$)/;

/** Hides a half-streamed opening tag at the end of the text. */
function trimPartialTag(text: string) {
  for (let n = OPEN_TAG.length - 1; n > 0; n--) {
    if (text.endsWith(OPEN_TAG.slice(0, n))) return text.slice(0, -n);
  }
  return text;
}

/** Splits the model output into commentary and the proposed rewrite (if any). */
function splitOutput(output: string) {
  const match = output.match(REWRITE_RE);
  if (!match || match.index === undefined) return { notes: trimPartialTag(output), rewrite: null, complete: false };
  return {
    notes: output.slice(0, match.index) + output.slice(match.index + match[0].length),
    rewrite: match[1].trim(),
    complete: output.includes("</reescritura>"),
  };
}

function formatTokens(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000).toLocaleString("es")} mil` : String(n);
}

function AnalysisPanel(props: Props) {
  const { hidden, onClose, getContent, manuscriptChars, selection, characters, providers, defaultProvider, onApply } = props;

  const [action, setAction] = useState<AnalysisAction>("redaccion");
  const [characterId, setCharacterId] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [includeManuscript, setIncludeManuscript] = useState(false);

  const [output, setOutput] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [running, setRunning] = useState(false);
  const [target, setTarget] = useState<Selection | null>(null);
  const [usedProvider, setUsedProvider] = useState<ProviderId | null>(null);
  const [applied, setApplied] = useState<"" | "ok" | "missing">("");
  const abortRef = useRef<AbortController | null>(null);

  const current = ACTIONS.find((a) => a.id === action)!;
  const character = characters.find((c) => c.id === characterId) ?? null;

  useEffect(() => {
    const saved = readPref("provider") as ProviderId | null;
    if (saved && providers.includes(saved)) setProvider(saved);
  }, [providers]);

  // Keep the character choice valid; pick one automatically when the action needs it.
  useEffect(() => {
    if (characterId && !characters.some((c) => c.id === characterId)) setCharacterId("");
    else if (!characterId && current.character === "required" && characters.length) setCharacterId(characters[0].id);
  }, [characters, characterId, current.character]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run(sel: Selection, using: ProviderId) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOutput("");
    setNotice(null);
    setApplied("");
    setTarget(sel);
    setUsedProvider(using);
    setRunning(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action,
          characterId: characterId || null,
          content: getContent(),
          selectionStart: sel.start,
          selectionEnd: sel.end,
          includeManuscript,
          provider: using,
        }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AnalysisEvent;
          if (event.type === "text") setOutput((o) => o + event.text);
          else if (event.type === "refusal") setNotice({ kind: "refusal", message: event.message });
          else if (event.type === "error") setNotice({ kind: "error", message: event.message });
          else if (event.type === "truncated") setNotice({ kind: "truncated", message: "La respuesta se cortó por longitud." });
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNotice({ kind: "error", message: (e as Error).message });
    } finally {
      if (abortRef.current === controller) setRunning(false);
    }
  }

  const { notes, rewrite, complete } = splitOutput(output);
  const otherProvider = providers.find((p) => p !== usedProvider) ?? null;
  const canRun = Boolean(selection && provider && !running && (current.character !== "required" || character));
  const manuscriptTokens = estimateTokens(manuscriptChars);

  return (
    <aside className="panel" hidden={hidden} aria-label="Análisis">
      <header className="panel-head">
        <span className="panel-title">Análisis</span>
        <span className="spacer" />
        <button className="link" onClick={onClose}>
          Ocultar
        </button>
      </header>

      <nav className="tabs" aria-label="Tipo de análisis">
        {ACTIONS.map((a) => (
          <button key={a.id} className={a.id === action ? "on" : undefined} onClick={() => setAction(a.id)}>
            {a.label}
          </button>
        ))}
      </nav>

      <div className="controls">
        <label>
          <span>Personaje</span>
          {characters.length ? (
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
              {current.character === "optional" && <option value="">Ninguno en particular</option>}
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">Sin personajes</span>
          )}
        </label>
        {providers.length > 1 && (
          <label>
            <span>Modelo</span>
            <select
              value={provider ?? ""}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                writePref("provider", e.target.value);
              }}
            >
              {providers.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label
          className="check"
          title="Por defecto se envían la selección, el texto cercano, la sinopsis, las notas de estilo, las fichas relevantes y, para consistencia y evolución, los pasajes donde aparece el personaje."
        >
          <input type="checkbox" checked={includeManuscript} onChange={(e) => setIncludeManuscript(e.target.checked)} />
          <span>
            Incluir manuscrito completo
            {manuscriptChars > 0 && <span className="muted"> · ≈{formatTokens(manuscriptTokens)} tokens más por consulta</span>}
          </span>
        </label>
      </div>

      <blockquote className={`quote${selection ? "" : " empty"}`}>
        {selection
          ? selection.text.length > 400
            ? `${selection.text.slice(0, 400)}…`
            : selection.text
          : "Selecciona un fragmento en el editor."}
      </blockquote>

      {!provider && <p className="error">No hay proveedor de IA configurado.</p>}
      {current.character === "required" && !characters.length && (
        <p className="muted small">Esta acción necesita la ficha de un personaje.</p>
      )}

      <div className="run">
        <button className="btn primary" onClick={() => selection && provider && run(selection, provider)} disabled={!canRun}>
          {running ? "Analizando…" : "Analizar"}
        </button>
        {running && (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Detener
          </button>
        )}
      </div>

      {(output || running || notice) && (
        <section className="result" aria-live="polite">
          {notes.trim() && (
            <div className="markdown">
              <ReactMarkdown>{notes}</ReactMarkdown>
            </div>
          )}
          {running && !output && <p className="muted">Pensando…</p>}

          {rewrite !== null && target && (
            <div className="compare">
              <h3>Original</h3>
              <p className="prose">{target.text}</p>
              <h3>Propuesta</h3>
              <p className="prose">{rewrite}</p>
              {complete && (
                <div className="compare-actions">
                  <button
                    className="btn primary"
                    disabled={applied === "ok"}
                    onClick={() => setApplied(onApply(target, rewrite) ? "ok" : "missing")}
                  >
                    {applied === "ok" ? "Reemplazado · Ctrl/⌘+Z para deshacer" : "Reemplazar selección"}
                  </button>
                  <button className="btn ghost" onClick={() => navigator.clipboard.writeText(rewrite)}>
                    Copiar
                  </button>
                </div>
              )}
              {applied === "missing" && (
                <p className="error small">El fragmento original ya no está en el texto. Copia la propuesta y pégala a mano.</p>
              )}
            </div>
          )}

          {notice && (
            <p className={`notice ${notice.kind}`}>
              {notice.message}
              {notice.kind === "refusal" && otherProvider && target && (
                <>
                  {" "}
                  <button
                    className="link"
                    onClick={() => {
                      setProvider(otherProvider);
                      run(target, otherProvider);
                    }}
                  >
                    Probar con {PROVIDER_LABELS[otherProvider]}
                  </button>
                </>
              )}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}

export default memo(AnalysisPanel);
