"use client";

import { useState } from "react";
import {
  CHARACTER_SECTIONS,
  type Character,
  type CharacterImage,
  type ChapterInfo,
  type ManuscriptImage,
  type Fact,
  type Memory,
  type MemoryKind,
  type Place,
  type Relationship,
} from "@/lib/types";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import { COMMON_RELATIONS, resolveRelation, usedRelations } from "@/lib/relations";
import Modal from "./Modal";
import { CharacterTimeEditor } from "./Chronology";
import type { AgeAnchor, StoryDate } from "@/lib/chronology";
import type { ChronologyView } from "@/lib/types";
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
  /** Images of the book: to know when a gallery file is also used in the manuscript. */
  manuscriptImages: ManuscriptImage[];
  /** A file replaced in every use: the novel's gallery and manuscript images. */
  onAllImagesChange(all: { images: CharacterImage[]; manuscriptImages: ManuscriptImage[] }): void;
  /** Inserts a gallery file in the open chapter, at the cursor, without copying it. */
  onInsertInChapter(assetId: string): void;
  /** Cronología: the calendar and the ages computed per chapter (docs/cronologia-edades.md). */
  chronology: ChronologyView | null;
  currentChapterId: string;
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


type Draft = Record<string, unknown>;

/** Narrative memory of one novel: a list per kind; picking an item swaps the list for its form. */
export default function MemoryModal({
  novelId,
  memory,
  chapters,
  images,
  manuscriptImages,
  onChange,
  onImagesChange,
  onAllImagesChange,
  onInsertInChapter,
  chronology,
  currentChapterId,
  onClose,
}: Props) {
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
  const set = (key: string, value: unknown) =>
    setEditing((e) => e && { ...e, draft: { ...e.draft, [key]: value } });

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      // Relaciones personalizadas: the form already used in the novel, never a trivial duplicate.
      const draft =
        tab === "relationships"
          ? { ...editing.draft, kind: resolveRelation(String(editing.draft.kind), memory.relationships, editing.id).kind }
          : editing.draft;
      const saved = editing.id
        ? await api<never>(`/api/memory/${tab}/${editing.id}`, { method: "PATCH", json: draft })
        : await api<never>(`/api/novels/${novelId}/memory/${tab}`, { method: "POST", json: draft });
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
            chapters.find((c) => c.id === f.chapter_id)?.reserved,
          )
        : "",
      f.story_time,
      f.place_id ? placeNames.get(f.place_id) : "",
      f.character_ids
        .map((id) => names.get(id))
        .filter(Boolean)
        .join(", "),
    ];
    // A fact the Consejero proposed is not canon until the author approves it.
    return [f.text, [f.status === "suggested" ? "Sugerido por el Consejero, sin aprobar" : "", ...meta].filter(Boolean).join(" · ")];
  };

  const blank = (): Draft => {
    if (tab === "characters")
      return {
        ...Object.fromEntries(CHARACTER_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, ""]))),
        age_anchor: null,
        age_approx: false,
        death: null,
      };
    if (tab === "places") return { name: "", aliases: "", description: "", notes: "" };
    if (tab === "relationships")
      return { from_id: memory.characters[0]?.id ?? "", kind: "", to_id: memory.characters[1]?.id ?? "", note: "" };
    return { text: "", chapter_id: null, place_id: null, story_time: "", note: "", character_ids: [], status: "approved" };
  };
  const toDraft = (item: { id: string }): Draft => {
    const d: Draft = {};
    const empty = blank();
    for (const key of Object.keys(empty)) d[key] = (item as unknown as Draft)[key] ?? (key === "character_ids" ? [] : empty[key]);
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
              const chapterIndex = chapters.findIndex((c) => c.id === currentChapterId);
              const timeEditor = (
                <CharacterTimeEditor
                  key={`time-${editing.id ?? "new"}`}
                  value={{
                    age_anchor: (d.age_anchor as AgeAnchor | null) ?? null,
                    age_approx: d.age_approx === true,
                    death: (d.death as StoryDate | null) ?? null,
                  }}
                  onChange={(v) => setEditing((e) => e && { ...e, draft: { ...e.draft, ...v } })}
                  chapters={chapters}
                  calendar={chronology?.calendar ?? "real"}
                  now={(saved && chronology?.characters.find((c) => c.id === saved.id)?.ages[chapterIndex]) ?? null}
                />
              );
              if (!saved) {
                return (
                  <>
                    {sections[0]}
                    {timeEditor}
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
                  <CharacterVisual
                    key={saved.id}
                    novelId={novelId}
                    character={saved}
                    images={galleryOf(saved.id)}
                    allImages={images}
                    manuscriptImages={manuscriptImages}
                    names={names}
                    onInsertInChapter={onInsertInChapter}
                    onImages={onImagesChange}
                    onAllImages={onAllImagesChange}
                  >
                    {sections[0]}
                  </CharacterVisual>
                  {timeEditor}
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
                <RelationKind
                  value={String(d.kind)}
                  original={editing.id ? String(JSON.parse(editing.original).kind ?? "") : ""}
                  relationships={memory.relationships}
                  editingId={editing.id}
                  onChange={(v) => set("kind", v)}
                />
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
              {JSON.parse(editing.original).status === "suggested" && (
                <label className="check suggested-fact">
                  <input
                    type="checkbox"
                    checked={d.status === "approved"}
                    onChange={(e) => set("status", e.target.checked ? "approved" : "suggested")}
                  />
                  <span>Aprobar: lo propuso el Consejero y aún no cuenta como canon</span>
                </label>
              )}
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
                        {chapterLabel(i, c.title, c.reserved)}
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

const CUSTOM = "__nueva-relacion__";

/**
 * The kind of a relationship (docs/relaciones.md): the common ones, the ones already used in this
 * novel, or «+ Crear relación personalizada» to write any other. What the author writes is kept
 * as written; if the novel (or the common list) already has it with other case, spacing or
 * accents, that form is used and the form says so.
 */
function RelationKind({
  value,
  original,
  relationships,
  editingId,
  onChange,
}: {
  value: string;
  original: string;
  relationships: Relationship[];
  editingId: string | null;
  onChange(v: string): void;
}) {
  const used = usedRelations(relationships, editingId);
  const options = [...COMMON_RELATIONS, ...used];
  // The relationship's own kind, exactly as stored, is always there to keep (old data may have
  // a variant of another form): editing never changes it behind the author's back.
  const own = original && !options.includes(original) ? original : "";
  const listed = (v: string) => options.includes(v) || (!!own && v === own);
  const [custom, setCustom] = useState(() => !!value && !listed(value));
  const resolved = custom ? resolveRelation(value, relationships, editingId) : null;
  const known = resolved?.reused ?? null;
  const selectValue = custom ? CUSTOM : value;
  return (
    <span className="relation-kind">
      <select
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            onChange("");
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        required
        autoFocus={!custom}
        aria-label="Relación"
      >
        <option value="" disabled>
          Elige la relación…
        </option>
        {own && (
          <optgroup label="Esta relación">
            <option value={own}>{own}</option>
          </optgroup>
        )}
        <optgroup label="Comunes">
          {COMMON_RELATIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </optgroup>
        {used.length > 0 && (
          <optgroup label="Usadas en esta novela">
            {used.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </optgroup>
        )}
        <option value={CUSTOM}>+ Crear relación personalizada</option>
      </select>
      {custom && (
        <>
          <input
            value={value}
            placeholder="amante de, socio de, padrino de…"
            onChange={(e) => onChange(e.target.value)}
            required
            autoFocus
            aria-label="Relación personalizada"
            maxLength={80}
          />
          {known && (
            <span className="muted small" role="status">
              Ya existe como «{known}»: se usará esa forma.
            </span>
          )}
        </>
      )}
    </span>
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
