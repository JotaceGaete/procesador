"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ACTIONS, type AnalysisAction, type Character, type ProviderId } from "@/lib/types";
import type { Selection } from "./Workspace";

interface Props {
  content: string;
  selection: Selection | null;
  characters: Character[];
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  onApply: (original: Selection, rewrite: string) => boolean;
}

const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: "Claude", xai: "Grok" };
const OPEN_TAG = "<reescritura>";
const REWRITE_RE = /<reescritura>([\s\S]*?)(?:<\/reescritura>|$)/;

/** Hides a half-streamed opening tag at the end of the text. */
function trimPartialTag(text: string) {
  for (let n = OPEN_TAG.length - 1; n > 0; n--) {
    if (text.endsWith(OPEN_TAG.slice(0, n))) return text.slice(0, -n);
  }
  return text;
}

/** Splits the model output into commentary and the rewritten fragment (if any). */
function splitOutput(output: string) {
  const match = output.match(REWRITE_RE);
  if (!match) return { notes: trimPartialTag(output), rewrite: null, complete: false };
  return {
    notes: output.slice(0, match.index) + output.slice(match.index! + match[0].length),
    rewrite: match[1].trim(),
    complete: output.includes("</reescritura>"),
  };
}

export default function AnalysisPanel({ content, selection, characters, providers, defaultProvider, onApply }: Props) {
  const [action, setAction] = useState<AnalysisAction>("redaccion");
  const [characterId, setCharacterId] = useState<string>("");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [includeManuscript, setIncludeManuscript] = useState(true);

  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState<"" | "ok" | "missing">("");
  const [target, setTarget] = useState<Selection | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const current = ACTIONS.find((a) => a.id === action)!;

  // Pick a character automatically when it's needed and none is chosen.
  useEffect(() => {
    if (!characterId && characters.length && current.needsCharacter) setCharacterId(characters[0].id);
    if (characterId && !characters.some((c) => c.id === characterId)) setCharacterId("");
  }, [characters, characterId, current.needsCharacter]);

  async function run() {
    if (!selection || !provider) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOutput("");
    setError("");
    setApplied("");
    setTarget(selection);
    setRunning(true);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action,
          characterId: characterId || null,
          content,
          selectionStart: selection.start,
          selectionEnd: selection.end,
          includeManuscript,
          provider,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setOutput((o) => o + value);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const { notes, rewrite, complete } = splitOutput(output);
  const needsCharacterMissing = current.needsCharacter && !characterId;
  const canRun = Boolean(selection && provider && !running && !needsCharacterMissing);

  return (
    <aside className="analysis">
      <h2>Análisis</h2>

      <div className="actions">
        {ACTIONS.map((a) => (
          <button key={a.id} className={`chip${a.id === action ? " active" : ""}`} onClick={() => setAction(a.id)}>
            {a.label}
          </button>
        ))}
      </div>

      {(current.needsCharacter || action === "dialogo") && (
        <label className="field">
          <span>Personaje{current.needsCharacter ? "" : " (opcional)"}</span>
          {characters.length ? (
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
              {!current.needsCharacter && <option value="">— Ninguno en particular —</option>}
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted small">Crea un personaje en la barra izquierda.</span>
          )}
        </label>
      )}

      <div className="options">
        {providers.length > 1 && (
          <label className="field inline">
            <span>Modelo</span>
            <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value as ProviderId)}>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check" title="Envía todo el texto como contexto. Más preciso para consistencia, más tokens.">
          <input type="checkbox" checked={includeManuscript} onChange={(e) => setIncludeManuscript(e.target.checked)} />
          Incluir manuscrito completo
        </label>
      </div>

      <div className={`selection-preview${selection ? "" : " empty"}`}>
        {selection ? (
          <>
            <span className="muted small">Selección · {selection.text.trim().split(/\s+/).length} palabras</span>
            <p>{selection.text.length > 280 ? `${selection.text.slice(0, 280)}…` : selection.text}</p>
          </>
        ) : (
          <span className="muted small">Selecciona un párrafo en el editor.</span>
        )}
      </div>

      {!provider && <p className="error">No hay proveedor de IA configurado (ANTHROPIC_API_KEY o XAI_API_KEY).</p>}

      <div className="run-row">
        <button className="btn primary" onClick={run} disabled={!canRun}>
          {running ? "Analizando…" : current.label}
        </button>
        {running && (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Detener
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {(output || running) && (
        <div className="result">
          <div className="markdown">
            <ReactMarkdown>{notes}</ReactMarkdown>
            {running && <span className="cursor">▍</span>}
          </div>
          {rewrite !== null && (
            <div className="rewrite">
              <div className="rewrite-head">
                <span className="muted small">Versión propuesta</span>
                {complete && target && (
                  <span className="rewrite-actions">
                    <button className="btn ghost small" onClick={() => navigator.clipboard.writeText(rewrite)}>
                      Copiar
                    </button>
                    <button
                      className="btn primary small"
                      disabled={applied === "ok"}
                      onClick={() => setApplied(onApply(target, rewrite) ? "ok" : "missing")}
                    >
                      {applied === "ok" ? "Aplicado ✓" : "Reemplazar selección"}
                    </button>
                  </span>
                )}
              </div>
              <p className="rewrite-text">{rewrite}</p>
              {applied === "missing" && (
                <p className="error small">El fragmento original ya no está en el texto; copia la versión y pégala a mano.</p>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
