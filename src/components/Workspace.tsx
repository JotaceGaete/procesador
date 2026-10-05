"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AIPanelSection, Chapter, Fact, ChapterInfo, CharacterImage, ManuscriptImage, Memory, Novel, ProviderId } from "@/lib/types";
import { api, readPref, writePref } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { SaveState } from "./useAutosave";
import ChapterEditor, { type EditorHandle, type Selection } from "./ChapterEditor";
import ChapterNav from "./ChapterNav";
import { TrashModal, VersionsModal } from "./Versions";
import NovelModal from "./NovelModal";
import MemoryModal from "./MemoryModal";
import AssistantPanel from "./AssistantPanel";
import { ChapterImagesModal, ImageCard, ReadingView, type Pending } from "./ManuscriptImages";
import { addManuscriptImage, rejectReason, replaceImage } from "@/lib/upload";
import { imageAt, imageIds } from "@/lib/manuscript";
import { resolveAnchor, type InsertTarget } from "@/lib/placement";

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
  const [save, setSave] = useState<{ state: SaveState; retry(): void; overwrite(): void }>({
    state: "saved",
    retry() {},
    overwrite() {},
  });

  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [section, setSection] = useState<AIPanelSection>("assistant");
  // A Consejero "Ir" into another chapter: applied once that chapter's editor is mounted.
  const pendingGoTo = useRef<{ chapterId: string; start: number; end: number; text: string } | null>(null);
  // Chapters written in during this visit: leaving one may re-read it (Consejero, auto_digest).
  const edited = useRef(new Set<string>());
  const [focusMode, setFocusMode] = useState(false);
  const [modal, setModal] = useState<"novel" | "memory" | "images" | "versions" | "trash" | null>(null);
  const editorRef = useRef<EditorHandle>(null);

  const openChapter = useCallback(async (id: string) => {
    const data = await api<Chapter>(`/api/chapters/${id}`);
    setSelection(null);
    setActiveImage(null);
    setReading(null);
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
    (state: SaveState, actions: { retry(): void; overwrite(): void }) => {
      if (state === "pending" && currentId) edited.current.add(currentId);
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
  const keepVersion = useCallback(
    (reason: "ai" | "restore") => {
      const content = editorRef.current?.getContent();
      if (!chapter || content === undefined) return Promise.resolve();
      return api(`/api/chapters/${chapter.id}/versions`, { method: "POST", json: { reason, content } });
    },
    [chapter],
  );
  /**
   * Applying a proposal of the Asistente (docs/asistente-contexto.md, «Comparar antes de
   * aplicar»): the current text is kept as a version first, and only then does the manuscript
   * change. If the copy can't be saved, nothing is applied (the panel keeps the proposal).
   */
  const keepBeforeAI = useCallback(async () => {
    try {
      await keepVersion("ai");
    } catch {
      throw new Error("No se pudo guardar una copia del texto actual, así que no se ha aplicado nada. Vuelve a intentarlo.");
    }
  }, [keepVersion]);
  /** Versiones → Restaurar: the current text becomes a version first; if that fails, nothing changes. */
  const restoreVersion = useCallback(
    async (text: string) => {
      await keepVersion("restore");
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
  const applyRewrite = useCallback(
    async (original: Selection, text: string) => {
      await keepBeforeAI();
      return afterApply(attempt(() => editorRef.current?.applyRewrite(original, text)), "Reemplazado en el manuscrito.");
    },
    [afterApply, keepBeforeAI],
  );
  /**
   * A scene of the Asistente, where the panel says (docs/asistente-contexto.md §11): the
   * chapter's real end at this moment, or the fixed position, found again by its anchor
   * after the copy is saved. If that place is gone, nothing is inserted.
   */
  const insertScene = useCallback(
    async (text: string, target: InsertTarget) => {
      await keepBeforeAI();
      if (target.kind === "end")
        return afterApply(attempt(() => editorRef.current?.insertAtEnd(text)), "Escena insertada al final del capítulo.");
      const at = resolveAnchor(editorRef.current?.getContent() ?? "", target.anchor);
      if (at === null)
        throw new Error("El texto alrededor del lugar fijado cambió y ya no se encuentra. Fíjalo de nuevo o inserta al final.");
      return afterApply(attempt(() => editorRef.current?.insertAt(at, text)), "Escena insertada en el lugar fijado.");
    },
    [afterApply, keepBeforeAI],
  );
  const clearSelection = useCallback(() => editorRef.current?.clearSelection(), []);

  /**
   * Pasted, dropped or chosen image files: each gets its marker at the cursor right
   * away (so it keeps its place and undo works), then uploads in the background.
   */
  const insertFiles = useCallback(
    async (files: File[]) => {
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
    [novelId, upsertImage],
  );

  /** A file the novel already has (from a gallery): a new image of the book, same file, not copied. */
  const insertFromAsset = useCallback(
    async (assetId: string) => {
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
    [novelId, upsertImage],
  );

  const refreshManuscriptImages = useCallback(
    () => api<ManuscriptImage[]>(`/api/novels/${novelId}/manuscript-images`).then(setManuscriptImages).catch(() => {}),
    [novelId],
  );

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
        onVersions={() => {
          if (narrow()) setNavOpen(false);
          setModal("versions");
        }}
        onTrash={() => {
          if (narrow()) setNavOpen(false);
          setModal("trash");
        }}
        beforeDeleteCurrent={async (neighborId) => {
          if (!(await leaveChapter())) return false;
          await openChapter(neighborId);
          return true;
        }}
      />

      <main className="editor-col" data-origin="manuscrito (editor)">
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
          {/* Formato (docs/formato-texto.md). The text keeps the focus, and with it the selection. */}
          <span className="format-actions">
            <button
              className="link format"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editorRef.current?.toggleItalic()}
              disabled={reading !== null}
              title="Cursiva (Ctrl/⌘+I): *así*"
              aria-label="Cursiva"
            >
              <em>C</em>
            </button>
            <button
              className="link format"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editorRef.current?.insertSeparator()}
              disabled={reading !== null}
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
          onCaret={onCaret}
          onImageFiles={insertFiles}
          hidden={reading !== null}
        />
        {reading !== null && (
          <ReadingView
            text={reading}
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
              upsertImage(await api<ManuscriptImage>(`/api/manuscript-images/${activeImage}`, { method: "PATCH", json: fields }));
            }}
            onReplace={async (scope, file) => {
              const r = await replaceImage({ novelId, target: "manuscript", imageId: activeImage, scope, file, onProgress: () => {} });
              setAll(r);
              return r.notice;
            }}
            onDuplicate={async () => {
              const copy = await api<ManuscriptImage>(`/api/manuscript-images/${activeImage}/duplicate`, { method: "POST" });
              upsertImage(copy);
              editorRef.current?.insertImageAfter(activeImage, copy.id);
            }}
            onRemove={() => editorRef.current?.removeImage(activeImage)}
            onDelete={async () => {
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
      {modal === "versions" && (
        <VersionsModal
          chapterId={chapter.id}
          chapterTitle={current ? chapterLabel(chapterIndex, current.title) : chapter.title}
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
