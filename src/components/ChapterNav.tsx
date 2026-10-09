"use client";

import { useState } from "react";
import type { ChapterInfo } from "@/lib/types";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";

interface Props {
  hidden: boolean;
  novelId: string;
  chapters: ChapterInfo[];
  currentId: string;
  onSelect(id: string): void;
  onChange(chapters: ChapterInfo[]): void;
  onClose(): void;
  /** The current chapter's versions, and the novel's trash (docs/versiones.md). */
  onVersions(): void;
  onTrash(): void;
  /** Cronología (docs/cronologia-edades.md), with the time warnings not dismissed. */
  onChronology(): void;
  timeWarnings: number;
  /** The novel: data, Guía Maestra, backup and the book's exports (also reachable on a phone, where the title is hidden). */
  onNovel(): void;
  /** The Argumento general (the author's plot, for the Consejero only). */
  onPlot(): void;
  /** Editor visual (docs/editor-visual.md): on by default; the switch turns it off (plain editor), per device. */
  visualEditor: boolean;
  onToggleVisualEditor(): void;
  /** Moves the editor to another chapter before the current one is deleted. */
  beforeDeleteCurrent(neighborId: string): Promise<boolean>;
}

/** Discreet chapter list: select, add, rename, reorder (↑ ↓) and delete (to the trash); versions and trash. */
export default function ChapterNav({
  hidden,
  novelId,
  chapters,
  currentId,
  onSelect,
  onChange,
  onClose,
  onVersions,
  onTrash,
  onChronology,
  timeWarnings,
  onNovel,
  onPlot,
  visualEditor,
  onToggleVisualEditor,
  beforeDeleteCurrent,
}: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const res = await api<{ id: string; chapters: ChapterInfo[] }>(`/api/novels/${novelId}/chapters`, {
        method: "POST",
        json: {},
      });
      onChange(res.chapters);
      onSelect(res.id);
    });

  const move = (index: number, delta: number) =>
    run(async () => {
      const ids = chapters.map((c) => c.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      onChange(await api<ChapterInfo[]>(`/api/novels/${novelId}/chapters`, { method: "PUT", json: { ids } }));
    });

  const rename = (id: string) => {
    if (renaming !== id) return; // Enter and blur both land here
    setRenaming(null);
    return run(async () => {
      const title = draft.trim();
      await api(`/api/chapters/${id}`, { method: "PATCH", json: { title } });
      onChange(chapters.map((c) => (c.id === id ? { ...c, title } : c)));
    });
  };

  const remove = (c: ChapterInfo, index: number) => {
    const words = c.words ? ` y sus ${c.words.toLocaleString("es")} palabras` : "";
    if (!confirm(`¿Eliminar «${chapterLabel(index, c.title)}»${words}? Irá a la papelera, donde podrás recuperarlo durante 30 días.`)) return;
    run(async () => {
      if (c.id === currentId) {
        const neighbor = chapters[index + 1] ?? chapters[index - 1];
        if (!neighbor || !(await beforeDeleteCurrent(neighbor.id))) return;
      }
      await api(`/api/chapters/${c.id}`, { method: "DELETE" });
      onChange(chapters.filter((x) => x.id !== c.id));
    });
  };

  return (
    <nav className="chapters" hidden={hidden} aria-label="Capítulos">
      <header className="panel-head">
        <span className="panel-title">Capítulos</span>
        <span className="spacer" />
        <button className="link" onClick={onClose}>
          Ocultar
        </button>
      </header>
      {/* At the top, never below the list: on a phone the drawer would hide it under the chapters. */}
      <button type="button" role="switch" aria-checked={visualEditor} className="editor-switch" onClick={onToggleVisualEditor}>
        <span className="editor-switch-text">
          <span className="editor-switch-label">Editor visual</span>
          <span className="editor-switch-state">{visualEditor ? "Activado" : "Desactivado · editor de texto"}</span>
        </span>
        <span className="editor-switch-track" aria-hidden="true">
          <span className="editor-switch-knob" />
        </span>
      </button>
      <ol>
        {chapters.map((c, i) => (
          <li key={c.id} className={c.id === currentId ? "current" : undefined}>
            {renaming === c.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  rename(c.id);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  placeholder={`Capítulo ${i + 1}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                  onBlur={() => rename(c.id)}
                  aria-label="Título del capítulo"
                />
              </form>
            ) : (
              <>
                <button className="chapter-name" onClick={() => onSelect(c.id)} aria-current={c.id === currentId}>
                  {c.locked && (
                    <span className="chapter-lock" role="img" aria-label="Revisado y bloqueado" title="Revisado y bloqueado">
                      🔒{" "}
                    </span>
                  )}
                  {chapterLabel(i, c.title)}
                  <span className="muted small"> · {c.words.toLocaleString("es")}</span>
                </button>
                <span className="row-actions">
                  <button className="link" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Subir">
                    ↑
                  </button>
                  <button
                    className="link"
                    disabled={busy || i === chapters.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Bajar"
                  >
                    ↓
                  </button>
                  {/* A locked chapter keeps its title and can't go to the trash until it is unlocked. */}
                  {!c.locked && (
                    <button
                      className="link"
                      onClick={() => {
                        setDraft(c.title);
                        setRenaming(c.id);
                      }}
                      aria-label="Renombrar"
                    >
                      Renombrar
                    </button>
                  )}
                  {chapters.length > 1 && !c.locked && (
                    <button className="link danger" disabled={busy} onClick={() => remove(c, i)} aria-label="Eliminar">
                      Eliminar
                    </button>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
      {error && <p className="error small">{error}</p>}
      <button className="link add" onClick={add} disabled={busy}>
        + Nuevo capítulo
      </button>
      <p className="nav-extra">
        <button className="link" onClick={onVersions}>
          Versiones de este capítulo
        </button>
        <button className="link" onClick={onTrash}>
          Papelera
        </button>
        <button className="link" onClick={onChronology}>
          Cronología
          {timeWarnings > 0 && (
            <span className="muted"> · {timeWarnings === 1 ? "1 advertencia" : `${timeWarnings} advertencias`}</span>
          )}
        </button>
        <button className="link" onClick={onPlot}>
          Argumento general
        </button>
        <button className="link" onClick={onNovel}>
          Novela, copia y exportación
        </button>
      </p>
    </nav>
  );
}
