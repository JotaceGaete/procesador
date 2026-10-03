"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chapter, ChapterInfo, CharacterImage, Memory, Novel, ProviderId } from "@/lib/types";
import { api, readPref, writePref } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { SaveState } from "./useAutosave";
import ChapterEditor, { type EditorHandle, type Selection } from "./ChapterEditor";
import ChapterNav from "./ChapterNav";
import NovelModal from "./NovelModal";
import MemoryModal from "./MemoryModal";
import AssistantPanel from "./AssistantPanel";

interface Loaded {
  novel: Novel;
  chapters: ChapterInfo[];
  memory: Memory;
  images: CharacterImage[];
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
}

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Guardado",
  pending: "Sin guardar",
  saving: "Guardando…",
  error: "No se pudo guardar · reintentando",
  conflict: "Cambió en otro lugar",
};

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

  const [selection, setSelection] = useState<Selection | null>(null);
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const [save, setSave] = useState<{ state: SaveState; retry(): void; overwrite(): void }>({
    state: "saved",
    retry() {},
    overwrite() {},
  });

  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [modal, setModal] = useState<"novel" | "memory" | null>(null);
  const editorRef = useRef<EditorHandle>(null);

  const openChapter = useCallback(async (id: string) => {
    const data = await api<Chapter>(`/api/chapters/${id}`);
    setSelection(null);
    setChapter(data);
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
  }, [novelId, openChapter]);

  // Keep the chapter list's counts in step with the chapter being written.
  const currentId = chapter?.id;
  useEffect(() => {
    if (!currentId) return;
    setChapters((list) => list.map((c) => (c.id === currentId ? { ...c, words: stats.words, chars: stats.chars } : c)));
  }, [currentId, stats]);

  /** Never leaves a chapter with text that didn't reach the server without asking. */
  const leaveChapter = useCallback(async () => {
    if (!editorRef.current || (await editorRef.current.flush())) return true;
    return confirm("Los últimos cambios de este capítulo no se pudieron guardar. Si continúas, se perderán. ¿Continuar?");
  }, []);

  const narrow = () => !window.matchMedia("(min-width: 1000px)").matches;

  const switchChapter = useCallback(
    async (id: string) => {
      // On a phone the list is a drawer over the text: picking any chapter closes it.
      if (narrow()) setNavOpen(false);
      if (id === chapter?.id || !(await leaveChapter())) return;
      await openChapter(id);
    },
    [chapter?.id, leaveChapter, openChapter],
  );

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
    (state: SaveState, actions: { retry(): void; overwrite(): void }) => setSave({ state, ...actions }),
    [],
  );
  const getContent = useCallback(() => editorRef.current?.getContent() ?? "", []);
  const getCursor = useCallback(() => editorRef.current?.getCursor() ?? 0, []);
  const applyRewrite = useCallback(
    (original: Selection, text: string) => editorRef.current?.applyRewrite(original, text) ?? false,
    [],
  );
  const insertAtCursor = useCallback((text: string) => editorRef.current?.insertAtCursor(text), []);
  const clearSelection = useCallback(() => editorRef.current?.clearSelection(), []);

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
  // Whole novel size for the "include manuscript" estimate: saved chapters plus the live one.
  const novelChars = chapters.reduce((n, c) => n + (c.id === chapter.id ? stats.chars : c.chars), 0);
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
        beforeDeleteCurrent={async (neighborId) => {
          if (!(await leaveChapter())) return false;
          await openChapter(neighborId);
          return true;
        }}
      />

      <main className="editor-col">
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
          <button className="link title" onClick={() => setModal("novel")} title="Novela y Guía Maestra">
            {novel.title}
          </button>
          <button
            className={`link chapter-title${showNav ? " on" : ""}`}
            onClick={() => toggle("navOpen", setNavOpen)}
            title="Capítulos"
          >
            {current ? chapterLabel(chapterIndex, current.title) : ""}
          </button>
          <span className="spacer" />
          <span className="meta words">{stats.words.toLocaleString("es")} palabras</span>
          <SaveStatus state={save.state} onRetry={save.retry} onOverwrite={save.overwrite} />
          <button className="link" onClick={() => setModal("memory")}>
            Memoria
          </button>
          <button
            className={`link${showPanel ? " on" : ""}`}
            onClick={() => toggle("panelOpen", setPanelOpen)}
            aria-pressed={showPanel}
          >
            Asistente
          </button>
          <button className="link focus-toggle" onClick={() => setFocusMode((f) => !f)} title="Ctrl/⌘ + .  ·  Esc para salir">
            {focusMode ? "Salir" : "Concentración"}
          </button>
        </header>
        <ChapterEditor
          key={chapter.id}
          ref={editorRef}
          chapterId={chapter.id}
          initial={{ content: chapter.content, revision: chapter.revision }}
          focusMode={focusMode}
          onSelection={setSelection}
          onStats={setStats}
          onSaveState={onSaveState}
        />
      </main>

      <AssistantPanel
        hidden={!showPanel}
        onClose={() => toggle("panelOpen", setPanelOpen)}
        novelId={novel.id}
        chapterId={chapter.id}
        memory={memory}
        providers={loaded.providers}
        defaultProvider={loaded.defaultProvider}
        selection={selection}
        novelChars={Math.round(novelChars / 1000) * 1000}
        getContent={getContent}
        getCursor={getCursor}
        onApply={applyRewrite}
        onInsert={insertAtCursor}
        onClearSelection={clearSelection}
      />

      {modal === "novel" && (
        <NovelModal
          novel={novel}
          onClose={() => setModal(null)}
          onSaved={(n) => {
            setNovel(n);
            setModal(null);
          }}
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
          onClose={() => setModal(null)}
        />
      )}
    </div>
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
