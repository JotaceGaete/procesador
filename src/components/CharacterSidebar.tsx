"use client";

import { MAX_CHARACTERS, type Character, type Project } from "@/lib/types";

interface Props {
  project: Project;
  characters: Character[];
  onEditProject: () => void;
  onEdit: (c: Character) => void;
  onNew: () => void;
}

export default function CharacterSidebar({ project, characters, onEditProject, onEdit, onNew }: Props) {
  const full = characters.length >= MAX_CHARACTERS;
  return (
    <aside className="sidebar">
      <section>
        <h2>Proyecto</h2>
        <button className="list-item" onClick={onEditProject}>
          <strong>{project.title}</strong>
          <span className="muted small">{project.synopsis ? "Sinopsis y estilo" : "Añadir sinopsis y notas de estilo"}</span>
        </button>
      </section>

      <section>
        <h2>
          Personajes{" "}
          <span className="muted small">
            {characters.length}/{MAX_CHARACTERS}
          </span>
        </h2>
        {characters.map((c) => (
          <button key={c.id} className="list-item" onClick={() => onEdit(c)}>
            <strong>{c.name}</strong>
            {c.role && <span className="muted small">{c.role}</span>}
          </button>
        ))}
        <button className="btn ghost full" onClick={onNew} disabled={full} title={full ? "Límite alcanzado" : undefined}>
          + Nuevo personaje
        </button>
      </section>

      <section className="sidebar-foot">
        <button
          className="btn ghost small"
          onClick={async () => {
            await fetch("/api/logout", { method: "POST" });
            window.location.href = "/login";
          }}
        >
          Cerrar sesión
        </button>
      </section>
    </aside>
  );
}
