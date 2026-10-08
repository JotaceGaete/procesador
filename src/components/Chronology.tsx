"use client";

import { useState } from "react";
import type { AgeAnchor, Calendar, Interval, StoryDate, TimeMark, TimeWhen } from "@/lib/chronology";
import type { ChronologyView } from "@/lib/types";
import { api } from "@/lib/client";
import { chapterLabel } from "@/lib/ai/context";
import Modal from "./Modal";

/** Cronología (docs/cronologia-edades.md): dates, the character's age, the chapters' time. */

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const num = (s: string) => (s.trim() === "" || !/^-?\d+$/.test(s.trim()) ? undefined : Number(s.trim()));

/** A partial date: year (or "Año N"), and optionally month and day. */
export function StoryDateInput({
  value,
  onChange,
  calendar,
  label,
}: {
  value: StoryDate | null;
  onChange(d: StoryDate | null): void;
  calendar: Calendar;
  label: string;
}) {
  const [year, setYear] = useState(value ? String(value.year) : "");
  const emit = (y: string, month?: number, day?: number) => {
    const n = num(y);
    onChange(n === undefined ? null : { year: n, ...(month ? { month } : {}), ...(month && day ? { day } : {}) });
  };
  return (
    <span className="story-date" role="group" aria-label={label}>
      <input
        inputMode="numeric"
        value={year}
        placeholder={calendar === "relative" ? "Año (0, 5…)" : "Año"}
        aria-label={calendar === "relative" ? "Año relativo" : "Año"}
        onChange={(e) => {
          setYear(e.target.value);
          emit(e.target.value, value?.month, value?.day);
        }}
      />
      <select aria-label="Mes" value={value?.month ?? ""} onChange={(e) => emit(year, num(e.target.value), value?.day)} disabled={!value}>
        <option value="">— mes —</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <input
        inputMode="numeric"
        aria-label="Día"
        placeholder="Día"
        value={value?.day ?? ""}
        disabled={!value?.month}
        onChange={(e) => emit(year, value?.month, num(e.target.value))}
      />
    </span>
  );
}

export interface CharacterTimeValue {
  age_anchor: AgeAnchor | null;
  age_approx: boolean;
  death: StoryDate | null;
}

/**
 * The character's age in the story's time: born on a date, or N years old in a chapter (or
 * on a date). The age in each chapter is computed from it; the free note "Edad o nacimiento"
 * stays as it is. The anchor exists only once its data is complete: nothing is invented.
 */
export function CharacterTimeEditor({
  value,
  onChange,
  chapters,
  calendar,
  now,
}: {
  value: CharacterTimeValue;
  onChange(v: CharacterTimeValue): void;
  chapters: { id: string; title: string }[];
  calendar: Calendar;
  /** "En este capítulo: 26 años", as last computed by the server. */
  now: string | null;
}) {
  const a = value.age_anchor;
  const [kind, setKind] = useState<"none" | "birth" | "age_chapter" | "age_date">(
    !a ? "none" : a.kind === "birth" ? "birth" : "chapter_id" in a.at ? "age_chapter" : "age_date",
  );
  const [birth, setBirth] = useState<StoryDate | null>(a?.kind === "birth" ? a.date : null);
  const [age, setAge] = useState(a?.kind === "age_at" ? String(a.age) : "");
  const [chapterId, setChapterId] = useState(a?.kind === "age_at" && "chapter_id" in a.at ? a.at.chapter_id : (chapters[0]?.id ?? ""));
  const [ageDate, setAgeDate] = useState<StoryDate | null>(a?.kind === "age_at" && "date" in a.at ? a.at.date : null);
  const [showDeath, setShowDeath] = useState(Boolean(value.death));

  const emit = (next: { kind?: typeof kind; birth?: StoryDate | null; age?: string; chapterId?: string; ageDate?: StoryDate | null }) => {
    const k = next.kind ?? kind;
    const b = next.birth !== undefined ? next.birth : birth;
    const n = num(next.age ?? age);
    const ch = next.chapterId ?? chapterId;
    const d = next.ageDate !== undefined ? next.ageDate : ageDate;
    const anchor: AgeAnchor | null =
      k === "birth" && b
        ? { kind: "birth", date: b }
        : k === "age_chapter" && n !== undefined && n >= 0 && ch
          ? { kind: "age_at", age: n, at: { chapter_id: ch } }
          : k === "age_date" && n !== undefined && n >= 0 && d
            ? { kind: "age_at", age: n, at: { date: d } }
            : null;
    onChange({ ...value, age_anchor: anchor });
  };
  const incomplete = kind !== "none" && !value.age_anchor;

  return (
    <details className="group" open>
      <summary>Edad en el tiempo del relato</summary>
      <p className="muted small">
        La edad no se escribe: se calcula en cada capítulo a partir de esto y del tiempo de los capítulos (Cronología). La
        nota «Edad o nacimiento» se conserva tal cual.
      </p>
      <label>
        <span>Se sabe</span>
        <select
          aria-label="Qué se sabe de su edad"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as typeof kind;
            setKind(k);
            emit({ kind: k });
          }}
        >
          <option value="none">Sin definir</option>
          <option value="birth">Su nacimiento</option>
          <option value="age_chapter">Su edad en un capítulo</option>
          <option value="age_date">Su edad en una fecha</option>
        </select>
      </label>
      {kind === "birth" && (
        <label>
          <span>Nació</span>
          <StoryDateInput
            label="Fecha de nacimiento"
            calendar={calendar}
            value={birth}
            onChange={(d) => {
              setBirth(d);
              emit({ birth: d });
            }}
          />
        </label>
      )}
      {(kind === "age_chapter" || kind === "age_date") && (
        <div className="age-at">
          <label>
            <span>Tenía</span>
            <input
              inputMode="numeric"
              aria-label="Años que tenía"
              placeholder="años"
              value={age}
              onChange={(e) => {
                setAge(e.target.value);
                emit({ age: e.target.value });
              }}
            />
          </label>
          {kind === "age_chapter" ? (
            <label>
              <span>años en</span>
              <select
                aria-label="Capítulo"
                value={chapterId}
                onChange={(e) => {
                  setChapterId(e.target.value);
                  emit({ chapterId: e.target.value });
                }}
              >
                {chapters.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {chapterLabel(i, c.title)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              <span>años en</span>
              <StoryDateInput
                label="Fecha"
                calendar={calendar}
                value={ageDate}
                onChange={(d) => {
                  setAgeDate(d);
                  emit({ ageDate: d });
                }}
              />
            </label>
          )}
        </div>
      )}
      {incomplete && <p className="muted small">Completa los datos para que se calcule la edad.</p>}
      {kind !== "none" && (
        <label className="check">
          <input type="checkbox" checked={value.age_approx} onChange={(e) => onChange({ ...value, age_approx: e.target.checked })} />
          <span>Edad aproximada («unos cuarenta»)</span>
        </label>
      )}
      {showDeath ? (
        <label>
          <span>Muere</span>
          <StoryDateInput label="Fecha de muerte" calendar={calendar} value={value.death} onChange={(d) => onChange({ ...value, death: d })} />
        </label>
      ) : (
        <button type="button" className="link small" onClick={() => setShowDeath(true)}>
          + Fecha de muerte (para avisar si aparece después)
        </button>
      )}
      {now && <p className="muted small age-now">En este capítulo: {now}</p>}
    </details>
  );
}

/** The story's time at the start of a chapter: a date, how long after the previous one, or inherited. */
function TimeMarkEditor({
  chapterId,
  mark,
  calendar,
  onSaved,
  onCancel,
}: {
  chapterId: string;
  mark: TimeMark | null;
  calendar: Calendar;
  onSaved(): void;
  onCancel(): void;
}) {
  const [kind, setKind] = useState<"none" | "date" | "after">(!mark ? "date" : "date" in mark.when ? "date" : "after");
  const [date, setDate] = useState<StoryDate | null>(mark && "date" in mark.when ? mark.when.date : null);
  const [after, setAfter] = useState<Interval>(mark && "after" in mark.when ? mark.when.after : { years: 1 });
  const [flashback, setFlashback] = useState(mark?.flashback ?? false);
  const [label, setLabel] = useState(mark?.label ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (kind === "none") await api(`/api/chapters/${chapterId}/time`, { method: "DELETE" });
      else {
        if (kind === "date" && !date) throw new Error("Escribe al menos el año.");
        const when: TimeWhen = kind === "date" ? { date: date! } : { after };
        await api(`/api/chapters/${chapterId}/time`, { method: "PUT", json: { when, flashback, label } });
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const unit = (k: keyof Interval, name: string) => (
    <label className="interval">
      <input
        inputMode="numeric"
        aria-label={name}
        value={after[k] ?? ""}
        onChange={(e) => setAfter({ ...after, [k]: num(e.target.value) })}
      />
      <span>{name}</span>
    </label>
  );

  return (
    <form
      className="time-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <select aria-label="Tiempo del capítulo" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
        <option value="date">Fecha</option>
        <option value="after">Tiempo después del anterior</option>
        <option value="none">Sin fecha propia (el del capítulo anterior)</option>
      </select>
      {kind === "date" && <StoryDateInput label="Fecha del capítulo" calendar={calendar} value={date} onChange={setDate} />}
      {kind === "after" && (
        <span className="interval-row">
          {unit("years", "años")}
          {unit("months", "meses")}
          {unit("days", "días")}
          <span className="muted small">después</span>
        </span>
      )}
      {kind !== "none" && (
        <>
          <label className="check">
            <input type="checkbox" checked={flashback} onChange={(e) => setFlashback(e.target.checked)} />
            <span>Retrospectiva</span>
          </label>
          <input aria-label="Nota del tiempo" placeholder="Nota (opcional): «esa misma noche»" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
        </>
      )}
      {error && <p className="error small">{error}</p>}
      <span className="time-actions">
        <button className="btn" disabled={busy}>
          Guardar
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancelar
        </button>
      </span>
    </form>
  );
}

/**
 * The Cronología: the calendar, each chapter's time (editable), each character's age per
 * chapter, and the warnings. Warnings never block anything; each can be dismissed.
 */
export function ChronologyModal({
  novelId,
  view,
  currentChapterId,
  onChanged,
  onGoTo,
  onClose,
}: {
  novelId: string;
  view: ChronologyView;
  currentChapterId: string;
  /** Something changed on the server: reload the view. */
  onChanged(): Promise<void>;
  onGoTo(chapterId: string): void;
  onClose(): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState("");
  const names = new Map(view.characters.map((c) => [c.id, c.name]));
  const anchored = view.characters.filter((c) => c.anchored);
  const open = view.warnings.filter((w) => !w.dismissed);
  const dismissed = view.warnings.filter((w) => w.dismissed);
  const warned = new Set(open.flatMap((w) => w.chapterIds.flatMap((ch) => (w.characterIds.length ? w.characterIds : [""]).map((c) => `${ch}:${c}`))));

  const patch = async (json: unknown) => {
    setError("");
    try {
      await api(`/api/novels/${novelId}/chronology`, { method: "PATCH", json });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Cronología" onClose={onClose} wide>
      <div className="chrono-head">
        <label>
          <span>Calendario</span>
          <select aria-label="Calendario" value={view.calendar} onChange={(e) => patch({ calendar: e.target.value })}>
            <option value="real">Fechas reales (1972)</option>
            <option value="relative">Relativo (Año 0, Año 5…)</option>
          </select>
        </label>
        <p className="muted small">
          Cada capítulo empieza en una fecha, cierto tiempo después del anterior, o en el mismo momento que el anterior. Las
          edades se calculan con eso y con lo que sabes de cada personaje (en su ficha). Las advertencias son avisos: nada se
          bloquea.
        </p>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="chrono-table-wrap">
        <table className="chrono-table">
          <thead>
            <tr>
              <th scope="col">Capítulo</th>
              <th scope="col">Tiempo del relato</th>
              {anchored.map((c) => (
                <th key={c.id} scope="col">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.chapters.map((ch, i) => (
              <tr key={ch.id} className={ch.id === currentChapterId ? "current" : undefined}>
                <th scope="row">
                  <button type="button" className="link" onClick={() => onGoTo(ch.id)}>
                    {chapterLabel(i, ch.title)}
                  </button>
                </th>
                <td>
                  {editing === ch.id ? (
                    <TimeMarkEditor
                      chapterId={ch.id}
                      mark={ch.mark}
                      calendar={view.calendar}
                      onCancel={() => setEditing(null)}
                      onSaved={async () => {
                        // Only this chapter's editor: the author may have opened the next one
                        // while this one was saving (it used to close it).
                        setEditing((e) => (e === ch.id ? null : e));
                        await onChanged();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`link time-label${ch.estimated ? " estimated" : ""}`}
                      onClick={() => setEditing(ch.id)}
                      aria-label={`Tiempo de ${chapterLabel(i, ch.title)}: ${ch.time}${ch.estimated ? " (heredado)" : ""}. Cambiar`}
                    >
                      {ch.mark && "after" in ch.mark.when ? `${afterLabel(ch.mark.when.after)} · ` : ""}
                      {ch.time}
                      {ch.mark?.flashback ? " · retrospectiva" : ""}
                      {ch.mark?.label ? ` · ${ch.mark.label}` : ""}
                    </button>
                  )}
                </td>
                {anchored.map((c) => (
                  <td key={c.id} className={warned.has(`${ch.id}:${c.id}`) ? "warned" : undefined}>
                    {c.ages[i] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!anchored.length && (
        <p className="muted small">Ningún personaje tiene todavía su nacimiento o su edad en la ficha: ahí se define.</p>
      )}

      <section className="chrono-warnings" aria-label="Advertencias de tiempo">
        <h3>{open.length ? (open.length === 1 ? "1 advertencia" : `${open.length} advertencias`) : "Sin advertencias"}</h3>
        <ul>
          {open.map((w) => (
            <li key={w.key} className={`warning ${w.level}`}>
              <span className="warning-level">{w.level === "error" ? "Probable error" : "Revisar"}</span> {w.message}
              {w.characterIds.length > 0 && <span className="muted small"> · {w.characterIds.map((id) => names.get(id)).join(", ")}</span>}{" "}
              <button type="button" className="link small" onClick={() => patch({ dismiss: { key: w.key, fingerprint: w.fingerprint } })}>
                Es intencionado
              </button>
            </li>
          ))}
        </ul>
        {dismissed.length > 0 && (
          <>
            <button type="button" className="link small" onClick={() => setShowDismissed(!showDismissed)}>
              {showDismissed ? "Ocultar" : "Ver"} descartadas ({dismissed.length})
            </button>
            {showDismissed && (
              <ul>
                {dismissed.map((w) => (
                  <li key={w.key} className="warning muted">
                    {w.message}{" "}
                    <button type="button" className="link small" onClick={() => patch({ restore: w.key })}>
                      Volver a avisar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </Modal>
  );
}

function afterLabel(iv: Interval) {
  const parts = [
    iv.years ? `${iv.years} ${iv.years === 1 ? "año" : "años"}` : "",
    iv.months ? `${iv.months} ${iv.months === 1 ? "mes" : "meses"}` : "",
    iv.days ? `${iv.days} ${iv.days === 1 ? "día" : "días"}` : "",
  ].filter(Boolean);
  return `${parts.join(" y ")} después`;
}
