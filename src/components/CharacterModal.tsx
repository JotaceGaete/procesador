"use client";

import { useState } from "react";
import { CHARACTER_FIELDS, type Character, type CharacterInput } from "@/lib/types";
import Modal from "./Modal";

interface Props {
  character: Character | null;
  onClose: () => void;
  onSaved: (c: Character) => void;
  onDeleted: (id: string) => void;
}

const EMPTY: CharacterInput = { name: "", role: "", background: "", voice: "", traits: "", arc: "", notes: "" };

export default function CharacterModal({ character, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<CharacterInput>(() => {
    if (!character) return EMPTY;
    const { id: _id, project_id: _p, ...rest } = character;
    return { ...EMPTY, ...rest };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(character ? `/api/characters/${character.id}` : "/api/characters", {
      method: character ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error);
    onSaved(data);
  }

  async function remove() {
    if (!character || !confirm(`¿Eliminar a ${character.name}? No se puede deshacer.`)) return;
    setBusy(true);
    const res = await fetch(`/api/characters/${character.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setError("No se pudo eliminar");
    onDeleted(character.id);
  }

  return (
    <Modal title={character ? character.name : "Nuevo personaje"} onClose={onClose}>
      <form onSubmit={submit} className="form">
        {CHARACTER_FIELDS.map((f) => (
          <label key={f.key}>
            <span>{f.label}</span>
            {f.rows === 1 ? (
              <input
                value={form[f.key]}
                placeholder={f.hint}
                required={f.key === "name"}
                autoFocus={f.key === "name" && !character}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            ) : (
              <textarea
                rows={f.rows}
                value={form[f.key]}
                placeholder={f.hint}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        {error && <p className="error">{error}</p>}
        <footer>
          {character && (
            <button type="button" className="btn danger" onClick={remove} disabled={busy}>
              Eliminar
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !form.name.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
