"use client";

import { useState } from "react";
import type { Project } from "@/lib/types";
import { api } from "@/lib/client";
import Modal from "./Modal";

type Meta = Pick<Project, "title" | "synopsis" | "style_notes">;

export default function ProjectModal({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (p: Meta) => void;
}) {
  const [form, setForm] = useState<Meta>({ title: project.title, synopsis: project.synopsis, style_notes: project.style_notes });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/project", { method: "PATCH", json: form });
      onSaved(form);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Proyecto" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label className="short">
          <span>Título</span>
          <input value={form.title} required onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label>
          <span>Sinopsis</span>
          <textarea
            rows={6}
            value={form.synopsis}
            placeholder="De qué va la historia y hacia dónde va."
            onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
          />
        </label>
        <label>
          <span>Notas de estilo</span>
          <textarea
            rows={4}
            value={form.style_notes}
            placeholder="Narrador, tiempo verbal, tono, lo que la IA nunca debe cambiar…"
            onChange={(e) => setForm({ ...form, style_notes: e.target.value })}
          />
        </label>
        <p className="muted small">La sinopsis y las notas de estilo acompañan a cada análisis.</p>
        {error && <p className="error">{error}</p>}
        <footer className="modal-foot">
          <button
            type="button"
            className="link"
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              window.location.href = "/login";
            }}
          >
            Cerrar sesión
          </button>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !form.title.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
