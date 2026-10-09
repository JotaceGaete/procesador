"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  EDIT_ACTIONS,
  PROVIDER_LABELS,
  SCENE_LENGTHS,
  type AIPanelSection,
  type AssistEvent,
  type ChapterInfo,
  type Fact,
  type ContextInventory,
  type ContextPart,
  type ContextSection,
  type EditAction,
  type Memory,
  type ProviderId,
  type SceneLength,
  type Usage,
} from "@/lib/types";
import { chapterLabel, estimateTokens } from "@/lib/ai/context";
import { diffStats, diffText } from "@/lib/diff";
import { anchorAt, resolveAnchor, type Anchor, type InsertTarget, type SceneTarget } from "@/lib/placement";
import { readPref, writePref } from "@/lib/client";
import { BUILD, diagEnabled } from "@/lib/diag";
import { appendImages, countWords, fromModel, protectImages, restoreImages } from "@/lib/manuscript";
import type { Selection } from "./ChapterEditor";
import AdvisorOverview from "./AdvisorOverview";
import AdvisorReading from "./AdvisorReading";
import AdvisorConsult from "./AdvisorConsult";
import AdvisorSaved from "./AdvisorSaved";
import { formatCount, formatTokens } from "./format";
import UsageLine from "./UsageLine";
import ContextView from "./ContextView";
import DiffView from "./DiffView";
import ProposalReader from "./ProposalReader";
import type { SceneBrief } from "@/lib/advisor/converse";
import type { Comparison } from "@/lib/advisor/compare";

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
  /**
   * Both keep the current text as a version first, then apply; true when the text reached the
   * manuscript. They throw (and change nothing) when the version can't be saved.
   */
  onApply(original: Selection, rewrite: string): Promise<boolean>;
  onInsert(text: string, target: InsertTarget): Promise<boolean>;
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
  /** «Ver lo que se envió»: the real request's inventory, as the server built it. */
  sent: ContextInventory | null;
  /** Applying failed before touching the manuscript (the copy couldn't be saved): why. */
  applyFailed: string | null;
  /** Where a scene will go: the chapter's end, or a fixed position. Only the author changes it. */
  insertTarget: InsertTarget;
  usage: Usage | null;
  /** Continuidad: what the proposal may change of what is established (checked without AI). */
  continuity?: { kind: string; message: string }[];
}

/** What a run was asked, so "Otra versión" and "Probar con…" repeat it exactly. */
interface Request {
  section: AIPanelSection;
  mode: Mode;
  action: EditAction;
  target: Selection | null;
  body: Record<string, unknown>;
  /**
   * A scene written for the cursor: the position fixed when it was asked (docs/asistente-
   * contexto.md §11). "Otra versión", "Ampliar" and "Probar con…" keep it.
   */
  anchor?: Anchor | null;
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

const wordsLabel = (n: number) => (n === 1 ? "1 palabra" : `${n.toLocaleString("es")} palabras`);

/** Up to `max` characters, cut at a word, with an ellipsis where it was cut. */
function around(text: string, max: number, side: "start" | "end") {
  if (text.length <= max) return text;
  if (side === "end") {
    const cut = text.slice(-max);
    return `…${cut.slice(cut.search(/\s/) + 1)}`;
  }
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}…`;
}

/**
 * A scene before it is inserted: the scene in its place, with enough text around it to
 * recognise the spot (as ChapterEditor will put it: its own paragraphs). Null when a fixed
 * position can no longer be found.
 */
function insertPreview(content: string, target: InsertTarget, scene: string) {
  const at = target.kind === "end" ? content.length : resolveAnchor(content, target.anchor);
  if (at === null) return null;
  const before = content.slice(0, at).trimEnd();
  const after = content.slice(at).trimStart();
  return {
    atStart: !before,
    before: before ? `${around(before, 220, "end")}\n\n` : "",
    scene: scene.trim(),
    after: after ? `\n\n${around(after, 220, "start")}` : "",
  };
}

const VERDICT: Record<Comparison["verdict"], string> = {
  mejor: "La propuesta mejora tu versión",
  igual: "La propuesta no mejora ni empeora tu versión",
  peor: "Tu versión es mejor: el Consejero recomienda conservarla",
};
const WINNER = { original: "tu versión", propuesta: "la propuesta", empate: "empate" } as const;

/** The Consejero's comparison of a rewrite with the author's scene: a recommendation. */
function Judgment({ j }: { j: { loading: boolean; data: Comparison | null; error: string } }) {
  if (j.loading) return <p className="muted small judgment">El Consejero está comparando la propuesta con tu versión…</p>;
  if (j.error) return <p className="muted small judgment">No se pudo comparar con tu versión: {j.error}</p>;
  if (!j.data) return null;
  const d = j.data;
  return (
    <div className={`judgment verdict-${d.verdict}`} data-origin="juicio comparativo del Consejero" aria-label="Recomendación del Consejero">
      <p>
        <strong>{VERDICT[d.verdict]}.</strong> {d.summary}
      </p>
      {d.criteria.length > 0 && (
        <ul className="small">
          {d.criteria.map((c) => (
            <li key={c.name}>
              {c.name}: <strong>{WINNER[c.winner]}</strong>
              {c.why ? ` · ${c.why}` : ""}
            </li>
          ))}
        </ul>
      )}
      {d.losses.length > 0 && <p className="small">Lo que pierde: {d.losses.join(" · ")}</p>}
      {d.changes.length > 0 && <p className="small">Cambia lo establecido: {d.changes.join(" · ")}</p>}
      <p className="muted small">Es una recomendación: la decisión es tuya y puedes reemplazar igualmente.</p>
    </div>
  );
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
  // Where a new scene goes: the end of the chapter unless the author chooses the cursor.
  const [sceneTarget, setSceneTarget] = useState<SceneTarget>("end");
  // «Enviar al Asistente» from the Consejero: the decisions, limits and discards that go with
  // the argument (the author reviewed them there). Only for the next scene.
  const [brief, setBrief] = useState<SceneBrief | null>(null);
  // «Revisar escena»: the changes the author wants (from the Consejero's review, or their own).
  const [reviewNotes, setReviewNotes] = useState("");
  // Juicio comparativo of the last «Revisar escena» rewrite: a recommendation, never a decision.
  const [judgment, setJudgment] = useState<{ for: string; loading: boolean; data: Comparison | null; error: string } | null>(null);
  useEffect(() => setSceneTarget(readPref("sceneTarget") === "cursor" ? "cursor" : "end"), []);

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
  // A proposal being applied (the copy of the current text is being saved first).
  const [applying, setApplying] = useState(false);
  // How a rewrite is shown before accepting it: the changes, the clean proposal, or the author's text.
  const [compareView, setCompareView] = useState<"changes" | "proposal" | "original">("changes");
  // «Ver lo que se envió», under an answer.
  const [showSent, setShowSent] = useState(false);
  // "Abrir propuesta": the Asistente's proposal read in large (a view; the proposal stays here).
  const [readerOpen, setReaderOpen] = useState(false);
  // Where a scene will go follows the cursor while the proposal waits.
  const [, setCaretTick] = useState(0);
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
          sceneTarget,
          ...(brief ? { brief: { decisions: brief.decisions, constraints: brief.constraints, discarded: brief.discarded } } : {}),
          // Written to continue the chapter's end, or the text at the cursor (fixed in run()).
          cursor: sceneTarget === "end" ? getContent().length : getCursor(),
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
        ...(action === "revisar" && reviewNotes.trim() ? { notes: reviewNotes.trim() } : {}),
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
          // The text on screen now and the chosen model, as the real request will send them.
          body: JSON.stringify({ ...req.body, content: getContent(), provider, dryRun: true }),
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
    provider,
    sceneTarget,
    brief,
  ]);

  async function run(req: Request, using: ProviderId) {
    // Normal queries go out without asking; only an exceptionally large one is confirmed.
    const size = estimate?.total ?? 0;
    if (size > confirmTokens && !confirm(`Esta consulta enviará unos ${formatTokens(size)} tokens de contexto. ¿Continuar?`))
      return;

    // A scene: written for the chapter's end as it is now, or for the fixed position (fixed now
    // the first time; a repeat keeps it, wherever the cursor went meanwhile).
    const content = getContent();
    if (req.mode === "scene") {
      if (req.body.sceneTarget === "cursor") {
        const anchor = req.anchor ?? anchorAt(content, getCursor());
        const at = resolveAnchor(content, anchor);
        if (at === null) {
          const key = `${req.section}:${req.mode}`;
          update(key, () => ({
            notice: { kind: "error", message: "El texto alrededor del lugar fijado cambió: vuelve a pedir la escena desde el cursor." },
          }));
          return;
        }
        req = { ...req, anchor, body: { ...req.body, cursor: at } };
      } else req = { ...req, anchor: null, body: { ...req.body, cursor: content.length } };
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = `${req.section}:${req.mode}`;
    note(`run → ${key}`);
    setResults((all) => ({
      ...all,
      [key]: {
        output: "",
        notice: null,
        last: { ...req, provider: using },
        applyError: false,
        lostImages: null,
        readParts: null,
        sent: null,
        applyFailed: null,
        insertTarget: req.anchor ? { kind: "at", anchor: req.anchor } : { kind: "end" },
        usage: null,
      },
    }));
    setRunningSlot(key);

    try {
      const res = await fetch("/api/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        // Always the latest text: "Otra versión" after edits uses what is on screen now.
        body: JSON.stringify({ ...req.body, content, provider: using }),
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
          else if (event.type === "continuity") update(key, () => ({ continuity: event.warnings }));
          else if (event.type === "truncated")
            update(key, () => ({ notice: { kind: "truncated", message: "La respuesta se cortó por longitud." } }));
          else if (event.type === "context") update(key, () => ({ readParts: event.parts, sent: event.sent ?? null }));
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

  // The panel scrolls to the answer as soon as it starts, instead of leaving it below the
  // controls (on a phone, the sheet).
  // Once per request, when its answer starts to arrive (before that there is nothing to scroll to).
  const scrolledFor = useRef<string | null>(null);
  const answering = runningHere && output.length > 0;
  useEffect(() => {
    if (!runningSlot) scrolledFor.current = null;
    // On a phone, and for the Asistente everywhere: its answer is then the main thing in the panel.
    else if (answering && scrolledFor.current !== runningSlot && (window.matchMedia("(max-width: 999px)").matches || runningSlot.startsWith("assistant"))) {
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
      setBrief(null);
    }
  };
  /**
   * Accepting a proposal: the current text is kept as a version, then the manuscript changes.
   * If the copy can't be saved nothing changes and the proposal stays, with the reason; if the
   * text can't be applied (the fragment is gone), the proposal stays too (`used(false)`).
   */
  const accept = async (apply: () => Promise<boolean>) => {
    setApplying(true);
    update(slot, () => ({ applyFailed: null }));
    try {
      used(await apply());
    } catch (e) {
      note(`aplicar falló: ${(e as Error).message}`);
      update(slot, () => ({ applyFailed: (e as Error).message }));
    } finally {
      setApplying(false);
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
    setBrief(null);
    setArgument(text);
    setMode("scene");
    onSection("assistant");
  };
  // «Revisar escena» from the Consejero: the review goes to Editar as the changes the author
  // wants (editable), over the same scene, selected again if the selection moved.
  const sendReview = (r: { notes: string; start: number; end: number }) => {
    note(`Revisar escena → Editar (${r.notes.length} car.)`);
    setReviewNotes(r.notes);
    setActions((all) => ({ ...all, assistant: "revisar" }));
    setMode("edit");
    onSection("assistant");
    if (!selection || selection.start !== r.start || selection.end !== r.end)
      onGoTo(chapterId, r.start, r.end, getContent().slice(r.start, r.end));
  };
  // The Consejero's brief, reviewed by the author: it fills the scene's fields (still nothing
  // is written: the author asks for the scene, reads it and decides).
  const sendBrief = (b: SceneBrief) => {
    note(`Enviar al Asistente → encargo (${b.decisions.length} decisiones)`);
    setArgument(b.argument);
    writePref(`argument:${novelId}`, b.argument);
    setSceneCharacters(b.characterIds);
    setPlaceId(b.placeId ?? "");
    setSceneTarget(b.target);
    setBrief(b);
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
  const finished = Boolean(parsed?.proposal && (parsed.complete || parsed.untagged) && !runningHere);
  // A finished rewrite, as it would reach the manuscript (markers restored), and its changes.
  const rewrite = useMemo(() => {
    if (!finished || !last || last.mode !== "edit" || !last.target || !parsed?.proposal) return null;
    const restored = restoreImages(fromModel(parsed.proposal), protectImages(last.target.text).ids);
    const ops = diffText(last.target.text, restored.text);
    return { restored, ops, stats: diffStats(ops) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the proposal and its target
  }, [finished, last, parsed?.proposal]);
  useEffect(() => setCompareView("changes"), [rewrite]);
  // «Revisar escena»: once the rewrite is complete, the Consejero compares it with the author's
  // text. Only a recommendation: «Reemplazar» stays available whatever it says.
  const judgeKey = rewrite && last?.action === "revisar" && last.section === "assistant" && parsed?.complete ? output : "";
  useEffect(() => {
    if (!judgeKey || !rewrite || !last?.target || judgment?.for === judgeKey) return;
    const controller = new AbortController();
    setJudgment({ for: judgeKey, loading: true, data: null, error: "" });
    fetch(`/api/novels/${novelId}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original: last.target.text, proposal: rewrite.restored.text, provider: last.provider }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
        setJudgment({ for: judgeKey, loading: false, data: json as Comparison, error: "" });
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setJudgment({ for: judgeKey, loading: false, data: null, error: e.message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per finished rewrite
  }, [judgeKey]);
  useEffect(() => setShowSent(false), [last]);
  // A finished scene: its preview, redrawn while it waits.
  const sceneReady = finished && last?.mode === "scene";
  useEffect(() => {
    if (!sceneReady) return;
    const tick = () => setCaretTick((n) => n + 1);
    // Only to redraw the text around the destination as it changes; the destination itself
    // never follows the cursor (§11).
    const events = ["selectionchange", "keyup", "pointerup", "input"];
    for (const e of events) document.addEventListener(e, tick);
    return () => {
      for (const e of events) document.removeEventListener(e, tick);
    };
  }, [sceneReady]);
  // The destination shown is the one used: the cursor moving never changes it (§11).
  const insertTarget = result?.insertTarget ?? ({ kind: "end" } as InsertTarget);
  const insertion = sceneReady && parsed?.proposal ? insertPreview(getContent(), insertTarget, fromModel(parsed.proposal)) : null;
  const fixHere = () => update(slot, () => ({ insertTarget: { kind: "at", anchor: anchorAt(getContent(), getCursor()) }, applyFailed: null }));
  const chapterIndex = chapters.findIndex((c) => c.id === chapterId);
  const here = chapterIndex >= 0 ? chapterLabel(chapterIndex, chapters[chapterIndex].title) : "este capítulo";

  // What "Abrir propuesta" shows, and its main action (the same as the panel's).
  const reader =
    last?.section === "assistant" && parsed?.proposal && !runningHere
      ? rewrite && last.target
        ? {
            title: "Propuesta de cambios",
            where: `Reemplaza el fragmento seleccionado · ${here}`,
            text: rewrite.restored.text,
            changes: rewrite.ops,
            original: last.target.text,
            primary: applying ? "Guardando una copia…" : "Reemplazar selección",
            primaryDisabled: applying,
            notice: null as string | null,
            onPrimary: () => {
              if (rewrite.restored.missing.length) {
                setReaderOpen(false);
                return update(slot, () => ({ lostImages: rewrite.restored }));
              }
              accept(() => onApply(last.target!, rewrite.restored.text));
            },
          }
        : sceneReady
          ? {
              title: "Propuesta de escena",
              where: insertTarget.kind === "end" ? `Se insertará al final del capítulo · ${here}` : `Se insertará en la posición fijada · ${here}`,
              text: fromModel(parsed.proposal),
              changes: undefined,
              original: undefined,
              primary: applying ? "Guardando una copia…" : insertTarget.kind === "end" ? "Insertar al final" : "Insertar en el cursor",
              primaryDisabled: applying || !insertion,
              notice: insertion ? null : "El texto alrededor del lugar fijado cambió y ya no se encuentra. Fíjalo de nuevo en el cursor o inserta al final.",
              onPrimary: () => accept(() => onInsert(fromModel(parsed.proposal!), insertTarget)),
            }
          : null
      : null;
  const canRead = Boolean(reader);
  useEffect(() => {
    if (!canRead || hidden) setReaderOpen(false);
  }, [canRead, hidden]);

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

  // A scene reads the story up to the cursor, never beyond (docs/asistente-contexto.md).
  const storyChars =
    mode === "scene"
      ? chapters.slice(0, Math.max(0, chapters.findIndex((c) => c.id === chapterId))).reduce((n, c) => n + c.chars, 0) + getCursor()
      : 0;
  // The Asistente keeps literary decisions in front and the technical figures discreet; the
  // Consejero keeps its own layout.
  const quiet = section === "assistant";
  const contextControls = (
    <>
      <label className="check">
        <input type="checkbox" checked={includeManuscript} onChange={(e) => setIncludeManuscript(e.target.checked)} />
        {mode === "scene" ? (
          <span>
            Leer toda la historia hasta aquí
            {!quiet && storyChars > 0 && <span className="muted"> · ≈{formatTokens(estimateTokens(storyChars))} tokens estimados más</span>}
          </span>
        ) : (
          <span>
            Leer también la novela completa
            {!quiet && novelChars > 0 && <span className="muted"> · ≈{formatTokens(manuscriptTokens)} tokens estimados más por consulta</span>}
          </span>
        )}
      </label>
      <p className="muted small check-help">
        {mode === "scene"
          ? includeManuscript
            ? "Lee los capítulos anteriores y este hasta el cursor; nunca lo que viene después."
            : "Desactivada, la IA no lee toda la historia: trabaja sólo con el contexto seleccionado."
          : includeManuscript
            ? "Lee todo el manuscrito: más coherencia, más coste."
            : "Desactivada, la IA no lee todo el manuscrito: trabaja sólo con el contexto seleccionado."}
        {quiet && (mode === "scene" ? storyChars : novelChars) > 0 && (
          <span className="faint">
            {" "}
            (≈{formatTokens(mode === "scene" ? estimateTokens(storyChars) : manuscriptTokens)} tokens más)
          </span>
        )}
      </p>
      {estimate && (
        <p className={`estimate${estimate.total > confirmTokens ? " large" : ""}${quiet ? " quiet" : ""}`}>
          Contexto de esta consulta: ≈{formatTokens(estimate.total)} tokens estimados
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
          scene={mode === "scene"}
          updating={Boolean(estimate.stale)}
          notices={estimate.notices}
        />
      )}
    </>
  );
  // Asistente: the model is a technical choice, out of the literary flow (never removed).
  const advanced = quiet && providerSelect && (
    <details className="advanced">
      <summary>Opciones avanzadas</summary>
      <div className="controls">{providerSelect}</div>
    </details>
  );

  /** The fragment the request works on: the editor's selection, as the editor reports it. */
  const quote = (
    <>
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
    </>
  );

  const sectionTabs = section === "assistant" ? (
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
      );

  return (
    <aside className="panel" hidden={hidden} aria-label={section === "advisor" ? "Consejero" : "Asistente"}>
      {/* Asistente | Consejero are chosen in the top bar (one navigation): the panel's header
          holds what is inside the section, and Ocultar. */}
      <header className="panel-head">
        {sectionTabs}
        <button className="link panel-close" onClick={onClose}>
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
              onSendBrief={sendBrief}
              onSendReview={sendReview}
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
          {/* Asistente: the fragment first (what will be worked on), then the decisions. */}
          {quiet && quote}
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
            {!quiet && providerSelect}
            {contextControls}
          </div>
          {!quiet && quote}
          {action === "revisar" && section === "assistant" && (
            <label className="argument review-notes">
              <span>Cambios que quieres (opcional)</span>
              <textarea
                rows={5}
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                placeholder="Los cambios que apruebas, con tus palabras o los del Consejero. Vacío: el Asistente dice qué funciona y corrige sólo los problemas reales, sin añadir acontecimientos."
              />
            </label>
          )}
          {current.character === "required" && !memory.characters.length && (
            <p className="muted small">Esta acción necesita la ficha de un personaje.</p>
          )}
        </>
      ) : (
        <>
          {/* Escribir escena: argumento → dónde va → extensión → (personajes, lugar) → contexto → Desarrollar. */}
          <label className="argument">
            <span>Argumento</span>
            <textarea
              ref={argumentRef}
              data-origin={`argument (estado argument, localStorage argument:${novelId})`}
              rows={6}
              value={argument}
              onChange={(e) => setArgument(e.target.value)}
              placeholder="Qué ocurre en la escena, con tus palabras. Ej.: ya estaba todo preparado, ducha nueva, el cuarto inmenso… solo faltaba comenzar con el trato."
            />
          </label>
          {brief && (
            <div className="brief-note" data-origin="encargo del Consejero (estado brief)">
              <p className="small">
                <strong>Del Consejero</strong>
                {brief.source ? ` (${brief.source})` : ""}:{" "}
                {[
                  brief.decisions.length && `${brief.decisions.length} ${brief.decisions.length === 1 ? "decisión" : "decisiones"}`,
                  brief.constraints.length && `${brief.constraints.length} ${brief.constraints.length === 1 ? "restricción" : "restricciones"}`,
                  brief.discarded.length && `${brief.discarded.length} descartado${brief.discarded.length === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "la propuesta elegida"}{" "}
                <button className="link small" onClick={() => setBrief(null)} title="La escena se escribirá sólo con el argumento">
                  Quitar
                </button>
              </p>
              {(brief.decisions.length > 0 || brief.constraints.length > 0 || brief.discarded.length > 0) && (
                <details>
                  <summary className="small muted">Ver lo que va con la escena</summary>
                  <ul className="small">
                    {brief.decisions.map((d, i) => (
                      <li key={`d${i}`}>Decisión: {d}</li>
                    ))}
                    {brief.constraints.map((d, i) => (
                      <li key={`c${i}`}>Restricción: {d}</li>
                    ))}
                    {brief.discarded.map((d, i) => (
                      <li key={`x${i}`}>Descartado: {d}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          <p className="muted small field-help">
            Escríbelo como te salga: Procesador lo desarrolla en prosa, con la voz y el contexto de tu novela. Los personajes y
            lugares que nombres se incluyen solos.
          </p>
          <div className="controls scene-controls">
            <fieldset className="checks inline scene-target">
              <legend>Dónde va</legend>
              {(
                [
                  ["end", "Al final del capítulo"],
                  ["cursor", "En el cursor"],
                ] as const
              ).map(([id, label]) => (
                <label key={id} className="check">
                  <input
                    type="radio"
                    name="scene-target"
                    checked={sceneTarget === id}
                    onChange={() => {
                      setSceneTarget(id);
                      writePref("sceneTarget", id);
                    }}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <p className="muted small check-help scene-target-help">
              {sceneTarget === "end"
                ? "Continúa el final del capítulo, esté donde esté el cursor."
                : "Se escribe para la posición del cursor, que queda fijada al pedirla."}
            </p>
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
            {contextControls}
          </div>
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
      {!overview && advanced}

      {showResult && parsed && last && (
        <section className="result" aria-live="polite" ref={resultRef} data-origin={`results["${slot}"] (showResult && parsed && last)`}>
          <div className="result-head">
            <span className="muted small">Respuesta del {last.section === "advisor" ? "Consejero" : "Asistente"}</span>
            <span className="spacer" />
            {last.section === "advisor" ? (
              <button className="link small" onClick={discard} title="Quitar esta propuesta del panel sin usarla">
                Limpiar
              </button>
            ) : (
              canRead && (
                <button className="link small" onClick={() => setReaderOpen(true)} title="Leer la propuesta en grande, con sus acciones">
                  Abrir propuesta
                </button>
              )
            )}
          </div>
          {parsed.notes && (
            <div className="markdown">
              <ReactMarkdown>{parsed.notes}</ReactMarkdown>
            </div>
          )}
          {runningHere && !output && <p className="muted">{last.mode === "scene" ? "Escribiendo…" : "Pensando…"}</p>}

          {parsed.proposal !== null && rewrite && last.target ? (
            // Comparar antes de aplicar: the author's text and the proposal, as prose.
            <div className="compare" data-origin="comparación (texto actual ↔ propuesta)">
              <div className="compare-tabs" role="group" aria-label="Cómo ver la propuesta">
                {(
                  [
                    ["changes", "Cambios"],
                    ["proposal", "Propuesta"],
                    ["original", "Tu texto"],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} className={compareView === id ? "on" : undefined} aria-pressed={compareView === id} onClick={() => setCompareView(id)}>
                    {label}
                  </button>
                ))}
              </div>
              {compareView === "changes" && (
                <>
                  <p className="muted small compare-summary">
                    {rewrite.stats.added || rewrite.stats.removed
                      ? `La IA propone quitar ${wordsLabel(rewrite.stats.removed)} y añadir ${wordsLabel(rewrite.stats.added)}. Tachado: lo que se quita; resaltado: lo que se añade.`
                      : "La propuesta deja el fragmento igual."}
                  </p>
                  <DiffView ops={rewrite.ops} label="Cambios que propone la IA" />
                </>
              )}
              {compareView === "proposal" && (
                <DiffView ops={[{ kind: "same", text: rewrite.restored.text }]} label="Propuesta de la IA" full />
              )}
              {compareView === "original" && (
                <DiffView ops={[{ kind: "same", text: last.target.text }]} label="Tu texto actual" full />
              )}
              {parsed.warning && <p className="notice">Aviso: {parsed.warning}</p>}
              {judgeKey && judgment?.for === judgeKey && <Judgment j={judgment} />}
            </div>
          ) : parsed.proposal !== null && sceneReady ? (
            // A scene: what goes in, and exactly where.
            <div className="compare" data-origin="vista previa de la inserción">
              <p className="insert-where" data-target={insertTarget.kind}>
                {insertTarget.kind === "end" ? (
                  <strong>Se insertará al final del capítulo</strong>
                ) : (
                  <strong>Se insertará en la posición actual</strong>
                )}
                <span className="muted small">
                  {" "}
                  · {here}
                  {insertTarget.kind === "end"
                    ? ", después de su último párrafo."
                    : insertion?.atStart
                      ? ", al principio. Es la posición fijada al elegirla: mover el cursor no la cambia."
                      : ", entre estos párrafos. Es la posición fijada al elegirla: mover el cursor no la cambia."}
                </span>
              </p>
              {!insertion ? (
                <p className="notice" role="alert">
                  El texto alrededor del lugar fijado cambió y ya no se encuentra. Fíjalo de nuevo en el cursor o inserta al final.
                </p>
              ) : (
              <DiffView
                ops={[
                  { kind: "same", text: insertion.before },
                  { kind: "add", text: insertion.scene },
                  { kind: "same", text: insertion.after },
                ]}
                label="La escena en su lugar"
                full
              />
              )}
              {insertTarget.kind === "at" && (
                <p className="small insert-options">
                  <button type="button" className="link small" onClick={fixHere}>
                    Fijar en la posición actual del cursor
                  </button>
                  {" · "}
                  <button type="button" className="link small" onClick={() => update(slot, () => ({ insertTarget: { kind: "end" }, applyFailed: null }))}>
                    Insertar al final en su lugar
                  </button>
                </p>
              )}
              {parsed.warning && <p className="notice">Aviso: {parsed.warning}</p>}
            </div>
          ) : (
            parsed.proposal !== null && (
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
            )
          )}

          {!runningHere && last.mode === "scene" && parsed && parsed.proposal === null && parsed.warning && (
            <div className="compare contradiction" data-origin="aviso de contradicción (escena)">
              <p className="notice" role="alert">
                <strong>El argumento contradice algo establecido:</strong> {parsed.warning}
              </p>
              <p className="small">
                Tú decides. Si quieres cambiar ese hecho, el Asistente escribirá la escena según tu argumento; si no, corrige el argumento.{" "}
                <button
                  type="button"
                  className="link small strong"
                  onClick={() => run({ ...last, body: { ...last.body, confirmChange: true } }, last.provider)}
                >
                  Escribir igualmente: cambio ese hecho
                </button>
              </p>
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
          {!runningHere && result?.sent && (
            <p className="muted small">
              <button type="button" className="link small" aria-expanded={showSent} onClick={() => setShowSent(!showSent)}>
                {showSent ? "Ocultar lo que se envió" : "Ver lo que se envió"}
              </button>
            </p>
          )}
          {showSent && result?.sent && (
            <ContextView
              sections={result.sent.sections}
              total={result.sent.total}
              instructions={result.sent.instructions}
              includeManuscript={last.body.includeManuscript === true}
              scene={last.mode === "scene"}
              notices={result.sent.notices}
              sent
            />
          )}

          {!runningHere && (
            <div className="compare-actions">
              {rewrite && last.target && (
                <button
                  className="btn primary"
                  disabled={applying}
                  onClick={() => {
                    // The model saw [IMAGEN n] and `* * *`: the real markers are back in `restored`.
                    if (rewrite.restored.missing.length) return update(slot, () => ({ lostImages: rewrite.restored }));
                    accept(() => onApply(last.target!, rewrite.restored.text));
                  }}
                >
                  {applying ? "Guardando una copia…" : "Reemplazar selección"}
                </button>
              )}
              {sceneReady && parsed.proposal && (
                <button
                  className="btn primary"
                  disabled={applying || !insertion}
                  onClick={() => accept(() => onInsert(fromModel(parsed.proposal!), insertTarget))}
                >
                  {applying ? "Guardando una copia…" : insertTarget.kind === "end" ? "Insertar al final" : "Insertar en el cursor"}
                </button>
              )}
              {sceneReady && parsed.proposal && insertTarget.kind === "end" && (
                <button
                  className="btn ghost"
                  disabled={applying}
                  onClick={fixHere}
                  title="Muestra dónde está ahora el cursor y fija allí la escena; después se confirma"
                >
                  Insertar en el cursor…
                </button>
              )}
              <button className="btn ghost" onClick={() => run(last, last.provider)}>
                Otra versión
              </button>
              {last.section === "assistant" && (
                <button className="btn ghost" onClick={discard} title="Quitar esta propuesta sin usarla">
                  Descartar
                </button>
              )}
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
                  disabled={applying}
                  onClick={() => accept(() => onApply(last.target!, appendImages(lostImages.text, lostImages.missing)))}
                >
                  Aplicar y colocar la imagen al final
                </button>
                <button className="btn ghost" onClick={() => update(slot, () => ({ lostImages: null }))}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {result?.continuity && result.continuity.length > 0 && (
            <div className="continuity-note" role="note" aria-label="Continuidad">
              <p className="small">
                <strong>Revisa la continuidad</strong> <span className="muted">· comprobado con la Memoria y lo ya escrito, sin IA</span>
              </p>
              <ul className="small">
                {result.continuity.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}
          {result?.applyFailed && (
            <p className="error small" role="alert">
              {result.applyFailed}
            </p>
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
      {readerOpen && reader && last && (
        <ProposalReader
          title={reader.title}
          where={reader.where}
          text={reader.text}
          changes={reader.changes}
          original={reader.original}
          words={countWords(reader.text)}
          primary={reader.primary}
          primaryDisabled={reader.primaryDisabled}
          notice={reader.notice ?? (result?.applyFailed || null)}
          onPrimary={reader.onPrimary}
          onRetry={() => {
            setReaderOpen(false);
            run(last, last.provider);
          }}
          onDiscard={() => {
            setReaderOpen(false);
            discard();
          }}
          onClose={() => setReaderOpen(false)}
        />
      )}
    </aside>
  );
}

export default memo(AssistantPanel);
