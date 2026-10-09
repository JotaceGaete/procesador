"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AIPanelSection,
  Chapter,
  ChronologyView,
  Fact,
  ChapterInfo,
  CharacterImage,
  ManuscriptImage,
  Memory,
  Novel,
  ProviderId,
} from "@/lib/types";
import { api, ApiError, readPref, writePref } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { SaveState } from "./useAutosave";
import ChapterEditor, { type EditorHandle, type SaveActions, type Selection } from "./ChapterEditor";
import VisualEditor from "./VisualEditor";
import ChapterNav from "./ChapterNav";
import { TrashModal, VersionsModal } from "./Versions";
import CriticReport from "./CriticReport";
import { ChronologyModal } from "./Chronology";
import NovelModal from "./NovelModal";
import MemoryModal from "./MemoryModal";
import AssistantPanel from "./AssistantPanel";
import { ChapterImagesModal, ImageCard, ReadingView, type Pending } from "./ManuscriptImages";
import { addManuscriptImage, rejectReason, replaceImage } from "@/lib/upload";
import { imageAt, imageIds } from "@/lib/manuscript";
import { chapterHeading } from "@/lib/presentation";
import { resolveAnchor, type InsertTarget } from "@/lib/placement";
import { checkTarget, type ApplyAction } from "@/lib/chapter-lock";

interface Loaded {
  novel: Novel;
  chapters: ChapterInfo[];
  memory: Memory;
  images: CharacterImage[];
  manuscriptImages: ManuscriptImage[];
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  confirmTokens: number;
}

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Guardado",
  pending: "Sin guardar",
  saving: "Guardando…",
  error: "No se pudo guardar · reintentando",
  conflict: "Cambió en otro lugar",
  locked: "No se guardó: el capítulo está bloqueado",
};

/** What the author is told when something tries to change a locked chapter. */
const LOCKED_NOTICE = "Este capítulo está revisado y bloqueado. Desbloquéalo (🔒) para modificarlo.";

export default function Workspace({ novelId }: { novelId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);
  const [memory, setMemory] = useState<Memory>({ characters: [], relationships: [], places: [], facts: [] });
  // Character galleries: never part of `memory`, which is what the assistant receives.
  const [images, setImages] = useState<CharacterImage[]>([]);
  const onImagesChange = useCallback(
    (characterId: string, list: CharacterImage[]) =>
      setImages((all) => [...all.filter((i) => i.character_id !== characterId), ...list]),
    [],
  );
  const [chapter, setChapter] = useState<Chapter | null>(null);

  // Images of the book: their markers live in the chapter text, their data here.
  const [manuscriptImages, setManuscriptImages] = useState<ManuscriptImage[]>([]);
  const [pending, setPending] = useState<Pending>({});
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null); // the text shown in the reading view
  const [notice, setNotice] = useState("");
  const setAll = useCallback((all: { images: CharacterImage[]; manuscriptImages: ManuscriptImage[] }) => {
    setImages(all.images);
    setManuscriptImages(all.manuscriptImages);
  }, []);
  const upsertImage = useCallback(
    (img: ManuscriptImage) => setManuscriptImages((list) => [...list.filter((x) => x.id !== img.id), img]),
    [],
  );
  const onCaret = useCallback((position: number, text: string) => setActiveImage(imageAt(text, position)?.id ?? null), []);
  /** Shows a just-inserted image's card without moving the cursor onto its marker (after the editor's own caret update). */
  const showCard = useCallback((id: string) => requestAnimationFrame(() => requestAnimationFrame(() => setActiveImage(id))), []);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const [save, setSave] = useState<{ state: SaveState } & SaveActions>({
    state: "saved",
    retry() {},
    overwrite() {},
    resume() {},
  });

  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [section, setSection] = useState<AIPanelSection>("assistant");
  // A Consejero "Ir" into another chapter: applied once that chapter's editor is mounted.
  const pendingGoTo = useRef<{ chapterId: string; start: number; end: number; text: string } | null>(null);
  // Chapters written in during this visit: leaving one may re-read it (Consejero, auto_digest).
  const edited = useRef(new Set<string>());
  const [focusMode, setFocusMode] = useState(false);
  // Editor visual (docs/editor-visual.md): the default. The plain editor stays as a manual fallback,
  // chosen with the switch in the chapter list and remembered per device. `?editor=visual` or
  // `?editor=texto` sets it too (and is remembered). With nothing stored, nothing is written: a
  // device that never chose follows the default.
  const [visualEditor, setVisualEditor] = useState(() => {
    if (typeof window === "undefined") return true;
    const asked = new URLSearchParams(window.location.search).get("editor");
    if (asked === "visual" || asked === "texto") writePref("editor", asked);
    const pref = readPref("editor");
    const chosen = asked === "visual" || asked === "texto" ? asked : pref === "visual" || pref === "texto" ? pref : null;
    return chosen !== "texto";
  });
  const [modal, setModal] = useState<"novel" | "plot" | "memory" | "images" | "versions" | "trash" | "chronology" | "critic" | null>(
    null,
  );
  const editorRef = useRef<EditorHandle>(null);
  // Bloqueo de capítulos (docs/bloqueo-capitulos.md). The chapter list carries each chapter's
  // lock; these refs are what the checks read at the moment of applying, never a stale render.
  const locked = Boolean(chapter && chapters.find((c) => c.id === chapter.id)?.locked);
  const chapterIdRef = useRef<string | null>(null);
  chapterIdRef.current = chapter?.id ?? null;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  /** Stops (throws) when a proposal of `chapterId` can't be applied now: another chapter is open, or it is locked. */
  const assertTarget = useCallback((chapterId: string, action: ApplyAction) => {
    const check = checkTarget({
      proposalChapterId: chapterId,
      openChapterId: chapterIdRef.current,
      editorChapterId: editorRef.current?.getChapterId() ?? null,
      locked: lockedRef.current,
      action,
      label(id) {
        const list = chaptersRef.current;
        const i = list.findIndex((c) => c.id === id);
        return i === -1 ? null : chapterLabel(i, list[i].title, list[i].reserved);
      },
    });
    if (!check.ok) throw new Error(check.message);
  }, []);
  /** Tells the author the chapter is locked when something tried to change it; true if it is. */
  const refuseIfLocked = useCallback(() => {
    if (!lockedRef.current) return false;
    setNotice(LOCKED_NOTICE);
    return true;
  }, []);

  const openChapter = useCallback(async (id: string) => {
    const data = await api<Chapter>(`/api/chapters/${id}`);
    setSelection(null);
    setActiveImage(null);
    setReading(null);
    setChapter(data);
    // The lock as the server has it now (another tab or device may have changed it).
    setChapters((list) => list.map((c) => (c.id === id && c.locked !== data.locked ? { ...c, locked: data.locked } : c)));
    writePref(`chapter:${data.novel_id}`, id);
  }, []);

  useEffect(() => {
    api<Loaded>(`/api/novels/${novelId}`)
      .then(async (data) => {
        setLoaded(data);
        setNovel(data.novel);
        setChapters(data.chapters);
        setMemory(data.memory);
        setImages(data.images);
        setManuscriptImages(data.manuscriptImages);
        writePref("lastNovel", novelId);
        // Continue where the author left off in this novel.
        const last = readPref(`chapter:${novelId}`);
        await openChapter(data.chapters.find((c) => c.id === last)?.id ?? data.chapters[0].id);
      })
      .catch((e: Error) => setLoadError(e.message));
    const wide = window.matchMedia("(min-width: 1000px)").matches;
    const panelPref = readPref("panelOpen");
    setPanelOpen(panelPref ? panelPref === "1" : wide);
    setNavOpen(wide && readPref("navOpen") === "1");
    if (readPref("panelSection") === "advisor") setSection("advisor");
  }, [novelId, openChapter]);

  // Keep the chapter list's counts in step with the chapter being written.
  const currentId = chapter?.id;
  useEffect(() => {
    if (!currentId) return;
    setChapters((list) => list.map((c) => (c.id === currentId ? { ...c, words: stats.words, chars: stats.chars } : c)));
  }, [currentId, stats]);

  /** Never leaves a chapter with text that didn't reach the server without asking. */
  const leaveChapter = useCallback(async () => {
    if (!editorRef.current || (await editorRef.current.flush())) {
      if (chapter) rereadLater(chapter.id);
      return true;
    }
    return confirm("Los últimos cambios de este capítulo no se pudieron guardar. Si continúas, se perderán. ¿Continuar?");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rereadLater reads refs and current state
  }, [chapter?.id, novel?.auto_digest, loaded]);

  /**
   * The switch's moment to re-read (decision 2): on leaving a chapter that was written in,
   * in the background, never while typing. The server decides whether the change was
   * substantial; small edits never reach the AI.
   */
  function rereadLater(id: string) {
    if (!edited.current.delete(id) || !novel?.auto_digest || !loaded) return;
    const saved = readPref("provider") as ProviderId | null;
    const provider = saved && loaded.providers.includes(saved) ? saved : loaded.defaultProvider;
    if (!provider) return;
    fetch(`/api/chapters/${id}/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, auto: true }),
      keepalive: true,
    }).catch(() => {});
  }

  const narrow = () => !window.matchMedia("(min-width: 1000px)").matches;
  /** Switches editor: the text is saved first, and the other editor opens that text. */
  const toggleVisualEditor = useCallback(async () => {
    if (!(await leaveChapter())) return;
    const next = !visualEditor;
    writePref("editor", next ? "visual" : "texto");
    // The other editor opens the saved text (the chapter as the server has it now).
    if (chapter) await openChapter(chapter.id);
    setVisualEditor(next);
  }, [visualEditor, leaveChapter, chapter, openChapter]);

  const switchChapter = useCallback(
    async (id: string) => {
      // On a phone the list is a drawer over the text: picking any chapter closes it.
      if (narrow()) setNavOpen(false);
      if (id === chapter?.id || !(await leaveChapter())) return;
      await openChapter(id);
    },
    [chapter?.id, leaveChapter, openChapter],
  );

  const chooseSection = useCallback((s: AIPanelSection) => {
    setSection(s);
    writePref("panelSection", s);
  }, []);

  /** The topbar's Asistente and Consejero: open the panel on that section, or close it if already there. */
  const openSection = (s: AIPanelSection) => {
    if (panelOpen && !focusMode && section === s) return toggle("panelOpen", setPanelOpen);
    chooseSection(s);
    if (!panelOpen) toggle("panelOpen", setPanelOpen);
  };

  const goTo = useCallback(
    async (chapterId: string, start: number, end: number, text: string) => {
      if (narrow()) setPanelOpen(false);
      if (chapterId === chapter?.id) {
        editorRef.current?.selectRange(start, end, text);
        return;
      }
      pendingGoTo.current = { chapterId, start, end, text };
      if (!(await leaveChapter())) {
        pendingGoTo.current = null;
        return;
      }
      await openChapter(chapterId);
    },
    [chapter?.id, leaveChapter, openChapter],
  );

  useEffect(() => {
    const p = pendingGoTo.current;
    if (!p || p.chapterId !== chapter?.id) return;
    pendingGoTo.current = null;
    requestAnimationFrame(() => editorRef.current?.selectRange(p.start, p.end, p.text));
  }, [chapter?.id]);

  const toggle = (key: "navOpen" | "panelOpen", set: (fn: (v: boolean) => boolean) => void) => {
    // On a phone the drawer and the bottom sheet would cover each other: one at a time.
    if (narrow()) (key === "navOpen" ? setPanelOpen : setNavOpen)(false);
    set((open) => {
      writePref(key, open ? "0" : "1");
      return !open;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        save.retry();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        setFocusMode((f) => !f);
      } else if (e.key === "Escape" && focusMode && !modal) {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, focusMode, modal]);

  const onSaveState = useCallback(
    (state: SaveState, actions: SaveActions) => {
      if (state === "pending" && currentId) edited.current.add(currentId);
      // The server refused a save because the chapter is locked (in another tab or device):
      // this tab shows it locked too, with the unsaved text still on screen.
      if (state === "locked" && currentId)
        setChapters((list) => list.map((c) => (c.id === currentId ? { ...c, locked: true } : c)));
      setSave({ state, ...actions });
    },
    [currentId],
  );
  const flush = useCallback(async () => !editorRef.current || (await editorRef.current.flush()), []);
  // A fact the Consejero proposed (suggested): Memoria shows it at once.
  const onFactAdded = useCallback((f: Fact) => setMemory((m) => ({ ...m, facts: [...m.facts, f] })), []);
  const onAutoDigest = useCallback((on: boolean) => setNovel((n) => (n ? { ...n, auto_digest: on } : n)), []);
  const getContent = useCallback(() => editorRef.current?.getContent() ?? "", []);
  const getCursor = useCallback(() => editorRef.current?.getCursor() ?? 0, []);
  // A proposal of the Asistente reached the manuscript: say so next to the text, with
  // Deshacer (the editor's own undo, as Ctrl/⌘+Z). On a phone the sheet closes, so the
  // manuscript is in view with the cursor at the end of the new text.
  const [applied, setApplied] = useState<string | null>(null);
  useEffect(() => {
    if (!applied) return;
    const t = setTimeout(() => setApplied(null), 10_000);
    return () => clearTimeout(t);
  }, [applied]);
  // iOS keeps fixed elements behind the on-screen keyboard (Android resizes the layout
  // instead): the bottom sheet and the confirmation follow the visible area through
  // --kb (what the keyboard covers) and --vvh (the visible height).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty("--kb", `${Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))}px`);
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  /**
   * Keeps the text as it is now as a version (docs/versiones.md) before something replaces it.
   * The text is taken right away, so what follows can change the editor at once.
   */
  const keepVersion = useCallback((chapterId: string, reason: "ai" | "restore") => {
    const content = editorRef.current?.getContent();
    if (content === undefined) return Promise.resolve();
    // The server refuses it (423) if the chapter is locked: then nothing is applied.
    return api(`/api/chapters/${chapterId}/versions`, { method: "POST", json: { reason, content } });
  }, []);
  /**
   * Applying a proposal of the Asistente (docs/asistente-contexto.md, «Comparar antes de
   * aplicar»): the current text is kept as a version first, and only then does the manuscript
   * change. If the copy can't be saved, nothing is applied (the panel keeps the proposal).
   */
  const keepBeforeAI = useCallback(
    async (chapterId: string) => {
      try {
        await keepVersion(chapterId, "ai");
      } catch (e) {
        if (e instanceof ApiError && e.status === 423) {
          setChapters((list) => list.map((c) => (c.id === chapterId ? { ...c, locked: true } : c)));
          throw new Error(`${e.message} No se ha aplicado nada.`);
        }
        throw new Error("No se pudo guardar una copia del texto actual, así que no se ha aplicado nada. Vuelve a intentarlo.");
      }
    },
    [keepVersion],
  );
  /** Versiones → Restaurar: the current text becomes a version first; if that fails, nothing changes. */
  const restoreVersion = useCallback(
    async (text: string) => {
      const id = chapterIdRef.current;
      if (!id || lockedRef.current) throw new Error(LOCKED_NOTICE);
      await keepVersion(id, "restore");
      // Still the same chapter, still unlocked, after the copy was saved.
      if (chapterIdRef.current !== id || editorRef.current?.getChapterId() !== id || lockedRef.current)
        throw new Error("El capítulo cambió mientras se guardaba la copia. No se ha restaurado nada.");
      setModal(null);
      setReading(null);
      editorRef.current?.replaceAll(text);
      setApplied("Versión restaurada en el manuscrito.");
    },
    [keepVersion],
  );

  const afterApply = useCallback((ok: boolean, message: string) => {
    if (ok) {
      setApplied(message);
      if (narrow()) setPanelOpen(false);
    }
    return ok;
  }, []);
  /** The editor's own edit; if the browser refuses it, nothing was applied (false). */
  const attempt = (edit: () => boolean | undefined) => {
    try {
      return edit() ?? false;
    } catch {
      return false;
    }
  };
  /**
   * Proposals of the Asistente belong to the chapter they were written for (docs/bloqueo-
   * capitulos.md): the chapter open, the editor's chapter and the lock are checked right before
   * the copy is kept, and again right after (the author may have switched chapter meanwhile).
   * Never applied to another chapter, never to a locked one.
   */
  const applyRewrite = useCallback(
    async (chapterId: string, original: Selection, text: string) => {
      assertTarget(chapterId, "replace");
      await keepBeforeAI(chapterId);
      assertTarget(chapterId, "replace");
      return afterApply(attempt(() => editorRef.current?.applyRewrite(original, text)), "Reemplazado en el manuscrito.");
    },
    [afterApply, keepBeforeAI, assertTarget],
  );
  /**
   * A scene of the Asistente, where the panel says (docs/asistente-contexto.md §11): the
   * chapter's real end at this moment, or the fixed position, found again by its anchor
   * after the copy is saved. If that place is gone, nothing is inserted.
   */
  const insertScene = useCallback(
    async (chapterId: string, text: string, target: InsertTarget) => {
      assertTarget(chapterId, "insert");
      await keepBeforeAI(chapterId);
      assertTarget(chapterId, "insert");
      if (target.kind === "end")
        return afterApply(attempt(() => editorRef.current?.insertAtEnd(text)), "Escena insertada al final del capítulo.");
      const at = resolveAnchor(editorRef.current?.getContent() ?? "", target.anchor);
      if (at === null)
        throw new Error("El texto alrededor del lugar fijado cambió y ya no se encuentra. Fíjalo de nuevo o inserta al final.");
      return afterApply(attempt(() => editorRef.current?.insertAt(at, text)), "Escena insertada en el lugar fijado.");
    },
    [afterApply, keepBeforeAI, assertTarget],
  );
  const clearSelection = useCallback(() => editorRef.current?.clearSelection(), []);

  /**
   * Pasted, dropped or chosen image files: each gets its marker at the cursor right
   * away (so it keeps its place and undo works), then uploads in the background.
   */
  const insertFiles = useCallback(
    async (files: File[]) => {
      if (refuseIfLocked()) return;
      const ok = files.filter((f) => {
        const reason = rejectReason(f);
        if (reason) setNotice(`${f.name}: ${reason}`);
        return !reason;
      });
      if (!ok.length) return;
      const items = ok.map((file) => ({ id: crypto.randomUUID(), file }));
      setPending((p) => ({ ...p, ...Object.fromEntries(items.map((i) => [i.id, { name: i.file.name, stage: "preparing" as const }])) }));
      setReading(null);
      editorRef.current?.insertImages(items.map((i) => i.id));
      showCard(items[items.length - 1].id);
      for (const item of items) {
        const update = (patch: Partial<Pending[string]>) => setPending((p) => ({ ...p, [item.id]: { ...p[item.id], ...patch } }));
        try {
          const r = await addManuscriptImage({
            novelId,
            id: item.id,
            file: item.file,
            onProgress: (stage, fraction) => update({ stage, fraction }),
          });
          upsertImage(r.image);
          setPending((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== item.id)));
          if (r.notice) setNotice(r.notice);
        } catch (e) {
          update({ stage: "error", error: (e as Error).message });
        }
      }
    },
    [novelId, upsertImage, refuseIfLocked],
  );

  /** A file the novel already has (from a gallery): a new image of the book, same file, not copied. */
  const insertFromAsset = useCallback(
    async (assetId: string) => {
      if (refuseIfLocked()) {
        setModal(null);
        return;
      }
      try {
        const img = await api<ManuscriptImage>(`/api/novels/${novelId}/manuscript-images`, {
          method: "POST",
          json: { asset_id: assetId, id: crypto.randomUUID() },
        });
        upsertImage(img);
        setModal(null);
        setReading(null);
        editorRef.current?.insertImages([img.id]);
        showCard(img.id);
        setNotice("Imagen insertada con el mismo archivo de la galería, sin guardar otra copia.");
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [novelId, upsertImage, refuseIfLocked],
  );

  /**
   * The discreet lock in the top bar. Locking saves first (what is locked is what is on the
   * server); unlocking is always the author's explicit choice, confirmed, and then saves whatever
   * a lock refused in this tab.
   */
  const [lockBusy, setLockBusy] = useState(false);
  const toggleLock = useCallback(async () => {
    const id = chapterIdRef.current;
    if (!id || lockBusy) return;
    const next = !lockedRef.current;
    const i = chaptersRef.current.findIndex((c) => c.id === id);
    const name = i === -1 ? "este capítulo" : `«${chapterLabel(i, chaptersRef.current[i].title, chaptersRef.current[i].reserved)}»`;
    if (next) {
      if (editorRef.current && !(await editorRef.current.flush())) {
        setNotice("No se pudo guardar el texto, así que no se ha bloqueado. Vuelve a intentarlo.");
        return;
      }
    } else if (!confirm(`¿Desbloquear ${name} para volver a editarlo?`)) return;
    setLockBusy(true);
    try {
      const res = await api<{ locked: boolean }>(`/api/chapters/${id}`, { method: "PATCH", json: { locked: next } });
      setChapters((list) => list.map((c) => (c.id === id ? { ...c, locked: res.locked } : c)));
      setNotice("");
      if (!res.locked) save.resume();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLockBusy(false);
    }
  }, [lockBusy, save]);

  const refreshManuscriptImages = useCallback(
    () => api<ManuscriptImage[]>(`/api/novels/${novelId}/manuscript-images`).then(setManuscriptImages).catch(() => {}),
    [novelId],
  );

  // Cronología (docs/cronologia-edades.md): computed on the server; reloaded when the memory or
  // the chapters change, and when the view opens (who appears where depends on the texts).
  const [chronologyView, setChronologyView] = useState<ChronologyView | null>(null);
  const refreshChronology = useCallback(
    () => api<ChronologyView>(`/api/novels/${novelId}/chronology`).then(setChronologyView).catch(() => {}),
    [novelId],
  );
  useEffect(() => {
    if (loaded) void refreshChronology();
  }, [loaded, memory, chapters, refreshChronology]);
  const timeWarnings = chronologyView?.warnings.filter((w) => !w.dismissed).length ?? 0;

  if (loadError) {
    return (
      <main className="fatal">
        <h1>No se pudo abrir la novela</h1>
        <p>{loadError}</p>
        <p>
          <Link href="/">Volver a la biblioteca</Link>
        </p>
      </main>
    );
  }
  if (!loaded || !novel || !chapter) return <main className="fatal muted">Cargando…</main>;

  const chapterIndex = chapters.findIndex((c) => c.id === chapter.id);
  const current = chapters[chapterIndex];
  // Its number is its place in the manuscript; a chapter in reserve has none (docs/capitulos-reserva.md).
  const reserved = current?.reserved === true;
  const shown = (c: ChapterInfo) => chapterLabel(chapters.filter((x) => !x.reserved).indexOf(c), c.title, c.reserved);
  // Whole novel size for the "include manuscript" estimate: what the AI may read (the manuscript,
  // and this chapter if it is in reserve), saved chapters plus the live one.
  const novelChars = chapters
    .filter((c) => !c.reserved || c.id === chapter.id)
    .reduce((n, c) => n + (c.id === chapter.id ? stats.chars : c.chars), 0);
  const showNav = navOpen && !focusMode;
  const showPanel = panelOpen && !focusMode;

  return (
    <div className={`workspace${focusMode ? " focus" : ""}${showPanel ? " with-panel" : ""}${showNav ? " with-nav" : ""}`}>
      <ChapterNav
        hidden={!showNav}
        novelId={novel.id}
        chapters={chapters}
        currentId={chapter.id}
        onSelect={switchChapter}
        onChange={setChapters}
        onClose={() => toggle("navOpen", setNavOpen)}
        onVersions={() => {
          if (narrow()) setNavOpen(false);
          setModal("versions");
        }}
        onTrash={() => {
          if (narrow()) setNavOpen(false);
          setModal("trash");
        }}
        timeWarnings={timeWarnings}
        onChronology={() => {
          if (narrow()) setNavOpen(false);
          void refreshChronology();
          setModal("chronology");
        }}
        visualEditor={visualEditor}
        onToggleVisualEditor={() => void toggleVisualEditor()}
        onNovel={() => {
          if (narrow()) setNavOpen(false);
          setModal("novel");
        }}
        onPlot={() => {
          if (narrow()) setNavOpen(false);
          setModal("plot");
        }}
        beforeDeleteCurrent={async (neighborId) => {
          if (!(await leaveChapter())) return false;
          await openChapter(neighborId);
          return true;
        }}
      />

      <main className="editor-col" data-origin="manuscrito (editor)">
        {/* Its own container: the bar adapts to the column's width (container query) without making
            the whole column, editor included, a container (slower typing in long chapters). */}
        <div className="topbar-wrap">
          <header className="topbar">
            <Link
              href="/"
              className="link"
              title="Biblioteca"
              onClick={async (e) => {
                e.preventDefault();
                if (await leaveChapter()) window.location.href = "/";
              }}
            >
              ←
            </Link>
            <button className="link title" onClick={() => setModal("novel")} title="Novela, Guía Maestra y libro">
              {novel.title}
            </button>
            <button
              className={`link chapter-title${showNav ? " on" : ""}`}
              onClick={() => toggle("navOpen", setNavOpen)}
              title="Capítulos"
            >
              {current ? shown(current) : ""}
            </button>
            <span className="spacer" />
            <span className="meta words">{stats.words.toLocaleString("es")} palabras</span>
            <LockToggle locked={locked} busy={lockBusy} onToggle={() => void toggleLock()} />
            <SaveStatus state={save.state} onRetry={save.retry} onOverwrite={save.overwrite} />
            {/* Formato (docs/formato-texto.md). The text keeps the focus, and with it the selection. */}
            <span className="format-actions">
              <button
                className="link format"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editorRef.current?.toggleItalic()}
                disabled={reading !== null || locked}
                title="Cursiva (Ctrl/⌘+I): *así*"
                aria-label="Cursiva"
              >
                <em>C</em>
              </button>
              <button
                className="link format"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editorRef.current?.insertSeparator()}
                disabled={reading !== null || locked}
                title="Separador de escena"
                aria-label="Separador de escena"
              >
                ⁂
              </button>
            </span>
            <button
              className="link"
              onClick={() => {
                refreshManuscriptImages();
                setModal("images");
              }}
            >
              Imágenes
            </button>
            <button
              className={`link${reading !== null ? " on" : ""}`}
              aria-pressed={reading !== null}
              onClick={() => setReading((r) => (r === null ? (editorRef.current?.getContent() ?? "") : null))}
              title="Ver el capítulo con sus imágenes"
            >
              Lectura
            </button>
            <button className="link" onClick={() => setModal("memory")}>
              Memoria
            </button>
            <button
              className={`link${showPanel && section === "assistant" ? " on" : ""}`}
              onClick={() => openSection("assistant")}
              aria-pressed={showPanel && section === "assistant"}
            >
              Asistente
            </button>
            <button
              className={`link${showPanel && section === "advisor" ? " on" : ""}`}
              onClick={() => openSection("advisor")}
              aria-pressed={showPanel && section === "advisor"}
            >
              Consejero
            </button>
            <button
              className={`link${modal === "critic" ? " on" : ""}`}
              onClick={() => setModal("critic")}
              title="Evaluar el capítulo: juzga, no cambia el texto"
            >
              Crítico
            </button>
            <button className="link focus-toggle" onClick={() => setFocusMode((f) => !f)} title="Ctrl/⌘ + .  ·  Esc para salir">
              {focusMode ? "Salir" : "Concentración"}
            </button>
          </header>
        </div>
        {visualEditor ? (
          <VisualEditor
            key={`${chapter.id}:visual`}
            ref={editorRef}
            chapterId={chapter.id}
            initial={{ content: chapter.content, revision: chapter.revision }}
            locked={locked}
            focusMode={focusMode}
            onSelection={setSelection}
            onStats={setStats}
            onSaveState={onSaveState}
            onCaret={onCaret}
            onImageFiles={insertFiles}
            hidden={reading !== null}
            heading={current ? chapterHeading(chapterIndex, current.title, reserved) : undefined}
            images={manuscriptImages}
            pending={pending}
          />
        ) : (
          <ChapterEditor
            key={chapter.id}
            ref={editorRef}
            chapterId={chapter.id}
            initial={{ content: chapter.content, revision: chapter.revision }}
            locked={locked}
            focusMode={focusMode}
            onSelection={setSelection}
            onStats={setStats}
            onSaveState={onSaveState}
            onCaret={onCaret}
            onImageFiles={insertFiles}
            onLockedEdit={refuseIfLocked}
            hidden={reading !== null}
          />
        )}
        {reading !== null && (
          <ReadingView
            text={reading}
            heading={current ? chapterHeading(chapterIndex, current.title, reserved) : undefined}
            images={manuscriptImages}
            pending={pending}
            onOpen={(id) => {
              setReading(null);
              requestAnimationFrame(() => editorRef.current?.selectImage(id));
            }}
          />
        )}
        {applied && !notice && (
          <p className="editor-notice applied" role="status">
            {applied}{" "}
            <button
              className="link"
              onClick={() => {
                editorRef.current?.undo();
                setApplied(null);
              }}
            >
              Deshacer
            </button>
            <span className="kbd-hint muted"> (Ctrl/⌘+Z)</span>{" "}
            <button className="link muted" onClick={() => setApplied(null)} aria-label="Cerrar aviso">
              ×
            </button>
          </p>
        )}
        {notice && (
          <p className="editor-notice" role="status">
            {notice}{" "}
            <button className="link" onClick={() => setNotice("")}>
              Cerrar
            </button>
          </p>
        )}
        {activeImage && reading === null && !modal && (
          <ImageCard
            key={activeImage}
            id={activeImage}
            image={manuscriptImages.find((i) => i.id === activeImage)}
            pending={pending[activeImage]}
            repeated={imageIds(editorRef.current?.getContent() ?? "").filter((x) => x === activeImage).length > 1}
            otherUses={(() => {
              const img = manuscriptImages.find((i) => i.id === activeImage);
              if (!img) return [];
              const names = new Map(memory.characters.map((c) => [c.id, c.name]));
              return [
                ...images.filter((g) => g.asset_id === img.asset_id).map((g) => `Galería de ${names.get(g.character_id) ?? ""}`),
                ...manuscriptImages.filter((m) => m.asset_id === img.asset_id && m.id !== img.id).map(() => "otra imagen del manuscrito"),
              ];
            })()}
            onPatch={async (fields) => {
              if (lockedRef.current) throw new Error(LOCKED_NOTICE);
              upsertImage(await api<ManuscriptImage>(`/api/manuscript-images/${activeImage}`, { method: "PATCH", json: fields }));
            }}
            onReplace={async (scope, file) => {
              if (lockedRef.current) throw new Error(LOCKED_NOTICE);
              const r = await replaceImage({ novelId, target: "manuscript", imageId: activeImage, scope, file, onProgress: () => {} });
              setAll(r);
              return r.notice;
            }}
            onDuplicate={async () => {
              if (lockedRef.current) throw new Error(LOCKED_NOTICE);
              const copy = await api<ManuscriptImage>(`/api/manuscript-images/${activeImage}/duplicate`, { method: "POST" });
              upsertImage(copy);
              editorRef.current?.insertImageAfter(activeImage, copy.id);
            }}
            onRemove={() => !refuseIfLocked() && editorRef.current?.removeImage(activeImage)}
            onDelete={async () => {
              if (lockedRef.current) throw new Error(LOCKED_NOTICE);
              await api(`/api/manuscript-images/${activeImage}`, { method: "DELETE" });
              const id = activeImage;
              editorRef.current?.removeImage(id);
              setManuscriptImages((list) => list.filter((i) => i.id !== id));
            }}
            onClose={() => setActiveImage(null)}
          />
        )}
      </main>

      <AssistantPanel
        hidden={!showPanel}
        section={section}
        onSection={chooseSection}
        confirmTokens={loaded.confirmTokens}
        onGoTo={goTo}
        flush={flush}
        onAutoDigest={onAutoDigest}
        chapters={chapters}
        onFactAdded={onFactAdded}
        onClose={() => toggle("panelOpen", setPanelOpen)}
        novelId={novel.id}
        chapterId={chapter.id}
        locked={locked}
        onOpenChapter={(id) => void switchChapter(id)}
        memory={memory}
        providers={loaded.providers}
        defaultProvider={loaded.defaultProvider}
        selection={selection}
        novelChars={Math.round(novelChars / 1000) * 1000}
        getContent={getContent}
        getCursor={getCursor}
        onApply={applyRewrite}
        onInsert={insertScene}
        onClearSelection={clearSelection}
      />

      {(modal === "novel" || modal === "plot") && (
        <NovelModal
          novel={novel}
          initialTab={modal === "plot" ? "argumento" : "novela"}
          onClose={() => setModal(null)}
          onSaved={(n) => {
            setNovel(n);
            setModal(null);
          }}
        />
      )}
      {modal === "images" && (
        <ChapterImagesModal
          text={editorRef.current?.getContent() ?? chapter.content}
          chapterId={chapter.id}
          images={manuscriptImages}
          gallery={images.filter((g, i, all) => all.findIndex((x) => x.asset_id === g.asset_id) === i)}
          names={new Map(memory.characters.map((c) => [c.id, c.name]))}
          pending={pending}
          onGo={(id) => {
            setModal(null);
            setReading(null);
            requestAnimationFrame(() => editorRef.current?.selectImage(id));
          }}
          onInsertExisting={(id) => {
            setModal(null);
            if (refuseIfLocked()) return;
            setReading(null);
            editorRef.current?.insertImages([id]);
            showCard(id);
          }}
          onInsertFromAsset={insertFromAsset}
          onDelete={async (id) => {
            try {
              await api(`/api/manuscript-images/${id}`, { method: "DELETE" });
              setManuscriptImages((list) => list.filter((i) => i.id !== id));
            } catch (e) {
              setNotice((e as Error).message);
            }
          }}
          onFiles={(files) => {
            setModal(null);
            insertFiles(files);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "critic" && (
        <CriticReport
          chapterId={chapter.id}
          chapterTitle={current ? shown(current) : chapter.title}
          providers={loaded.providers}
          defaultProvider={loaded.defaultProvider}
          flush={flush}
          onGoTo={goTo}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "versions" && (
        <VersionsModal
          chapterId={chapter.id}
          chapterTitle={current ? shown(current) : chapter.title}
          getContent={getContent}
          onRestore={restoreVersion}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "trash" && (
        <TrashModal
          novelId={novel.id}
          onRestored={(id, list) => {
            setChapters(list);
            setModal(null);
            refreshManuscriptImages();
            void switchChapter(id);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "chronology" && chronologyView && (
        <ChronologyModal
          novelId={novel.id}
          view={chronologyView}
          currentChapterId={chapter.id}
          onChanged={refreshChronology}
          onGoTo={(id) => {
            setModal(null);
            void switchChapter(id);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "memory" && (
        <MemoryModal
          novelId={novel.id}
          memory={memory}
          chapters={chapters}
          images={images}
          onChange={setMemory}
          onImagesChange={onImagesChange}
          manuscriptImages={manuscriptImages}
          onAllImagesChange={setAll}
          onInsertInChapter={insertFromAsset}
          chronology={chronologyView}
          currentChapterId={chapter.id}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/** The chapter's lock in the top bar: open (🔓) while it is being edited, closed (🔒) once revisado. */
function LockToggle({ locked, busy, onToggle }: { locked: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`link lock-toggle${locked ? " on" : ""}`}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={locked}
      aria-label={locked ? "Capítulo revisado y bloqueado. Desbloquear" : "Marcar como revisado y bloquear"}
      title={locked ? "Revisado y bloqueado: se puede leer, seleccionar y consultar, pero no modificar. Pulsa para desbloquear." : "Marcar como revisado y bloquear"}
    >
      <span aria-hidden="true">{locked ? "🔒" : "🔓"}</span>
      {locked && <span className="lock-label"> Revisado</span>}
    </button>
  );
}

function SaveStatus({ state, onRetry, onOverwrite }: { state: SaveState; onRetry: () => void; onOverwrite: () => void }) {
  if (state === "conflict") {
    return (
      <span className="meta save conflict" role="status">
        {SAVE_LABELS.conflict} ·{" "}
        <button
          className="link"
          onClick={() => {
            if (
              confirm(
                "Se descartarán los cambios de esta pestaña que no se guardaron y se cargará la versión guardada. ¿Continuar?",
              )
            )
              window.location.reload();
          }}
        >
          Cargar esa versión
        </button>{" "}
        ·{" "}
        <button className="link" onClick={onOverwrite}>
          Conservar la mía
        </button>
      </span>
    );
  }
  return (
    <span className={`meta save ${state}`} role="status" aria-live="polite">
      {state === "error" ? (
        <button className="link" onClick={onRetry}>
          {SAVE_LABELS.error}
        </button>
      ) : (
        SAVE_LABELS[state]
      )}
    </span>
  );
}
