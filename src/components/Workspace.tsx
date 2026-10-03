"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Character, Project, ProviderId } from "@/lib/types";
import { api, readPref, writePref } from "@/lib/client";
import { useAutosave, type SaveState } from "./useAutosave";
import CharactersModal from "./CharactersModal";
import ProjectModal from "./ProjectModal";
import AnalysisPanel from "./AnalysisPanel";

export interface Selection {
  start: number;
  end: number;
  text: string;
}

interface Loaded {
  project: Project;
  characters: Character[];
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

export default function Workspace() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [content, setContent] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [modal, setModal] = useState<"characters" | "project" | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const initial = useMemo(
    () => (loaded ? { content: loaded.project.content, revision: loaded.project.revision } : null),
    [loaded],
  );
  const autosave = useAutosave(content, initial);
  const saveNow = autosave.save;

  useEffect(() => {
    api<Loaded>("/api/project")
      .then((data) => {
        setLoaded(data);
        setProject(data.project);
        setCharacters(data.characters);
        setContent(data.project.content);
      })
      .catch((e: Error) => setLoadError(e.message));
    // Panel open by default on wide screens only; remembered afterwards.
    const pref = readPref("panelOpen");
    setPanelOpen(pref ? pref === "1" : window.matchMedia("(min-width: 1000px)").matches);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      writePref("panelOpen", open ? "0" : "1");
      return !open;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        saveNow();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        setFocusMode((f) => !f);
      } else if (e.key === "Escape" && focusMode && !modal) {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow, focusMode, modal]);

  const updateSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    setSelection((prev) => {
      if (end <= start) return null;
      if (prev && prev.start === start && prev.end === end) return prev;
      return { start, end, text: el.value.slice(start, end) };
    });
  }, []);

  /**
   * Replaces the original fragment with the proposal, only when the author asks.
   * Uses insertText so Ctrl+Z in the editor undoes it.
   */
  const applyRewrite = useCallback(
    (original: Selection, rewrite: string): boolean => {
      const el = textareaRef.current;
      const current = contentRef.current;
      if (!el) return false;
      let start = original.start;
      if (current.slice(start, original.end) !== original.text) {
        // The text moved since the analysis: take the occurrence closest to where it was.
        let best = -1;
        for (let i = current.indexOf(original.text); i !== -1; i = current.indexOf(original.text, i + 1)) {
          if (best === -1 || Math.abs(i - original.start) < Math.abs(best - original.start)) best = i;
        }
        if (best === -1) return false;
        start = best;
      }
      const end = start + original.text.length;
      el.focus();
      el.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, rewrite)) {
        setContent(current.slice(0, start) + rewrite + current.slice(end));
      }
      requestAnimationFrame(() => {
        el.setSelectionRange(start, start + rewrite.length);
        updateSelection();
      });
      return true;
    },
    [updateSelection],
  );

  const getContent = useCallback(() => contentRef.current, []);

  // Counting words in a whole novel on every keystroke is noticeable: do it once typing pauses.
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  useEffect(() => {
    const delay = stats.chars ? 400 : 0;
    const t = setTimeout(() => setStats({ words: (content.match(/\S+/g) ?? []).length, chars: content.length }), delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first count is immediate
  }, [content]);
  const words = stats.words;
  // Rounded so the panel doesn't re-render for every few characters.
  const manuscriptChars = Math.round(stats.chars / 1000) * 1000;

  if (loadError) {
    return (
      <main className="fatal">
        <h1>No se pudo cargar el proyecto</h1>
        <p>{loadError}</p>
        <p className="muted">Revisa las variables de entorno de Supabase y que hayas ejecutado supabase/schema.sql.</p>
      </main>
    );
  }
  if (!loaded || !project) return <main className="fatal muted">Cargando…</main>;

  const showPanel = panelOpen && !focusMode;

  return (
    <div className={`workspace${focusMode ? " focus" : ""}${showPanel ? " with-panel" : ""}`}>
      <main className="editor-col">
        <header className="topbar">
          <button className="link title" onClick={() => setModal("project")} title="Sinopsis y notas de estilo">
            {project.title}
          </button>
          <span className="spacer" />
          <span className="meta words">{words.toLocaleString("es")} palabras</span>
          <SaveStatus state={autosave.state} onRetry={autosave.save} onOverwrite={autosave.overwrite} />
          <button className="link" onClick={() => setModal("characters")}>
            Personajes
          </button>
          <button className={`link${showPanel ? " on" : ""}`} onClick={togglePanel} aria-pressed={showPanel}>
            Análisis
          </button>
          <button className="link focus-toggle" onClick={() => setFocusMode((f) => !f)} title="Ctrl/⌘ + .  ·  Esc para salir">
            {focusMode ? "Salir" : "Concentración"}
          </button>
        </header>
        <textarea
          ref={textareaRef}
          className="editor"
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            updateSelection();
          }}
          onSelect={updateSelection}
          onMouseUp={updateSelection}
          onKeyUp={updateSelection}
          placeholder="Empieza a escribir…"
          spellCheck
          autoFocus
          aria-label="Manuscrito"
        />
      </main>

      <AnalysisPanel
        hidden={!showPanel}
        onClose={togglePanel}
        getContent={getContent}
        manuscriptChars={manuscriptChars}
        selection={selection}
        characters={characters}
        providers={loaded.providers}
        defaultProvider={loaded.defaultProvider}
        onApply={applyRewrite}
      />

      {modal === "characters" && (
        <CharactersModal characters={characters} onChange={setCharacters} onClose={() => setModal(null)} />
      )}
      {modal === "project" && (
        <ProjectModal
          project={project}
          onClose={() => setModal(null)}
          onSaved={(p) => {
            setProject((prev) => (prev ? { ...prev, ...p } : prev));
            setModal(null);
          }}
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
