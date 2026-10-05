"use client";

import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  EDIT_ACTIONS,
  PROVIDER_LABELS,
  SCENE_LENGTHS,
  type AIPanelSection,
  type AssistEvent,
  type ChapterInfo,
  type Fact,
  type ContextPart,
  type ContextSection,
  type EditAction,
  type Memory,
  type ProviderId,
  type SceneLength,
  type Usage,
} from "@/lib/types";
import { estimateTokens } from "@/lib/ai/context";
import { readPref, writePref } from "@/lib/client";
import { BUILD, diagEnabled } from "@/lib/diag";
import { appendImages, countWords, protectImages, restoreImages } from "@/lib/manuscript";
import type { Selection } from "./ChapterEditor";
import AdvisorOverview from "./AdvisorOverview";
import AdvisorReading from "./AdvisorReading";
import AdvisorConsult from "./AdvisorConsult";
import AdvisorSaved from "./AdvisorSaved";
import { formatCount, formatTokens } from "./format";
import UsageLine from "./UsageLine";
import ContextView from "./ContextView";

interface Props {
  hidden: boolean;
  /** Asistente (writes with the author) or Consejero (thinks with the author). */
  section: AIPanelSection;
  onSection(section: AIPanelSection): void;
  /** Requests above this many tokens ask before going out (AI_CONFIRM_TOKENS). */
  confirmTokens: number;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  /** Saves the open chapter (a reading is of the saved text). */
  flush(): Promise<boolean>;
  onAutoDigest(on: boolean): void;
  chapters: ChapterInfo[];
  onFactAdded(f: Fact): void;
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
  /** Both return true when the text reached the manuscript. */
  onApply(original: Selection, rewrite: string): boolean;
  onInsert(text: string): boolean;
  onClearSelection(): void;
}

type Mode = "edit" | "scene";
type Notice = { kind: "refusal" | "error" | "truncated"; message: string } | null;

/** A tab's pending result: what was asked, what came back, and what happened when using it. */
interface Result {
  output: string;
  notice: Notice;
  last: Request & { provider: ProviderId };
  /** The original fragment was no longer in the text: nothing was replaced. */
  applyError: boolean;
  /** A rewrite that dropped images of the book: never applied without asking. */
  lostImages: { text: string; missing: string[] } | null;
  /** What the request read and what it cost, as the server and the provider reported it. */
  readParts: ContextPart[] | null;
  usage: Usage | null;
}

/** What a run was asked, so "Otra versión" and "Probar con…" repeat it exactly. */
interface Request {
  section: AIPanelSection;
  mode: Mode;
  action: EditAction;
  target: Selection | null;
  body: Record<string, unknown>;
}

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

function AssistantPanel(props: Props) {
  const {
    hidden,
    section,
    onSection,
    confirmTokens,
    onGoTo,
    flush,
    onAutoDigest,
    chapters,
    onFactAdded,
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
    onClearSelection,
  } = props;

  const [assistantMode, setMode] = useState<Mode>("edit");
  const [advisorView, setAdvisorView] = useState<"consult" | "saved" | "selection" | "overview" | "reading">("consult");
  // Each section remembers its own action.
  const [actions, setActions] = useState<Record<AIPanelSection, EditAction>>({
    assistant: "redaccion",
    advisor: "consistencia",
  });
  const action = actions[section];
  const setAction = (a: EditAction) => setActions((all) => ({ ...all, [section]: a }));
  // The Consejero only analyses a selection: it never writes scenes.
  const mode: Mode = section === "advisor" ? "edit" : assistantMode;
  const [characterId, setCharacterId] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [includeManuscript, setIncludeManuscript] = useState(false);

  // Scene inputs. The argument draft survives reloads (per novel).
  const [argument, setArgument] = useState("");
  const [sceneCharacters, setSceneCharacters] = useState<string[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [length, setLength] = useState<SceneLength>("media");

  // One pending result per tab (Editar selección, Escribir escena, the Consejero's analysis):
  // generating in one never discards an unused proposal in another. Using a proposal
  // (Reemplazar / Insertar) or "Limpiar" clears only its own.
  const [results, setResults] = useState<Record<string, Result>>({});
  const [runningSlot, setRunningSlot] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{
    total: number;
    manuscript: number;
    parts?: ContextPart[];
    sections?: ContextSection[];
    instructions?: number;
    notices?: string[];
    /** The inputs changed since: a new estimate is on its way. */
    stale?: boolean;
  } | null>(null);
  // "Ver contexto" open; opening it asks again (the manuscript may have changed meanwhile).
  const [showContext, setShowContext] = useState(false);
  const [contextAsked, setContextAsked] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  const argumentRef = useRef<HTMLTextAreaElement | null>(null);

  const slot = `${section}:${mode}`;
  const result = results[slot] ?? null;
  const output = result?.output ?? "";
  const notice = result?.notice ?? null;
  const last = result?.last ?? null;
  const lostImages = result?.lostImages ?? null;
  const readParts = result?.readParts ?? null;
  const usage = result?.usage ?? null;
  // One request at a time; its result goes to the tab it was asked from.
  const running = runningSlot !== null;
  const runningHere = runningSlot === slot;
  // Temporary diagnostics (?diag=1): what the panel holds, and what happened to it.
  const [diag, setDiag] = useState(false);
  const [diagLog, setDiagLog] = useState<string[]>([]);
  const [tapped, setTapped] = useState("");
  const note = (s: string) =>
    diag && setDiagLog((l) => [...l.slice(-9), `${new Date().toLocaleTimeString("es")} ${s}`]);
  useEffect(() => setDiag(diagEnabled()), []);
  useEffect(() => {
    if (!diag) return;
    // Tapping any text tells where it comes from: the nearest data-origin, or the element.
    const onTap = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest) return;
      const origin = el.closest<HTMLElement>("[data-origin]");
      const path: string[] = [];
      for (let n: HTMLElement | null = el; n && path.length < 4; n = n.parentElement)
        path.push(`${n.tagName.toLowerCase()}${n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : ""}`);
      setTapped(`${origin ? origin.dataset.origin : "(sin data-origin)"} ← ${path.join(" < ")} «${(el.textContent ?? "").trim().slice(0, 40)}»`);
    };
    document.addEventListener("pointerdown", onTap, true);
    return () => document.removeEventListener("pointerdown", onTap, true);
  }, [diag]);
  const update = (key: string, f: (r: Result) => Partial<Result>) =>
    setResults((all) => (all[key] ? { ...all, [key]: { ...all[key], ...f(all[key]) } } : all));
  const clearResult = (key: string) =>
    setResults((all) => {
      const { [key]: _gone, ...rest } = all;
      return rest;
    });

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
        section,
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
      section,
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
    if (hidden || (section === "advisor" && advisorView !== "selection")) return;
    const req = buildRequest();
    if (!req) {
      setEstimate(null);
      return;
    }
    setEstimate((e) => (e && !e.stale ? { ...e, stale: true } : e));
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          // The text on screen now, as the real request will send it.
          body: JSON.stringify({ ...req.body, content: getContent(), dryRun: true }),
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
    contextAsked,
    hidden,
    section,
    advisorView,
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
    // Normal queries go out without asking; only an exceptionally large one is confirmed.
    const size = estimate?.total ?? 0;
    if (size > confirmTokens && !confirm(`Esta consulta enviará unos ${formatTokens(size)} tokens de contexto. ¿Continuar?`))
      return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = `${req.section}:${req.mode}`;
    note(`run → ${key}`);
    setResults((all) => ({
      ...all,
      [key]: { output: "", notice: null, last: { ...req, provider: using }, applyError: false, lostImages: null, readParts: null, usage: null },
    }));
    setRunningSlot(key);

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
          if (event.type === "text") update(key, (r) => ({ output: r.output + event.text }));
          else if (event.type === "refusal") update(key, () => ({ notice: { kind: "refusal", message: event.message } }));
          else if (event.type === "error") update(key, () => ({ notice: { kind: "error", message: event.message } }));
          else if (event.type === "truncated")
            update(key, () => ({ notice: { kind: "truncated", message: "La respuesta se cortó por longitud." } }));
          else if (event.type === "context") update(key, () => ({ readParts: event.parts }));
          else if (event.type === "usage") update(key, () => ({ usage: event }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") update(key, () => ({ notice: { kind: "error", message: (e as Error).message } }));
    } finally {
      if (abortRef.current === controller) setRunningSlot(null);
      note(`fin ${key}`);
    }
  }

  // On a phone the sheet scrolls to the answer as soon as it starts, instead of leaving it
  // below the controls.
  // Once per request, when its answer starts to arrive (before that there is nothing to scroll to).
  const scrolledFor = useRef<string | null>(null);
  const answering = runningHere && output.length > 0;
  useEffect(() => {
    if (!runningSlot) scrolledFor.current = null;
    else if (answering && scrolledFor.current !== runningSlot && window.matchMedia("(max-width: 999px)").matches) {
      scrolledFor.current = runningSlot;
      resultRef.current?.scrollIntoView({ block: "start" });
    }
  }, [runningSlot, answering]);

  /** "Limpiar": this tab's proposal goes; the others stay. */
  const discard = () => {
    note(`Limpiar → clearResult(${slot})`);
    if (runningHere) abortRef.current?.abort();
    clearResult(slot);
  };

  /**
   * After the text reached the manuscript, the proposal has done its job: it leaves the
   * panel (the editor already has the cursor at the end of it, and its undo history).
   * If it could not be applied, it stays, with the reason.
   */
  const used = (ok: boolean) => {
    note(`usada ok=${ok} → ${ok ? `clearResult(${slot})` : "applyError"}`);
    if (!ok) return update(slot, () => ({ applyError: true, lostImages: null }));
    clearResult(slot);
    // A scene that reached the manuscript also takes its argument with it: the box is ready
    // for the next scene. Unless the author already started another one meanwhile.
    if (last?.mode === "scene" && argument.trim() === String(last.body.argument ?? "").trim()) {
      setArgument("");
      writePref(`argument:${novelId}`, "");
    }
  };
  /** Inserting can fail (the editor is not there, the browser refused the edit): then nothing is lost. */
  const tryInsert = (text: string) => {
    try {
      return onInsert(text);
    } catch {
      return false;
    }
  };

  // Coming back to "Escribir escena" (opening the panel, or the tab) with nothing pending:
  // the cursor waits in the empty argument for the next scene. Not on page load.
  const readyForNextScene = () =>
    requestAnimationFrame(() => {
      if (!argumentRef.current?.value && !results["assistant:scene"]) argumentRef.current?.focus();
    });
  const shownAs = useRef(hidden ? null : slot);
  useEffect(() => {
    const now = hidden ? null : slot;
    const before = shownAs.current;
    shownAs.current = now;
    if (now === "assistant:scene" && before !== now) readyForNextScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the panel or the tab changes
  }, [hidden, slot]);

  // The author chose a path of "¿Cómo seguir?": the Asistente gets it as the argument of a scene.
  const sendToAssistant = (text: string) => {
    note(`Enviar al Asistente → argument (${text.length} car.)`);
    setArgument(text);
    setMode("scene");
    onSection("assistant");
  };

  // Views of the Consejero that are not a request about the selection.
  const overview = section === "advisor" && advisorView !== "selection";
  const showResult = !overview && last && (output || runningHere || notice);
  const parsed = last ? parse(output, last.mode) : null;
  const others = providers.filter((p) => p !== last?.provider);
  // A finished scene well below the length asked (Media, Larga): said discreetly, with "Ampliar".
  // Never automatic: widening is another request, only when the author asks for it.
  const asked = last?.mode === "scene" ? SCENE_LENGTHS.find((l) => l.id === last.body.length) : undefined;
  const sceneWords = parsed?.proposal && last?.mode === "scene" ? countWords(parsed.proposal) : 0;
  const short =
    !runningHere &&
    !notice &&
    asked?.words &&
    asked.warnBelow &&
    parsed?.proposal &&
    (parsed.complete || parsed.untagged) &&
    sceneWords < asked.words * asked.warnBelow
      ? { words: sceneWords, asked: asked.words }
      : null;
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
      <label className="check">
        <input type="checkbox" checked={includeManuscript} onChange={(e) => setIncludeManuscript(e.target.checked)} />
        <span>
          Leer también la novela completa
          {novelChars > 0 && <span className="muted"> · ≈{formatTokens(manuscriptTokens)} tokens más por consulta</span>}
        </span>
      </label>
      <p className="muted small check-help">
        {includeManuscript
          ? "Lee todo el manuscrito: más coherencia, más coste."
          : "Desactivada, la IA no lee todo el manuscrito: trabaja sólo con el contexto seleccionado."}
      </p>
      {estimate && (
        <p className={`estimate${estimate.total > confirmTokens ? " large" : ""}`}>
          Contexto de esta consulta: ≈{formatTokens(estimate.total)} tokens
          {estimate.sections && (
            <>
              {" · "}
              <button
                type="button"
                className="link small"
                aria-expanded={showContext}
                onClick={() => {
                  if (!showContext) setContextAsked((n) => n + 1);
                  setShowContext(!showContext);
                }}
              >
                {showContext ? "Ocultar contexto" : "Ver contexto"}
              </button>
            </>
          )}
        </p>
      )}
      {showContext && estimate?.sections && (
        <ContextView
          sections={estimate.sections}
          total={estimate.total}
          instructions={estimate.instructions ?? 0}
          includeManuscript={includeManuscript}
          updating={Boolean(estimate.stale)}
          notices={estimate.notices}
        />
      )}
    </>
  );

  return (
    <aside className="panel" hidden={hidden} aria-label={section === "advisor" ? "Consejero" : "Asistente"}>
      <header className="panel-head">
        <nav className="sections" aria-label="Sección">
          <button
            className={section === "assistant" ? "on" : undefined}
            aria-pressed={section === "assistant"}
            onClick={() => onSection("assistant")}
            title="Escribe contigo: redacta, desarrolla y transforma el texto"
          >
            Asistente
          </button>
          <button
            className={section === "advisor" ? "on" : undefined}
            aria-pressed={section === "advisor"}
            onClick={() => onSection("advisor")}
            title="Piensa contigo: coherencia, personajes, ritmo y repeticiones"
          >
            Consejero
          </button>
        </nav>
        <span className="spacer" />
        <button className="link" onClick={onClose}>
          Ocultar
        </button>
      </header>
      {diag && (
        <pre className="diag" data-origin="diag">
          {[
            `build ${BUILD.sha} ${BUILD.time}${BUILD.deployment ? ` ${BUILD.deployment}` : ""}`,
            `section=${section} mode=${mode} view=${advisorView} slot=${slot}`,
            `showResult=${Boolean(showResult)} parsed=${Boolean(parsed)} last=${Boolean(last)} runningSlot=${runningSlot ?? "-"}`,
            `results: ${Object.entries(results).map(([k, r]) => `${k}(${r.output.length} car.${r.notice ? `, ${r.notice.kind}` : ""}${r.applyError ? ", applyError" : ""})`).join(" · ") || "(vacío)"}`,
            `argument: ${argument.length} car. (localStorage argument:${novelId})`,
            `toque: ${tapped || "-"}`,
            ...diagLog,
          ].join("\n")}
        </pre>
      )}

      {section === "assistant" ? (
        <nav className="tabs" aria-label="Modo">
          <button className={mode === "edit" ? "on" : undefined} onClick={() => setMode("edit")}>
            Editar selección
          </button>
          <button
            className={mode === "scene" ? "on" : undefined}
            onClick={() => {
              setMode("scene");
              readyForNextScene();
            }}
          >
            Escribir escena
          </button>
        </nav>
      ) : (
        <nav className="tabs" aria-label="Vista">
          <button className={advisorView === "consult" ? "on" : undefined} onClick={() => setAdvisorView("consult")}>
            Consultar
          </button>
          <button className={advisorView === "saved" ? "on" : undefined} onClick={() => setAdvisorView("saved")}>
            Guardadas
          </button>
          <button className={advisorView === "selection" ? "on" : undefined} onClick={() => setAdvisorView("selection")}>
            Sobre la selección
          </button>
          <button className={advisorView === "overview" ? "on" : undefined} onClick={() => setAdvisorView("overview")}>
            Panorama
          </button>
          <button className={advisorView === "reading" ? "on" : undefined} onClick={() => setAdvisorView("reading")}>
            Cabos y lecturas
          </button>
        </nav>
      )}

      {overview ? (
        hidden ? null : advisorView === "consult" ? (
          <>
            {providerSelect && <div className="controls">{providerSelect}</div>}
            <AdvisorConsult
              novelId={novelId}
              chapterId={chapterId}
              chapters={chapters}
              provider={provider}
              providers={providers}
              onProvider={(x) => {
                setProvider(x);
                writePref("provider", x);
              }}
              selection={selection}
              confirmTokens={confirmTokens}
              getContent={getContent}
              onGoTo={onGoTo}
              memory={memory}
              flush={flush}
              onFactAdded={onFactAdded}
              onSendToAssistant={sendToAssistant}
            />
          </>
        ) : advisorView === "saved" ? (
          <AdvisorSaved
            novelId={novelId}
            chapters={chapters}
            memory={memory}
            onGoTo={onGoTo}
            onSendToAssistant={sendToAssistant}
            onFactAdded={onFactAdded}
          />
        ) : advisorView === "overview" ? (
          <AdvisorOverview novelId={novelId} chapterId={chapterId} memory={memory} getContent={getContent} onGoTo={onGoTo} />
        ) : (
          <>
            {providerSelect && <div className="controls">{providerSelect}</div>}
            <AdvisorReading
              novelId={novelId}
              chapterId={chapterId}
              memory={memory}
              provider={provider}
              flush={flush}
              onAutoDigest={onAutoDigest}
              onGoTo={onGoTo}
            />
          </>
        )
      ) : mode === "edit" ? (
        <>
          <div className="actions" role="group" aria-label="Acción">
            {EDIT_ACTIONS.filter((a) => a.section === section).map((a) => (
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
          {selection && (
            <div className="quote-head">
              <span className="muted small">Fragmento seleccionado en el editor</span>
              <button className="link" onClick={onClearSelection} title="Para usar otro, selecciónalo en el editor">
                Quitar
              </button>
            </div>
          )}
          <blockquote className={`quote${selection ? "" : " empty"}`} data-origin="selection (prop: selección del editor)">
            {selection
              ? selection.text.length > 400
                ? `${selection.text.slice(0, 400)}…`
                : selection.text
              : "Selecciona un fragmento en el editor; aparecerá aquí."}
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
              ref={argumentRef}
              data-origin={`argument (estado argument, localStorage argument:${novelId})`}
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

      {!overview && !provider && <p className="error">No hay proveedor de IA configurado.</p>}

      <div className="run" hidden={overview}>
        <button className="btn primary" onClick={() => req && provider && run(req, provider)} disabled={!canRun}>
          {runningHere
            ? mode === "scene"
              ? "Escribiendo…"
              : "Analizando…"
            : mode === "scene"
              ? "Desarrollar escena"
              : current.rewrites
                ? "Proponer cambios"
                : "Analizar"}
        </button>
        {runningHere && (
          <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
            Detener
          </button>
        )}
      </div>

      {showResult && parsed && last && (
        <section className="result" aria-live="polite" ref={resultRef} data-origin={`results["${slot}"] (showResult && parsed && last)`}>
          <div className="result-head">
            <span className="muted small">Respuesta del {last.section === "advisor" ? "Consejero" : "Asistente"}</span>
            <span className="spacer" />
            <button className="link small" onClick={discard} title="Quitar esta propuesta del panel sin usarla">
              Limpiar
            </button>
          </div>
          {parsed.notes && (
            <div className="markdown">
              <ReactMarkdown>{parsed.notes}</ReactMarkdown>
            </div>
          )}
          {runningHere && !output && <p className="muted">{last.mode === "scene" ? "Escribiendo…" : "Pensando…"}</p>}

          {parsed.proposal !== null && (
            <div className="compare">
              {last.mode === "edit" && last.target && (
                <>
                  <h3>Original</h3>
                  <p className="prose original">{last.target.text}</p>
                </>
              )}
              <h3>Propuesta</h3>
              <p className="prose">{parsed.proposal}</p>
              {parsed.warning && <p className="notice">Aviso: {parsed.warning}</p>}
            </div>
          )}

          {short && (
            <p className="length-note muted small">
              ≈{formatCount(short.words)} palabras de ~{formatCount(short.asked)} solicitadas ·{" "}
              <button
                className="link small"
                title="Desarrolla los momentos que quedaron comprimidos, sin añadir acontecimientos"
                onClick={() => run({ ...last, body: { ...last.body, expand: parsed.proposal } }, last.provider)}
              >
                Ampliar
              </button>
            </p>
          )}
          {notice && <p className={`notice ${notice.kind}`}>{notice.message}</p>}
          {!runningHere && (readParts || usage) && <UsageLine parts={readParts} usage={usage} />}

          {!runningHere && (
            <div className="compare-actions">
              {parsed.proposal && (parsed.complete || parsed.untagged) && last.mode === "edit" && last.target && (
                <button
                  className="btn primary"
                  onClick={() => {
                    // The model saw [IMAGEN n]; put the real markers back before touching the text.
                    const restored = restoreImages(parsed.proposal!, protectImages(last.target!.text).ids);
                    if (restored.missing.length) return update(slot, () => ({ lostImages: restored }));
                    used(onApply(last.target!, restored.text));
                  }}
                >
                  Reemplazar selección
                </button>
              )}
              {parsed.proposal && (parsed.complete || parsed.untagged) && last.mode === "scene" && (
                <button className="btn primary" onClick={() => used(tryInsert(parsed.proposal!))}>
                  Insertar en el cursor
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
            </div>
          )}
          {!runningHere && others.length > 0 && (
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
          {lostImages && (
            <div className="notice lost-images" role="alert">
              <p>
                La propuesta quitó {lostImages.missing.length === 1 ? "una imagen" : `${lostImages.missing.length} imágenes`} del
                fragmento. No se ha aplicado.
              </p>
              <div className="compare-actions">
                <button
                  className="btn"
                  onClick={() => used(onApply(last.target!, appendImages(lostImages.text, lostImages.missing)))}
                >
                  Aplicar y colocar la imagen al final
                </button>
                <button className="btn ghost" onClick={() => update(slot, () => ({ lostImages: null }))}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {result?.applyError && (
            <p className="error small">
              {last.mode === "scene"
                ? "No se pudo insertar la escena. Copia la propuesta y pégala a mano."
                : "El fragmento original ya no está en el texto. Copia la propuesta y pégala a mano."}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}

export default memo(AssistantPanel);
