"use client";

import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  EDIT_ACTIONS,
  PROVIDER_LABELS,
  SCENE_LENGTHS,
  type AssistEvent,
  type EditAction,
  type Memory,
  type ProviderId,
  type SceneLength,
} from "@/lib/types";
import { estimateTokens } from "@/lib/ai/context";
import { readPref, writePref } from "@/lib/client";
import type { Selection } from "./ChapterEditor";

interface Props {
  hidden: boolean;
  onClose(): void;
  novelId: string;
  chapterId: string;
  memory: Memory;
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  selection: Selection | null;
  novelChars: number;
  getContent(): string;
  getCursor(): number;
  onApply(original: Selection, rewrite: string): boolean;
  onInsert(text: string): void;
}

type Mode = "edit" | "scene";
type Notice = { kind: "refusal" | "error" | "truncated"; message: string } | null;

/** What a run was asked, so "Otra versión" and "Probar con…" repeat it exactly. */
interface Request {
  mode: Mode;
  action: EditAction;
  target: Selection | null;
  body: Record<string, unknown>;
}

/** Above this, a request asks for confirmation before going out. */
const LARGE_CONTEXT_TOKENS = 30_000;

// ---------- output parsing ----------

function between(output: string, tag: string) {
  const open = `<${tag}>`;
  const i = output.indexOf(open);
  if (i === -1) return null;
  const j = output.indexOf(`</${tag}>`, i);
  return {
    start: i,
    end: j === -1 ? output.length : j + tag.length + 3,
    text: output.slice(i + open.length, j === -1 ? undefined : j).trim(),
    complete: j !== -1,
  };
}

/** Hides a half-streamed opening tag at the end of the text. */
function trimPartialTag(text: string, tags: string[]) {
  for (const tag of tags) {
    const open = `<${tag}>`;
    for (let n = open.length - 1; n > 0; n--) if (text.endsWith(open.slice(0, n))) return text.slice(0, -n);
  }
  return text;
}

function parse(output: string, mode: Mode) {
  const main = between(output, mode === "scene" ? "escena" : "reescritura");
  const warning = between(output, "aviso");
  let notes = output;
  for (const part of [warning, main].filter(Boolean).sort((a, b) => b!.start - a!.start)) {
    notes = notes.slice(0, part!.start) + notes.slice(part!.end);
  }
  notes = trimPartialTag(notes, ["reescritura", "escena", "aviso"]).trim();
  // A scene without tags (some models skip them) is still the scene.
  if (mode === "scene" && !main && notes)
    return { notes: "", proposal: notes, complete: false, warning: warning?.text ?? null, untagged: true };
  return {
    notes,
    proposal: main?.text ?? null,
    complete: main?.complete ?? false,
    warning: warning?.text ?? null,
    untagged: false,
  };
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString("es")} mil` : String(n);
}

function AssistantPanel(props: Props) {
  const {
    hidden,
    onClose,
    novelId,
    chapterId,
    memory,
    providers,
    defaultProvider,
    selection,
    novelChars,
    getContent,
    getCursor,
    onApply,
    onInsert,
  } = props;

  const [mode, setMode] = useState<Mode>("edit");
  const [action, setAction] = useState<EditAction>("redaccion");
  const [characterId, setCharacterId] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [includeManuscript, setIncludeManuscript] = useState(false);

  // Scene inputs. The argument draft survives reloads (per novel).
  const [argument, setArgument] = useState("");
  const [sceneCharacters, setSceneCharacters] = useState<string[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [length, setLength] = useState<SceneLength>("media");

  const [output, setOutput] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<(Request & { provider: ProviderId }) | null>(null);
  const [applied, setApplied] = useState<"" | "ok" | "missing" | "inserted">("");
  const [estimate, setEstimate] = useState<{ total: number; manuscript: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const current = EDIT_ACTIONS.find((a) => a.id === action)!;
  const character = memory.characters.find((c) => c.id === characterId) ?? null;

  useEffect(() => {
    const saved = readPref("provider") as ProviderId | null;
    if (saved && providers.includes(saved)) setProvider(saved);
    setArgument(readPref(`argument:${novelId}`) ?? "");
  }, [providers, novelId]);

  useEffect(() => {
    const t = setTimeout(() => writePref(`argument:${novelId}`, argument), 500);
    return () => clearTimeout(t);
  }, [argument, novelId]);

  // Keep choices valid when memory changes; pick a character when the action needs one.
  useEffect(() => {
    const ids = new Set(memory.characters.map((c) => c.id));
    if (characterId && !ids.has(characterId)) setCharacterId("");
    else if (!characterId && current.character === "required" && memory.characters.length)
      setCharacterId(memory.characters[0].id);
    setSceneCharacters((list) => (list.every((id) => ids.has(id)) ? list : list.filter((id) => ids.has(id))));
    if (placeId && !memory.places.some((p) => p.id === placeId)) setPlaceId("");
  }, [memory, characterId, current.character, placeId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function buildRequest(): Request | null {
    const base = { novelId, chapterId, includeManuscript, content: getContent() };
    if (mode === "scene") {
      if (!argument.trim()) return null;
      return {
        mode,
        action,
        target: null,
        body: {
          ...base,
          mode,
          argument,
          length,
          characterIds: sceneCharacters,
          placeIds: placeId ? [placeId] : [],
          cursor: getCursor(),
        },
      };
    }
    if (!selection) return null;
    return {
      mode,
      action,
      target: selection,
      body: {
        ...base,
        mode,
        action,
        characterIds: characterId ? [characterId] : [],
        selectionStart: selection.start,
        selectionEnd: selection.end,
      },
    };
  }

  // Live estimate of what would be sent (dry run on the server, same context builder).
  useEffect(() => {
    if (hidden) return;
    const req = buildRequest();
    if (!req) {
      setEstimate(null);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ ...req.body, dryRun: true }),
        });
        if (res.ok) setEstimate(await res.json());
      } catch {}
    }, 700);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputs that change the context
  }, [
    hidden,
    mode,
    action,
    characterId,
    selection,
    includeManuscript,
    argument,
    sceneCharacters,
    placeId,
    length,
    chapterId,
    memory,
  ]);

  async function run(req: Request, using: ProviderId) {
    const size = estimate?.total ?? 0;
    if (
      size > LARGE_CONTEXT_TOKENS &&
      !confirm(`Esta consulta enviará unos ${formatTokens(size)} tokens de contexto. ¿Continuar?`)
    )
      return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOutput("");
    setNotice(null);
    setApplied("");
    setLast({ ...req, provider: using });
    setRunning(true);

    try {
      const res = await fetch("/api/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        // Always the latest text: "Otra versión" after edits uses what is on screen now.
        body: JSON.stringify({ ...req.body, content: getContent(), provider: using }),
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
          const event = JSON.parse(line) as AssistEvent;
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

  const discard = () => {
    abortRef.current?.abort();
    setOutput("");
    setNotice(null);
    setLast(null);
    setApplied("");
  };

  const showResult = last && last.mode === mode && (output || running || notice);
  const parsed = last ? parse(output, last.mode) : null;
  const others = providers.filter((p) => p !== last?.provider);
  const req = buildRequest();
  const canRun = Boolean(req && provider && !running && (mode === "scene" || current.character !== "required" || character));
  const manuscriptTokens = estimateTokens(novelChars);

  const providerSelect = providers.length > 1 && (
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
  );

  const contextControls = (
    <>
      <label
        className="check"
        title="Por defecto sólo se envía lo relevante: el texto cercano, la Guía Maestra y la memoria de quienes intervienen."
      >
        <input type="checkbox" checked={includeManuscript} onChange={(e) => setIncludeManuscript(e.target.checked)} />
        <span>
          Incluir la novela completa
          {novelChars > 0 && <span className="muted"> · ≈{formatTokens(manuscriptTokens)} tokens más por consulta</span>}
        </span>
      </label>
      {estimate && (
        <p className={`estimate${estimate.total > LARGE_CONTEXT_TOKENS ? " large" : ""}`}>
          Contexto de esta consulta: ≈{formatTokens(estimate.total)} tokens
        </p>
      )}
    </>
  );

  return (
    <aside className="panel" hidden={hidden} aria-label="Asistente">
      <header className="panel-head">
        <span className="panel-title">Asistente</span>
        <span className="spacer" />
        <button className="link" onClick={onClose}>
          Ocultar
        </button>
      </header>

      <nav className="tabs" aria-label="Modo">
        <button className={mode === "edit" ? "on" : undefined} onClick={() => setMode("edit")}>
          Editar selección
        </button>
        <button className={mode === "scene" ? "on" : undefined} onClick={() => setMode("scene")}>
          Escribir escena
        </button>
      </nav>

      {mode === "edit" ? (
        <>
          <div className="actions" role="group" aria-label="Acción">
            {EDIT_ACTIONS.map((a) => (
              <button
                key={a.id}
                className={a.id === action ? "on" : undefined}
                onClick={() => setAction(a.id)}
                aria-pressed={a.id === action}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="controls">
            <label>
              <span>Personaje</span>
              {memory.characters.length ? (
                <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                  {current.character === "optional" && <option value="">Ninguno en particular</option>}
                  {memory.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted">Sin personajes en la memoria</span>
              )}
            </label>
            {providerSelect}
            {contextControls}
          </div>
          <blockquote className={`quote${selection ? "" : " empty"}`}>
            {selection
              ? selection.text.length > 400
                ? `${selection.text.slice(0, 400)}…`
                : selection.text
              : "Selecciona un fragmento en el editor."}
          </blockquote>
          {current.character === "required" && !memory.characters.length && (
            <p className="muted small">Esta acción necesita la ficha de un personaje.</p>
          )}
        </>
      ) : (
        <>
          <label className="argument">
            <span>Argumento</span>
            <textarea
              rows={6}
              value={argument}
              onChange={(e) => setArgument(e.target.value)}
              placeholder="Qué ocurre en la escena. Ej.: Es 1972. Juan llega de madrugada. Elena sabe que estuvo con Marta, pero no quiere demostrarlo…"
            />
          </label>
          <div className="controls">
            {memory.characters.length > 0 && (
              <fieldset className="checks inline">
                <legend>En escena</legend>
                {memory.characters.map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={sceneCharacters.includes(c.id)}
                      onChange={(e) => setSceneCharacters((l) => (e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id)))}
                    />
                    {c.name}
                  </label>
                ))}
              </fieldset>
            )}
            {memory.places.length > 0 && (
              <label>
                <span>Lugar</span>
                <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
                  <option value="">Según el argumento</option>
                  {memory.places.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>Extensión</span>
              <select value={length} onChange={(e) => setLength(e.target.value as SceneLength)}>
                {SCENE_LENGTHS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                    {l.words ? ` (~${l.words} palabras)` : ""}
                  </option>
                ))}
              </select>
            </label>
            {providerSelect}
            {contextControls}
          </div>
          <p className="muted small">
            Los personajes y lugares nombrados en el argumento se incluyen solos. La escena se escribe para la posición del
            cursor.
          </p>
        </>
      )}

      {!provider && <p className="error">No hay proveedor de IA configurado.</p>}

      <div className="run">
        <button className="btn primary" onClick={() => req && provider && run(req, provider)} disabled={!canRun}>
          {running
            ? mode === "scene"
              ? "Escribiendo…"
              : "Analizando…"
            : mode === "scene"
              ? "Desarrollar escena"
              : current.rewrites
                ? "Proponer cambios"
                : "Analizar"}
        </button>
        {running && (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Detener
          </button>
        )}
      </div>

      {showResult && parsed && last && (
        <section className="result" aria-live="polite">
          {parsed.notes && (
            <div className="markdown">
              <ReactMarkdown>{parsed.notes}</ReactMarkdown>
            </div>
          )}
          {running && !output && <p className="muted">{last.mode === "scene" ? "Escribiendo…" : "Pensando…"}</p>}

          {parsed.proposal !== null && (
            <div className="compare">
              {last.mode === "edit" && last.target && (
                <>
                  <h3>Original</h3>
                  <p className="prose">{last.target.text}</p>
                </>
              )}
              <h3>Propuesta</h3>
              <p className="prose">{parsed.proposal}</p>
              {parsed.warning && <p className="notice">Aviso: {parsed.warning}</p>}
            </div>
          )}

          {notice && <p className={`notice ${notice.kind}`}>{notice.message}</p>}

          {!running && (
            <div className="compare-actions">
              {parsed.proposal && (parsed.complete || parsed.untagged) && last.mode === "edit" && last.target && (
                <button
                  className="btn primary"
                  disabled={applied === "ok"}
                  onClick={() => setApplied(onApply(last.target!, parsed.proposal!) ? "ok" : "missing")}
                >
                  {applied === "ok" ? "Reemplazado · Ctrl/⌘+Z deshace" : "Reemplazar selección"}
                </button>
              )}
              {parsed.proposal && (parsed.complete || parsed.untagged) && last.mode === "scene" && (
                <button
                  className="btn primary"
                  disabled={applied === "inserted"}
                  onClick={() => {
                    onInsert(parsed.proposal!);
                    setApplied("inserted");
                  }}
                >
                  {applied === "inserted" ? "Insertada · Ctrl/⌘+Z deshace" : "Insertar en el cursor"}
                </button>
              )}
              <button className="btn ghost" onClick={() => run(last, last.provider)}>
                Otra versión
              </button>
              {parsed.proposal && (
                <button className="btn ghost" onClick={() => navigator.clipboard.writeText(parsed.proposal!)}>
                  Copiar
                </button>
              )}
              <button className="btn ghost" onClick={discard}>
                Descartar
              </button>
            </div>
          )}
          {!running && others.length > 0 && (
            <p className="retry-with muted small">
              Probar con{" "}
              {others.map((p, i) => (
                <span key={p}>
                  {i > 0 && " · "}
                  <button
                    className="link"
                    onClick={() => {
                      setProvider(p);
                      run(last, p);
                    }}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                </span>
              ))}
            </p>
          )}
          {applied === "missing" && (
            <p className="error small">El fragmento original ya no está en el texto. Copia la propuesta y pégala a mano.</p>
          )}
        </section>
      )}
    </aside>
  );
}

export default memo(AssistantPanel);
