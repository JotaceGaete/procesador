"use client";

import { useState } from "react";
import {
  CHARACTER_SECTIONS,
  type Character,
  type CharacterImage,
  type ChapterInfo,
  type Fact,
  type Memory,
  type MemoryKind,
  type Place,
  type Relationship,
} from "@/lib/types";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import Modal from "./Modal";
import { CharacterCard, CharacterVisual } from "./CharacterGallery";

interface Props {
  novelId: string;
  memory: Memory;
  chapters: ChapterInfo[];
  /** Gallery images of every character (kept apart from `memory`, which feeds the assistant). */
  images: CharacterImage[];
  onChange(memory: Memory): void;
  /** A character's gallery changed on the server (upload, delete, main image, order…). */
  onImagesChange(characterId: string, images: CharacterImage[]): void;
  onClose(): void;
}

const TABS: { id: MemoryKind; label: string; create: string; empty: string }[] = [
  {
    id: "characters",
    label: "Personajes",
    create: "Nuevo personaje",
    empty: "Las fichas son la memoria que usa el asistente para escribir y verificar a cada personaje.",
  },
  { id: "relationships", label: "Relaciones", create: "Nueva relación", empty: "Por ejemplo: Juan → hermano de → Pedro." },
  { id: "places", label: "Lugares", create: "Nuevo lugar", empty: "Lugares que ya están establecidos y no deben cambiar." },
  {
    id: "facts",
    label: "Hechos",
    create: "Nuevo hecho",
    empty: "Hechos de continuidad: lo que ya ocurrió, quién sabe qué, fechas, marcas físicas.",
  },
];

const RELATION_SUGGESTIONS = [
  "hermano de",
  "hermana de",
  "padre de",
  "madre de",
  "hijo de",
  "hija de",
  "pareja de",
  "amante de",
  "ex pareja de",
  "amigo de",
  "enemigo de",
  "desconfía de",
  "le debe a",
  "trabaja para",
  "le teme a",
  "está enamorado de",
];

type Draft = Record<string, string | string[] | null>;

/** Narrative memory of one novel: a list per kind; picking an item swaps the list for its form. */
export default function MemoryModal({ novelId, memory, chapters, images, onChange, onImagesChange, onClose }: Props) {
  const [tab, setTab] = useState<MemoryKind>("characters");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; original: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const names = new Map(memory.characters.map((c) => [c.id, c.name]));
  const galleryOf = (id: string) => images.filter((i) => i.character_id === id);
  const placeNames = new Map(memory.places.map((p) => [p.id, p.name]));
  const dirty = editing ? JSON.stringify(editing.draft) !== editing.original : false;

  const open = (id: string | null, draft: Draft) => {
    setError("");
    setEditing({ id, draft, original: JSON.stringify(draft) });
  };
  const leave = (then: () => void) => (!dirty || confirm("Hay cambios sin guardar. ¿Descartarlos?")) && then();
  const set = (key: string, value: string | string[] | null) =>
    setEditing((e) => e && { ...e, draft: { ...e.draft, [key]: value } });

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const saved = editing.id
        ? await api<never>(`/api/memory/${tab}/${editing.id}`, { method: "PATCH", json: editing.draft })
        : await api<never>(`/api/novels/${novelId}/memory/${tab}`, { method: "POST", json: editing.draft });
      const list = memory[tab] as { id: string }[];
      const next = editing.id ? list.map((x) => (x.id === editing.id ? saved : x)) : [...list, saved];
      onChange({ ...memory, [tab]: next });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing?.id) return;
    const count = tab === "characters" ? galleryOf(editing.id).length : 0;
    const extra =
      tab === "characters"
        ? ` Se eliminarán también sus relaciones, sus vínculos con hechos${count ? ` y ${count === 1 ? "su imagen" : `sus ${count} imágenes`}` : ""}.`
        : "";
    if (!confirm(`¿Eliminar este elemento de la memoria?${extra} No se puede deshacer.`)) return;
    setBusy(true);
    try {
      await api(`/api/memory/${tab}/${editing.id}`, { method: "DELETE" });
      const id = editing.id;
      const next: Memory = { ...memory, [tab]: (memory[tab] as { id: string }[]).filter((x) => x.id !== id) };
      if (tab === "characters") {
        // Mirror the database cascade.
        next.relationships = next.relationships.filter((r) => r.from_id !== id && r.to_id !== id);
        next.facts = next.facts.map((f) => ({ ...f, character_ids: f.character_ids.filter((c) => c !== id) }));
        onImagesChange(id, []);
      }
      if (tab === "places") next.facts = next.facts.map((f) => (f.place_id === id ? { ...f, place_id: null } : f));
      onChange(next);
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const items = memory[tab] as { id: string }[];
  const label = (item: { id: string }): [string, string] => {
    if (tab === "characters") return [(item as Character).name, (item as Character).role];
    if (tab === "places") return [(item as Place).name, (item as Place).description.slice(0, 80)];
    if (tab === "relationships") {
      const r = item as Relationship;
      return [`${names.get(r.from_id)} → ${r.kind} → ${names.get(r.to_id)}`, r.note];
    }
    const f = item as Fact;
    const meta = [
      f.chapter_id
        ? chapterLabel(
            chapters.findIndex((c) => c.id === f.chapter_id),
            chapters.find((c) => c.id === f.chapter_id)?.title ?? "",
          )
        : "",
      f.story_time,
      f.place_id ? placeNames.get(f.place_id) : "",
      f.character_ids
        .map((id) => names.get(id))
        .filter(Boolean)
        .join(", "),
    ];
    return [f.text, meta.filter(Boolean).join(" · ")];
  };

  const blank = (): Draft => {
    if (tab === "characters") return Object.fromEntries(CHARACTER_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, ""])));
    if (tab === "places") return { name: "", aliases: "", description: "", notes: "" };
    if (tab === "relationships")
      return { from_id: memory.characters[0]?.id ?? "", kind: "", to_id: memory.characters[1]?.id ?? "", note: "" };
    return { text: "", chapter_id: null, place_id: null, story_time: "", note: "", character_ids: [] };
  };
  const toDraft = (item: { id: string }): Draft => {
    const d: Draft = {};
    for (const key of Object.keys(blank())) d[key] = (item as unknown as Draft)[key] ?? (key === "character_ids" ? [] : "");
    return d;
  };

  const tabInfo = TABS.find((t) => t.id === tab)!;
  const cantRelate = tab === "relationships" && memory.characters.length < 2;

  if (editing) {
    const d = editing.draft;
    return (
      <Modal
        title={editing.id ? label({ ...(items.find((x) => x.id === editing.id) ?? { id: "" }) })[0] : tabInfo.create}
        onClose={() => leave(onClose)}
        onBack={() => leave(() => setEditing(null))}
        wide={tab === "characters"}
      >
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {tab === "characters" &&
            (() => {
              const sections = CHARACTER_SECTIONS.map((section) => (
                <details key={section.title} className="group" open={section.open}>
                  <summary>{section.title}</summary>
                  {section.fields.map((f) => (
                    <Field
                      key={f.key}
                      label={f.label}
                      hint={f.hint}
                      rows={f.rows}
                      value={String(d[f.key] ?? "")}
                      onChange={(v) => set(f.key, v)}
                      required={f.key === "name"}
                      autoFocus={f.key === "name" && !editing.id}
                    />
                  ))}
                </details>
              ));
              const saved = editing.id ? memory.characters.find((c) => c.id === editing.id) : null;
              if (!saved) {
                return (
                  <>
                    {sections[0]}
                    <div className="group static">
                      <span className="group-title">Galería</span>
                      <p className="muted small">Guarda la ficha para añadir la imagen principal y referencias visuales.</p>
                    </div>
                    {sections.slice(1)}
                  </>
                );
              }
              return (
                <>
                  <CharacterVisual key={saved.id} novelId={novelId} character={saved} images={galleryOf(saved.id)} onImages={onImagesChange}>
                    {sections[0]}
                  </CharacterVisual>
                  {sections.slice(1)}
                </>
              );
            })()}
          {tab === "characters" && editing.id && <CharacterRelations id={editing.id} memory={memory} />}

          {tab === "relationships" && (
            <>
              <div className="relation-row">
                <select value={String(d.from_id)} onChange={(e) => set("from_id", e.target.value)} aria-label="Personaje">
                  {memory.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={String(d.kind)}
                  list="relation-kinds"
                  placeholder="hermano de, desconfía de…"
                  onChange={(e) => set("kind", e.target.value)}
                  required
                  autoFocus
                  aria-label="Relación"
                />
                <datalist id="relation-kinds">
                  {RELATION_SUGGESTIONS.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
                <select value={String(d.to_id)} onChange={(e) => set("to_id", e.target.value)} aria-label="Con">
                  {memory.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              {d.from_id === d.to_id && <p className="error small">Elige dos personajes distintos.</p>}
              <Field label="Nota" rows={2} value={String(d.note)} onChange={(v) => set("note", v)} />
            </>
          )}

          {tab === "places" && (
            <>
              <Field
                label="Nombre"
                rows={1}
                value={String(d.name)}
                onChange={(v) => set("name", v)}
                required
                autoFocus={!editing.id}
              />
              <Field
                label="También llamado"
                hint="Otras formas de nombrarlo en el texto, separadas por comas"
                rows={1}
                value={String(d.aliases)}
                onChange={(v) => set("aliases", v)}
              />
              <Field
                label="Descripción"
                hint="Lo que ya está establecido y no debe cambiar"
                rows={5}
                value={String(d.description)}
                onChange={(v) => set("description", v)}
              />
              <Field label="Notas" rows={2} value={String(d.notes)} onChange={(v) => set("notes", v)} />
            </>
          )}

          {tab === "facts" && (
            <>
              <Field
                label="Hecho"
                hint="Ej.: Pedro perdió dos dedos de la mano izquierda."
                rows={3}
                value={String(d.text)}
                onChange={(v) => set("text", v)}
                required
                autoFocus={!editing.id}
              />
              {memory.characters.length > 0 && (
                <fieldset className="checks">
                  <legend>Personajes</legend>
                  {memory.characters.map((c) => {
                    const ids = (d.character_ids as string[]) ?? [];
                    return (
                      <label key={c.id} className="check">
                        <input
                          type="checkbox"
                          checked={ids.includes(c.id)}
                          onChange={(e) =>
                            set("character_ids", e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))
                          }
                        />
                        {c.name}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              <div className="two">
                <label>
                  <span>Capítulo</span>
                  <select value={String(d.chapter_id ?? "")} onChange={(e) => set("chapter_id", e.target.value || null)}>
                    <option value="">—</option>
                    {chapters.map((c, i) => (
                      <option key={c.id} value={c.id}>
                        {chapterLabel(i, c.title)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Lugar</span>
                  <select value={String(d.place_id ?? "")} onChange={(e) => set("place_id", e.target.value || null)}>
                    <option value="">—</option>
                    {memory.places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Field
                label="Fecha o época narrativa"
                hint="Ej.: 14 de agosto de 1972"
                rows={1}
                value={String(d.story_time)}
                onChange={(v) => set("story_time", v)}
              />
              <Field label="Nota" rows={2} value={String(d.note)} onChange={(v) => set("note", v)} />
            </>
          )}

          {error && <p className="error">{error}</p>}
          <footer className="modal-foot">
            {editing.id && (
              <button type="button" className="link danger" onClick={remove} disabled={busy}>
                Eliminar
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={() => leave(() => setEditing(null))}>
              Cancelar
            </button>
            <button className="btn primary" disabled={busy || !dirty || (tab === "relationships" && d.from_id === d.to_id)}>
              {busy ? "Guardando…" : "Guardar"}
            </button>
          </footer>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Memoria narrativa" onClose={onClose} wide={tab === "characters"}>
      <nav className="tabs" aria-label="Memoria">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab ? "on" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
            <span className="muted small"> {(memory[t.id] as unknown[]).length || ""}</span>
          </button>
        ))}
      </nav>
      {tab === "characters" && items.length ? (
        <ul className="character-cards">
          {memory.characters.map((c) => (
            <li key={c.id}>
              <CharacterCard character={c} images={galleryOf(c.id)} onOpen={() => open(c.id, toDraft(c))} />
            </li>
          ))}
        </ul>
      ) : items.length ? (
        <ul className="item-list">
          {items.map((item) => {
            const [title, sub] = label(item);
            return (
              <li key={item.id}>
                <button onClick={() => open(item.id, toDraft(item))}>
                  <span className="item-title">{title}</span>
                  {sub && <span className="muted small">{sub}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{tabInfo.empty}</p>
      )}
      <footer className="modal-foot">
        {cantRelate && <span className="muted small">Necesitas al menos dos personajes.</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => open(null, blank())} disabled={cantRelate}>
          Añadir
        </button>
      </footer>
    </Modal>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  rows: number;
  value: string;
  onChange(v: string): void;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const { label, hint, rows, value, onChange, required, autoFocus } = props;
  return (
    <label>
      <span>{label}</span>
      {rows === 1 ? (
        <input
          value={value}
          placeholder={hint}
          required={required}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <textarea
          rows={rows}
          value={value}
          placeholder={hint}
          required={required}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

/** Read-only: the structured relationships of a character (edited in the Relaciones tab). */
function CharacterRelations({ id, memory }: { id: string; memory: Memory }) {
  const names = new Map(memory.characters.map((c) => [c.id, c.name]));
  const rels = memory.relationships.filter((r) => r.from_id === id || r.to_id === id);
  if (!rels.length) return null;
  return (
    <div className="group static">
      <span className="group-title">Relaciones</span>
      <ul className="plain">
        {rels.map((r) => (
          <li key={r.id}>
            {names.get(r.from_id)} → {r.kind} → {names.get(r.to_id)}
            {r.note && <span className="muted"> · {r.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
