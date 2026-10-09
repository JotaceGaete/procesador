"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import type { MapChapter, Presence, Repetition } from "@/lib/advisor/stats";
import type { MonthUsage } from "@/lib/ai/usage";
import type { Memory } from "@/lib/types";
import { formatTokens, formatUsd } from "./format";

interface Overview {
  chapterId: string;
  chapters: MapChapter[];
  characters: Presence[];
  places: Presence[];
  repetitions: { chapter: Repetition[]; novel: Repetition[] };
  usage: MonthUsage;
}

interface Props {
  novelId: string;
  chapterId: string;
  memory: Memory;
  getContent(): string;
  /** Selects the occurrence in the editor, opening its chapter if needed. */
  onGoTo(chapterId: string, start: number, end: number, text: string): void;
}

/**
 * Panorama: what the text shows, measured without AI (docs/consejero.md, phase 1).
 * Recomputed when opened, on "Actualizar" and when the chapter changes; never while typing.
 */
export default function AdvisorOverview({ novelId, chapterId, memory, getContent, onGoTo }: Props) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<"chapter" | "novel">("chapter");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<Overview>(`/api/novels/${novelId}/advisor`, {
        method: "POST",
        json: { chapterId, content: getContent() },
      });
      if (n === seq.current) setData(result);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [novelId, chapterId, getContent]);

  useEffect(() => {
    load();
  }, [load, memory]);

  if (!data) return <p className="muted small">{error || "Leyendo la novela…"}</p>;

  const index = data.chapters.findIndex((c) => c.id === data.chapterId);
  const label = (id: string) => {
    const i = data.chapters.findIndex((c) => c.id === id);
    return i === -1 ? "" : chapterLabel(i, data.chapters[i].title, data.chapters[i].reserved);
  };
  const names = new Map([...memory.characters, ...memory.places].map((x) => [x.id, x.name]));
  // Who has been away the longest comes first; those not yet in the story, last.
  const people = [...data.characters].sort(
    (a, b) => (b.chaptersSince ?? -1) - (a.chaptersSince ?? -1) || (b.wordsSince ?? 0) - (a.wordsSince ?? 0),
  );
  const repetitions = scope === "chapter" ? data.repetitions.chapter : data.repetitions.novel;
  const u = data.usage;

  return (
    <div className="overview" aria-busy={loading}>
      <div className="overview-head">
        <span className="muted small">Medido en el texto, sin IA. El manuscrito manda.</span>
        <span className="spacer" />
        <button className="link small" onClick={load} disabled={loading}>
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}

      <section aria-label="Personajes">
        <h3>Personajes</h3>
        {people.length ? (
          <ul className="presence">
            {people.map((p) => (
              <li key={p.id}>
                <span className="who">{p.name}</span>
                <span className="muted small">
                  {p.chaptersSince == null
                    ? p.first != null
                      ? `aparece en ${label(data.chapters[p.first].id)}`
                      : "aún no aparece"
                    : p.chaptersSince === 0
                      ? `en este capítulo · ${p.counts[index]} ${p.counts[index] === 1 ? "mención" : "menciones"}`
                      : `última vez en ${label(data.chapters[index - p.chaptersSince].id)} · hace ${p.chaptersSince} ${
                          p.chaptersSince === 1 ? "capítulo" : "capítulos"
                        }, ≈${formatTokens(p.wordsSince ?? 0)} palabras`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Sin personajes en la memoria.</p>
        )}
      </section>

      <section aria-label="Repeticiones">
        <h3>Repeticiones</h3>
        <nav className="tabs small" aria-label="Alcance">
          <button className={scope === "chapter" ? "on" : undefined} onClick={() => setScope("chapter")}>
            Este capítulo
          </button>
          <button className={scope === "novel" ? "on" : undefined} onClick={() => setScope("novel")}>
            Entre capítulos
          </button>
        </nav>
        {repetitions.length ? (
          <ul className="repetitions">
            {repetitions.map((r) => (
              <li key={`${r.kind}:${r.text.toLowerCase()}`}>
                <p>
                  <span className="phrase">«{r.text}»</span>{" "}
                  <span className="muted small">
                    {r.kind === "eco" ? "cerca" : ""} ×{r.occurrences.length}
                  </span>
                </p>
                <ol>
                  {r.occurrences.map((o) => (
                    <li key={`${o.chapterId}:${o.start}`}>
                      <button
                        className="link small"
                        onClick={() => onGoTo(o.chapterId, o.start, o.end, r.text)}
                        title="Seleccionar en el texto"
                      >
                        Ir
                      </button>{" "}
                      {scope === "novel" && <span className="muted small">{label(o.chapterId)} · </span>}
                      <span className="snippet">{o.snippet}</span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            {scope === "chapter" ? "No hay frases ni palabras repetidas de cerca." : "No hay frases repetidas entre capítulos."}
          </p>
        )}
      </section>

      <section aria-label="Mapa de la novela">
        <h3>Mapa de la novela</h3>
        <ol className="novel-map">
          {data.chapters.map((c, i) => (
            <li key={c.id} className={c.id === data.chapterId ? "current" : undefined}>
              <span className="map-title">{chapterLabel(i, c.title, c.reserved)}</span>
              <span className="muted small"> · {c.words.toLocaleString("es")} palabras</span>
              {(c.characters.length > 0 || c.places.length > 0) && (
                <span className="muted small map-who">
                  {[...c.characters, ...c.places]
                    .slice(0, 6)
                    .map((id) => names.get(id))
                    .filter(Boolean)
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Uso de la IA">
        <h3>Uso de la IA este mes</h3>
        <p className="muted small usage-month">
          {u.requests
            ? `${u.requests} ${u.requests === 1 ? "consulta" : "consultas"} · ${formatTokens(u.input)} tokens leídos${
                u.cached ? ` (${formatTokens(u.cached)} en caché)` : ""
              } · ${formatTokens(u.output)} escritos${u.costUsd != null ? ` · ≈ ${formatUsd(u.costUsd)}` : ""}`
            : "Ninguna consulta este mes."}
        </p>
      </section>
    </div>
  );
}
