"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { NovelSummary, NovelTrashEntry } from "@/lib/types";
import { api, readPref } from "@/lib/client";
import { purgeDate } from "@/lib/novel-trash";
import BuildStamp from "./BuildStamp";

const dateFormat = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });

/** The author's novels: create, open, rename, duplicate, move to the trash and restore (docs/papelera-novelas.md). */
export default function Library() {
  const [novels, setNovels] = useState<NovelSummary[] | null>(null);
  const [trash, setTrash] = useState<NovelTrashEntry[] | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        api<NovelSummary[]>("/api/novels").then(setNovels),
        api<NovelTrashEntry[]>("/api/novels/trash").then(setTrash),
      ]).then(() => undefined),
    [],
  );

  useEffect(() => {
    setLastId(readPref("lastNovel"));
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("new");
    try {
      const { id } = await api<{ id: string }>("/api/novels", { method: "POST", json: { title: newTitle } });
      window.location.href = `/novela/${id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  const sorted = novels && lastId ? [...novels].sort((a, b) => (a.id === lastId ? -1 : b.id === lastId ? 1 : 0)) : novels;

  return (
    <main className="library">
      <header className="library-head">
        <h1>Biblioteca</h1>
        <span className="spacer" />
        <button
          className="link"
          onClick={async () => {
            await fetch("/api/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          Cerrar sesión
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!novels && !error && <p className="muted">Cargando…</p>}

      {sorted && (
        <ul className="novel-list">
          {sorted.map((n) => (
            <li key={n.id}>
              {renaming === n.id ? (
                <form
                  className="rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!draft.trim()) return;
                    setRenaming(null);
                    act(n.id, () => api(`/api/novels/${n.id}`, { method: "PATCH", json: { title: draft } }));
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    aria-label="Nuevo título"
                  />
                  <button className="btn primary">Guardar</button>
                  <button type="button" className="btn ghost" onClick={() => setRenaming(null)}>
                    Cancelar
                  </button>
                </form>
              ) : (
                <>
                  <Link href={`/novela/${n.id}`} className="novel-title">
                    {n.title}
                  </Link>
                  <span className="muted small">
                    {n.id === lastId && "Última abierta · "}
                    {n.chapters} {n.chapters === 1 ? "capítulo" : "capítulos"} · {n.words.toLocaleString("es")} palabras ·{" "}
                    {dateFormat.format(new Date(n.updated_at))}
                  </span>
                  {deleting === n.id ? (
                    <span className="confirm-delete">
                      ¿Mover «{n.title}» a la papelera? Podrás recuperarla durante 30 días; después se borra para siempre.{" "}
                      <button
                        className="btn danger"
                        disabled={busy === n.id}
                        onClick={() =>
                          act(n.id, () => api(`/api/novels/${n.id}`, { method: "DELETE" })).then(() => setDeleting(null))
                        }
                      >
                        Mover a la papelera
                      </button>{" "}
                      <button className="btn ghost" onClick={() => setDeleting(null)}>
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <span className="row-actions">
                      <button
                        className="link"
                        onClick={() => {
                          setDraft(n.title);
                          setRenaming(n.id);
                        }}
                      >
                        Renombrar
                      </button>
                      <button
                        className="link"
                        disabled={busy === n.id}
                        onClick={() => act(n.id, () => api(`/api/novels/${n.id}/duplicate`, { method: "POST" }))}
                      >
                        {busy === n.id ? "Duplicando…" : "Duplicar"}
                      </button>
                      <button className="link danger" onClick={() => setDeleting(n.id)}>
                        Eliminar
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {novels && !novels.length && <p className="muted">Todavía no hay novelas.</p>}

      {trash && trash.length > 0 && (
        <section style={{ marginTop: 24 }} aria-label="Papelera de novelas">
          <button className="link" aria-expanded={showTrash} onClick={() => setShowTrash((v) => !v)}>
            Papelera ({trash.length}) {showTrash ? "▴" : "▾"}
          </button>
          {showTrash && (
            <ul className="novel-list">
              {trash.map((n) => (
                <li key={n.id}>
                  <span className="novel-title">{n.title}</span>
                  <span className="muted small">
                    {n.chapters} {n.chapters === 1 ? "capítulo" : "capítulos"} · {n.words.toLocaleString("es")} palabras · se
                    borra el {dateFormat.format(purgeDate(n.deleted_at))}
                  </span>
                  <span className="row-actions">
                    <button
                      className="link"
                      disabled={busy === n.id}
                      onClick={() => act(n.id, () => api(`/api/novels/${n.id}/restore`, { method: "POST" }))}
                    >
                      {busy === n.id ? "Recuperando…" : "Recuperar"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {creating ? (
        <form className="rename" onSubmit={create}>
          <input
            autoFocus
            value={newTitle}
            placeholder="Título"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
            aria-label="Título de la nueva novela"
          />
          <button className="btn primary" disabled={busy === "new"}>
            Crear
          </button>
          <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
            Cancelar
          </button>
        </form>
      ) : (
        <button className="btn" onClick={() => setCreating(true)}>
          Nueva novela
        </button>
      )}
      <footer className="library-foot">
        <BuildStamp />
      </footer>
    </main>
  );
}
