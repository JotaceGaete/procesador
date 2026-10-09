"use client";

import { useEffect, useState, type DragEvent } from "react";
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

type Group = "manuscript" | "reserve";
/** Where a dragged chapter would land: before or after another, or at the end of a group. */
type Drop = { group: Group; id: string | null; after: boolean };

/**
 * Discreet chapter list (docs/capitulos-reserva.md): the manuscript, numbered by position, and
 * the chapters in reserve, unnumbered, outside the book and outside what the AI reads. Select,
 * add or insert, rename, reorder (↑ ↓, or drag and drop on a computer), move between the two
 * groups and delete (to the trash); versions and trash.
 */
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
  // Drag and drop only with a mouse or trackpad: on a touch screen, dragging would fight the
  // scroll of the list. There, the arrows and «Mover» do the same.
  const [canDrag, setCanDrag] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  // The «Mover» list of a row is filled when it is about to open (focus, pointer or touch):
  // a list per row with every chapter would grow with the square of a long novel.
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => setCanDrag(window.matchMedia("(pointer: fine)").matches), []);

  const manuscript = chapters.filter((c) => !c.reserved);
  const reserve = chapters.filter((c) => c.reserved);
  const label = (c: ChapterInfo) => chapterLabel(manuscript.indexOf(c), c.title, c.reserved);

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

  /** A new chapter in a group, at a 1-based position (null: at the end). */
  const add = (reserved: boolean, at: number | null = null) =>
    run(async () => {
      const res = await api<{ id: string; chapters: ChapterInfo[] }>(`/api/novels/${novelId}/chapters`, {
        method: "POST",
        json: { reserved, at },
      });
      onChange(res.chapters);
      onSelect(res.id);
    });

  /** Moves a chapter to a 1-based position of a group (null: at the end). */
  const moveTo = (c: ChapterInfo, reserved: boolean, at: number | null) => {
    if (reserved && !c.reserved) {
      const ok = confirm(
        `«${label(c)}» pasará a la reserva: dejará de formar parte del manuscrito, no se exportará y la IA dejará de tenerlo en cuenta al leer la novela (salvo cuando lo abras y se lo pidas). Su texto, sus imágenes y sus versiones se conservan. ¿Continuar?`,
      );
      if (!ok) return;
    }
    return run(async () => {
      onChange(await api<ChapterInfo[]>(`/api/chapters/${c.id}/move`, { method: "POST", json: { reserved, at } }));
    });
  };

  const rename = (id: string) => {
    if (renaming !== id) return; // Enter and blur both land here
    setRenaming(null);
    return run(async () => {
      const title = draft.trim();
      await api(`/api/chapters/${id}`, { method: "PATCH", json: { title } });
      onChange(chapters.map((c) => (c.id === id ? { ...c, title } : c)));
    });
  };

  const remove = (c: ChapterInfo) => {
    const words = c.words ? ` y sus ${c.words.toLocaleString("es")} palabras` : "";
    if (!confirm(`¿Eliminar «${label(c)}»${words}? Irá a la papelera, donde podrás recuperarlo durante 30 días.`)) return;
    run(async () => {
      if (c.id === currentId) {
        const list = c.reserved ? reserve : manuscript;
        const i = list.indexOf(c);
        const neighbor = list[i + 1] ?? list[i - 1] ?? manuscript[0];
        if (!neighbor || neighbor.id === c.id || !(await beforeDeleteCurrent(neighbor.id))) return;
      }
      await api(`/api/chapters/${c.id}`, { method: "DELETE" });
      onChange(chapters.filter((x) => x.id !== c.id));
    });
  };

  // ---------- drag and drop (computer) ----------
  const onDragOver = (e: DragEvent, target: Drop) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (target.id) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      target = { ...target, after: e.clientY > r.top + r.height / 2 };
    }
    if (drop?.group !== target.group || drop.id !== target.id || drop.after !== target.after) setDrop(target);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const c = chapters.find((x) => x.id === dragging);
    const target = drop;
    setDragging(null);
    setDrop(null);
    if (!c || !target) return;
    const reserved = target.group === "reserve";
    // The group without the dragged chapter; the new place is counted in it.
    const rest = (reserved ? reserve : manuscript).filter((x) => x.id !== c.id);
    const i = target.id ? rest.findIndex((x) => x.id === target.id) : -1;
    const at = i === -1 ? null : i + (target.after ? 2 : 1);
    if (c.reserved === reserved) {
      const now = (reserved ? reserve : manuscript).indexOf(c) + 1;
      if ((at ?? rest.length + 1) === now) return;
    }
    void moveTo(c, reserved, at);
  };
  const dropClass = (c: ChapterInfo) =>
    drop?.id === c.id && dragging !== c.id ? (drop.after ? " drop-after" : " drop-before") : "";

  function row(c: ChapterInfo, i: number, list: ChapterInfo[]) {
    const group: Group = c.reserved ? "reserve" : "manuscript";
    const others = manuscript.filter((x) => x.id !== c.id);
    return (
      <li
        key={c.id}
        className={`${c.id === currentId ? "current" : ""}${dragging === c.id ? " dragging" : ""}${dropClass(c)}`.trim() || undefined}
        draggable={canDrag && !busy && renaming !== c.id}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", c.id);
          setDragging(c.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDrop(null);
        }}
        onDragOver={(e) => onDragOver(e, { group, id: c.id, after: false })}
        onDrop={onDrop}
      >
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
              placeholder={c.reserved ? "Título (en reserva)" : `Capítulo ${i + 1}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
              onBlur={() => rename(c.id)}
              aria-label="Título del capítulo"
            />
          </form>
        ) : (
          <>
            <button className="chapter-name" onClick={() => onSelect(c.id)} aria-current={c.id === currentId}>
              {c.reserved ? c.title.trim() || "Sin título" : label(c)}
              <span className="muted small"> · {c.words.toLocaleString("es")}</span>
            </button>
            <span className="row-actions">
              <button className="link" disabled={busy || i === 0} onClick={() => moveTo(c, c.reserved, i)} aria-label="Subir">
                ↑
              </button>
              <button
                className="link"
                disabled={busy || i === list.length - 1}
                onClick={() => moveTo(c, c.reserved, i + 2)}
                aria-label="Bajar"
              >
                ↓
              </button>
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
              {/* A native list: on an iPhone it opens the system picker. */}
              <select
                className="link move"
                value=""
                disabled={busy}
                aria-label={c.reserved ? "Llevar al manuscrito" : "Mover"}
                onFocus={() => setMenu(c.id)}
                onPointerDown={() => setMenu(c.id)}
                onTouchStart={() => setMenu(c.id)}
                onBlur={() => setMenu((m) => (m === c.id ? null : m))}
                onChange={(e) => {
                  const v = e.target.value;
                  e.target.value = "";
                  if (v === "reserve") void moveTo(c, true, null);
                  else if (v === "insert") void add(false, manuscript.indexOf(c) + 2);
                  else if (v) void moveTo(c, false, v === "end" ? null : Number(v));
                }}
              >
                <option value="">{c.reserved ? "Al manuscrito…" : "Mover…"}</option>
                {menu === c.id && (
                  <>
                    <optgroup label={c.reserved ? "Al manuscrito" : "En el manuscrito"}>
                      <option value="1">Al principio</option>
                      {others.map((x, j) => (
                        <option key={x.id} value={j + 2}>
                          Después de {chapterLabel(manuscript.indexOf(x), x.title)}
                        </option>
                      ))}
                    </optgroup>
                    {!c.reserved && (
                      <optgroup label="Otras acciones">
                        <option value="reserve" disabled={manuscript.length <= 1}>
                          Pasar a la reserva
                        </option>
                        <option value="insert">Insertar un capítulo nuevo después</option>
                      </optgroup>
                    )}
                  </>
                )}
              </select>
              {(c.reserved || manuscript.length > 1) && (
                <button className="link danger" disabled={busy} onClick={() => remove(c)} aria-label="Eliminar">
                  Eliminar
                </button>
              )}
            </span>
          </>
        )}
      </li>
    );
  }

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
      <section aria-label="Manuscrito" className="chapter-group manuscript-group">
        {reserve.length > 0 && <h3 className="group-title">Manuscrito</h3>}
        <ol
          onDragOver={(e) => e.target === e.currentTarget && onDragOver(e, { group: "manuscript", id: null, after: true })}
          onDrop={onDrop}
        >
          {manuscript.map((c, i) => row(c, i, manuscript))}
        </ol>
        <p className="group-add">
          <button className="link add" onClick={() => add(false)} disabled={busy}>
            + Nuevo capítulo
          </button>
        </p>
      </section>
      {error && <p className="error small">{error}</p>}
      <section
        aria-label="Capítulos en reserva"
        className={`chapter-group reserve-group${drop?.group === "reserve" && !drop.id ? " drop-into" : ""}`}
        onDragOver={(e) => (e.target === e.currentTarget || !reserve.length) && onDragOver(e, { group: "reserve", id: null, after: true })}
        onDrop={onDrop}
      >
        <h3 className="group-title">Capítulos en reserva</h3>
        {reserve.length ? (
          <ul>{reserve.map((c, i) => row(c, i, reserve))}</ul>
        ) : (
          <p className="muted small">
            Escenas para más adelante. No se numeran, no se exportan y la IA no las tiene en cuenta hasta que las incorpores al
            manuscrito.
          </p>
        )}
        <p className="group-add">
          <button className="link add" onClick={() => add(true)} disabled={busy}>
            + Nuevo en reserva
          </button>
        </p>
      </section>
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
