"use client";

import { useEffect, useMemo, useState } from "react";
import { VERSION_REASONS, type ChapterInfo, type ChapterVersion, type TrashEntry } from "@/lib/types";
import { api } from "@/lib/client";
import { diffStats, diffText } from "@/lib/diff";
import { chapterLabel } from "@/lib/ai/context";
import Modal from "./Modal";
import DiffView from "./DiffView";

/** Versions and trash (docs/versiones.md). */

const when = (iso: string) =>
  new Date(iso).toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const wordsLabel = (n: number) => (n === 1 ? "1 palabra" : `${n.toLocaleString("es")} palabras`);

/**
 * The chapter's versions: save the current text with a name, see what each version
 * differs from the current text, and restore one (the current text is kept first).
 */
export function VersionsModal({
  chapterId,
  chapterTitle,
  getContent,
  onRestore,
  onClose,
}: {
  chapterId: string;
  chapterTitle: string;
  getContent(): string;
  /** Puts the version's text in the editor (after keeping the current one). */
  onRestore(text: string): Promise<void>;
  onClose(): void;
}) {
  const [list, setList] = useState<ChapterVersion[] | null>(null);
  const [open, setOpen] = useState<ChapterVersion | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = () =>
    api<ChapterVersion[]>(`/api/chapters/${chapterId}/versions`)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per chapter
  useEffect(() => void load(), [chapterId]);

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

  const saveNow = () =>
    run(async () => {
      const { id } = await api<{ id: string | null }>(`/api/chapters/${chapterId}/versions`, {
        method: "POST",
        json: { reason: "manual", label: label.trim(), content: getContent() },
      });
      setSaved(id ? "Versión guardada." : "El capítulo está vacío: no hay nada que guardar.");
      setLabel("");
      await load();
    });

  const show = (v: ChapterVersion) => run(async () => setOpen(await api<ChapterVersion>(`/api/versions/${v.id}`)));

  // From the current text to the version: what restoring it would bring back (add) and take away (del).
  const ops = useMemo(() => (open?.content !== undefined ? diffText(getContent(), open.content) : null), [open, getContent]);
  const stats = ops && diffStats(ops);

  const title = `Versiones · ${chapterTitle}`;
  if (open && ops && stats) {
    const same = !ops.some((o) => o.kind !== "same");
    return (
      <Modal title={title} onClose={onClose} onBack={() => setOpen(null)} wide>
        <p className="version-head">
          <strong>{open.label || VERSION_REASONS[open.reason]}</strong>
          <span className="muted"> · {when(open.created_at)} · {wordsLabel(open.words)}</span>
        </p>
        <p className="muted small">
          {same
            ? "Es igual al texto actual."
            : `Comparada con el texto actual: en verde, ${wordsLabel(stats.added)} de esta versión que hoy no están; tachadas, ${wordsLabel(stats.removed)} del texto actual que esta versión no tiene.`}
        </p>
        <DiffView ops={ops} label="Diferencias con el texto actual" />
        {error && <p className="error small">{error}</p>}
        <div className="compare-actions">
          <button
            className="btn primary"
            disabled={busy || same}
            onClick={() => run(async () => onRestore(open.content!))}
            title="El texto actual se guarda antes como versión, y Deshacer lo devuelve"
          >
            Restaurar esta versión
          </button>
          <button className="btn ghost" onClick={() => navigator.clipboard.writeText(open.content!)}>
            Copiar su texto
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="version-save"
        onSubmit={(e) => {
          e.preventDefault();
          saveNow();
        }}
      >
        <input
          value={label}
          maxLength={200}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Nombre (opcional): «Primer borrador», «Antes de la revisión»…"
          aria-label="Nombre de la versión"
        />
        <button className="btn" disabled={busy}>
          Guardar versión actual
        </button>
      </form>
      {saved && <p className="muted small" role="status">{saved}</p>}
      {error && <p className="error small">{error}</p>}
      {list === null ? (
        <p className="muted">Cargando…</p>
      ) : list.length === 0 ? (
        <p className="muted">
          Todavía no hay versiones de este capítulo. Se guardan solas mientras escribes (como mucho una cada media hora),
          antes de aplicar una propuesta de la IA y al restaurar; y cuando tú lo pides.
        </p>
      ) : (
        <ul className="versions">
          {list.map((v) => (
            <li key={v.id}>
              <button className="version" onClick={() => show(v)} disabled={busy}>
                <span className="version-when">{when(v.created_at)}</span>
                <span>{v.label || VERSION_REASONS[v.reason]}</span>
                <span className="muted small">
                  {v.label ? `${VERSION_REASONS[v.reason]} · ` : ""}
                  {wordsLabel(v.words)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Se conservan las 100 copias automáticas más recientes de cada capítulo; las que guardas tú no se borran nunca.
      </p>
    </Modal>
  );
}

/** Deleted chapters, recoverable for 30 days with their history. */
export function TrashModal({
  novelId,
  onRestored,
  onClose,
}: {
  novelId: string;
  onRestored(id: string, chapters: ChapterInfo[]): void;
  onClose(): void;
}) {
  const [list, setList] = useState<TrashEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<TrashEntry[]>(`/api/novels/${novelId}/trash`)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  }, [novelId]);

  async function restore(e: TrashEntry) {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ id: string; chapters: Parameters<typeof onRestored>[1] }>(`/api/novels/${novelId}/trash`, {
        method: "POST",
        json: { sourceId: e.source_chapter_id },
      });
      onRestored(res.id, res.chapters);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Papelera" onClose={onClose}>
      {error && <p className="error small">{error}</p>}
      {list === null ? (
        <p className="muted">Cargando…</p>
      ) : list.length === 0 ? (
        <p className="muted">La papelera está vacía.</p>
      ) : (
        <ul className="versions">
          {list.map((e) => (
            <li key={e.source_chapter_id} className="trash-row">
              <span>
                <strong>{e.title.trim() || chapterLabel(e.position - 1, "")}</strong>
                <span className="muted small">
                  {" "}
                  · eliminado el {when(e.deleted_at)} · {wordsLabel(e.words)}
                </span>
              </span>
              <button className="btn" disabled={busy} onClick={() => restore(e)}>
                Recuperar
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Un capítulo eliminado se puede recuperar durante 30 días, con todas sus versiones. Vuelve al final de la novela.
      </p>
    </Modal>
  );
}
