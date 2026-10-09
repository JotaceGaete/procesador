"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { ChapterInfo, Fact, Memory, StoredObservation, StoryThread } from "@/lib/types";
import ObservationCard from "./ObservationCard";

/**
 * Guardadas (docs/consejero.md, phase 4): the observations the author kept, with what
 * changed since in the chapters they rely on. Resolved ones on request.
 */
export default function AdvisorSaved(p: {
  novelId: string;
  chapters: ChapterInfo[];
  memory: Memory;
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
  onSendToAssistant(text: string): void;
  onFactAdded(f: Fact): void;
}) {
  const [status, setStatus] = useState<"saved" | "resolved">("saved");
  const [list, setList] = useState<StoredObservation[] | null>(null);
  const [threads, setThreads] = useState<StoryThread[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setList(await api<StoredObservation[]>(`/api/novels/${p.novelId}/observations?status=${status}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [p.novelId, status]);
  const loadThreads = useCallback(async () => {
    setThreads(await api<StoryThread[]>(`/api/novels/${p.novelId}/threads`).catch(() => []));
  }, [p.novelId]);
  useEffect(() => {
    load();
    loadThreads();
  }, [load, loadThreads]);

  const index = new Map(p.chapters.map((c, i) => [c.id, i]));
  const label = (id: string) =>
    index.has(id) ? chapterLabel(index.get(id)!, p.chapters[index.get(id)!].title, p.chapters[index.get(id)!].reserved) : "capítulo eliminado";

  return (
    <div className="saved-observations">
      <nav className="tabs small" aria-label="Estado">
        <button className={status === "saved" ? "on" : undefined} onClick={() => setStatus("saved")}>
          Pendientes
        </button>
        <button className={status === "resolved" ? "on" : undefined} onClick={() => setStatus("resolved")}>
          Resueltas
        </button>
      </nav>
      {error && <p className="error small">{error}</p>}
      {!list ? (
        <p className="muted small">Cargando…</p>
      ) : list.length ? (
        <ul className="observations">
          {list.map((o) => (
            <ObservationCard
              key={o.id}
              o={o}
              label={label}
              onGoTo={p.onGoTo}
              onSendToAssistant={p.onSendToAssistant}
              actions={{
                novelId: p.novelId,
                memory: p.memory,
                threads,
                label,
                onChanged: (x) => setList((l) => (x.status === status ? l!.map((y) => (y.id === x.id ? x : y)) : l!.filter((y) => y.id !== x.id))),
                onThreadsChanged: loadThreads,
                onFactAdded: p.onFactAdded,
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="muted small">
          {status === "saved"
            ? "Sin observaciones guardadas. Guarda las que quieras conservar desde Consultar."
            : "Ninguna resuelta todavía."}
        </p>
      )}
    </div>
  );
}
