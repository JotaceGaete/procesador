"use client";

import { useState } from "react";
import type { Project } from "@/lib/types";
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
    const res = await fetch("/api/project", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error);
    onSaved(form);
  }

  return (
    <Modal title="Proyecto" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          <span>Título</span>
          <input value={form.title} required onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label>
          <span>Sinopsis</span>
          <textarea
            rows={6}
            value={form.synopsis}
            placeholder="De qué va la historia, hacia dónde va. La IA la usa como contexto."
            onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
          />
        </label>
        <label>
          <span>Notas de estilo</span>
          <textarea
            rows={4}
            value={form.style_notes}
            placeholder="Narrador, tiempo verbal, tono, referencias, cosas que nunca quieres que la IA cambie…"
            onChange={(e) => setForm({ ...form, style_notes: e.target.value })}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <footer>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
