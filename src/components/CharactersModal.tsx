"use client";

import { useState } from "react";
import { CHARACTER_FIELDS, MAX_CHARACTERS, type Character, type CharacterInput } from "@/lib/types";
import { api } from "@/lib/client";
import Modal from "./Modal";

interface Props {
  characters: Character[];
  onChange: (characters: Character[]) => void;
  onClose: () => void;
}

const EMPTY: CharacterInput = {
  name: "",
  aliases: "",
  role: "",
  background: "",
  traits: "",
  voice: "",
  motivations: "",
  relationships: "",
  arc: "",
  notes: "",
};

/** List of characters; picking one (or "Nuevo") swaps the list for its sheet. */
export default function CharactersModal({ characters, onChange, onClose }: Props) {
  const [editing, setEditing] = useState<Character | "new" | null>(null);

  if (editing) {
    return (
      <CharacterSheet
        character={editing === "new" ? null : editing}
        onBack={() => setEditing(null)}
        onClose={onClose}
        onSaved={(saved) => {
          const exists = characters.some((c) => c.id === saved.id);
          onChange(exists ? characters.map((c) => (c.id === saved.id ? saved : c)) : [...characters, saved]);
          setEditing(null);
        }}
        onDeleted={(id) => {
          onChange(characters.filter((c) => c.id !== id));
          setEditing(null);
        }}
      />
    );
  }

  const full = characters.length >= MAX_CHARACTERS;
  return (
    <Modal title="Personajes" onClose={onClose}>
      {characters.length ? (
        <ul className="char-list">
          {characters.map((c) => (
            <li key={c.id}>
              <button onClick={() => setEditing(c)}>
                <span className="char-name">{c.name}</span>
                {c.role && <span className="muted">{c.role}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Aún no hay personajes. Sus fichas son la memoria que usa la IA para verificar la consistencia.</p>
      )}
      <footer className="modal-foot">
        <span className="muted small">
          {characters.length} de {MAX_CHARACTERS}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => setEditing("new")} disabled={full}>
          Nuevo personaje
        </button>
      </footer>
    </Modal>
  );
}

function CharacterSheet({
  character,
  onBack,
  onClose,
  onSaved,
  onDeleted,
}: {
  character: Character | null;
  onBack: () => void;
  onClose: () => void;
  onSaved: (c: Character) => void;
  onDeleted: (id: string) => void;
}) {
  const [form, setForm] = useState<CharacterInput>(() => {
    if (!character) return EMPTY;
    const { id: _id, project_id: _p, ...rest } = character;
    return { ...EMPTY, ...rest };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = character ? CHARACTER_FIELDS.some((f) => (character[f.key] ?? "") !== form[f.key]) : form.name.trim() !== "";

  function leave(action: () => void) {
    if (!dirty || confirm("Hay cambios sin guardar en la ficha. ¿Descartarlos?")) action();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await api<Character>(character ? `/api/characters/${character.id}` : "/api/characters", {
        method: character ? "PATCH" : "POST",
        json: form,
      });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!character || !confirm(`¿Eliminar la ficha de ${character.name}? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      await api(`/api/characters/${character.id}`, { method: "DELETE" });
      onDeleted(character.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={character ? character.name : "Nuevo personaje"} onClose={() => leave(onClose)} onBack={() => leave(onBack)}>
      <form onSubmit={submit} className="form">
        {CHARACTER_FIELDS.map((f) => (
          <label key={f.key} className={f.rows === 1 ? "short" : undefined}>
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
        <footer className="modal-foot">
          {character && (
            <button type="button" className="link danger" onClick={remove} disabled={busy}>
              Eliminar
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={() => leave(onBack)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !form.name.trim() || !dirty}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
