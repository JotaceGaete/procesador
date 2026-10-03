"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Character, Project, ProviderId } from "@/lib/types";
import CharacterSidebar from "./CharacterSidebar";
import CharacterModal from "./CharacterModal";
import ProjectModal from "./ProjectModal";
import AnalysisPanel from "./AnalysisPanel";

export interface Selection {
  start: number;
  end: number;
  text: string;
}

type SaveState = "saved" | "dirty" | "saving" | "error";

const AUTOSAVE_MS = 1200;

export default function Workspace() {
  const [project, setProject] = useState<Project | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [providers, setProviders] = useState<ProviderId[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<ProviderId | null>(null);
  const [loadError, setLoadError] = useState("");

  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [editing, setEditing] = useState<Character | "new" | null>(null);
  const [editingProject, setEditingProject] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  const lastSavedRef = useRef("");
  contentRef.current = content;

  useEffect(() => {
    fetch("/api/project")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setProject(data.project);
        setCharacters(data.characters);
        setProviders(data.providers);
        setDefaultProvider(data.defaultProvider);
        setContent(data.project.content);
        lastSavedRef.current = data.project.content;
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const save = useCallback(async (keepalive = false) => {
    const text = contentRef.current;
    if (text === lastSavedRef.current) return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/project", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        keepalive,
      });
      if (!res.ok) throw new Error();
      lastSavedRef.current = text;
      setSaveState(contentRef.current === text ? "saved" : "dirty");
    } catch {
      setSaveState("error");
    }
  }, []);

  // Debounced autosave.
  useEffect(() => {
    if (!project || content === lastSavedRef.current) return;
    setSaveState("dirty");
    const t = setTimeout(() => save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [content, project, save]);

  // Flush when the tab is hidden or closed.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") save(true);
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (contentRef.current !== lastSavedRef.current) {
        save(true);
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", warn);
    };
  }, [save]);

  // Ctrl/Cmd+S saves now; Esc leaves focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape" && focusMode && !editing && !editingProject) {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, focusMode, editing, editingProject]);

  function updateSelection() {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    setSelection(end > start ? { start, end, text: el.value.slice(start, end) } : null);
  }

  /** Replaces the original fragment, wherever it is now, with the rewrite. */
  function applyRewrite(original: Selection, rewrite: string): boolean {
    const current = contentRef.current;
    let start = original.start;
    if (current.slice(start, original.end) !== original.text) {
      start = current.indexOf(original.text);
      if (start === -1) return false;
    }
    const end = start + original.text.length;
    setContent(current.slice(0, start) + rewrite + current.slice(end));
    setSelection(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, start + rewrite.length);
      updateSelection();
    });
    return true;
  }

  function onCharacterSaved(saved: Character) {
    setCharacters((list) => {
      const exists = list.some((c) => c.id === saved.id);
      return exists ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved];
    });
    setEditing(null);
  }

  function onCharacterDeleted(id: string) {
    setCharacters((list) => list.filter((c) => c.id !== id));
    setEditing(null);
  }

  if (loadError) {
    return (
      <main className="fatal">
        <h1>No se pudo cargar el proyecto</h1>
        <p>{loadError}</p>
        <p className="muted">Revisa las variables de entorno de Supabase y que hayas ejecutado supabase/schema.sql.</p>
      </main>
    );
  }
  if (!project) return <main className="fatal muted">Cargando…</main>;

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className={`workspace${focusMode ? " focus" : ""}`}>
      <CharacterSidebar
        project={project}
        characters={characters}
        onEditProject={() => setEditingProject(true)}
        onEdit={(c) => setEditing(c)}
        onNew={() => setEditing("new")}
      />

      <main className="editor-col">
        <header className="editor-bar">
          <span className="project-title">{project.title}</span>
          <span className="spacer" />
          <span className="muted small">{words.toLocaleString("es")} palabras</span>
          <span className={`save-state ${saveState}`}>
            {{ saved: "Guardado", dirty: "Sin guardar", saving: "Guardando…", error: "Error al guardar" }[saveState]}
          </span>
          <button className="btn ghost small" onClick={() => setFocusMode((f) => !f)} title="Modo concentración (Esc para salir)">
            {focusMode ? "Salir de concentración" : "Concentración"}
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
        />
      </main>

      <AnalysisPanel
        content={content}
        selection={selection}
        characters={characters}
        providers={providers}
        defaultProvider={defaultProvider}
        onApply={applyRewrite}
      />

      {editing && (
        <CharacterModal
          character={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={onCharacterSaved}
          onDeleted={onCharacterDeleted}
        />
      )}
      {editingProject && (
        <ProjectModal
          project={project}
          onClose={() => setEditingProject(false)}
          onSaved={(p) => {
            setProject((prev) => (prev ? { ...prev, ...p } : prev));
            setEditingProject(false);
          }}
        />
      )}
    </div>
  );
}
