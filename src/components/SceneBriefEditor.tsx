"use client";

import { useState } from "react";
import type { SceneBrief } from "@/lib/advisor/converse";
import type { Memory } from "@/lib/types";

/** One editable list of short lines (decisions, restrictions, discards). */
function Lines({ label, items, onChange, add }: { label: string; items: string[]; onChange(items: string[]): void; add: string }) {
  return (
    <fieldset className="brief-list">
      <legend>{label}</legend>
      {items.map((d, i) => (
        <div key={i} className="brief-line">
          <input aria-label={`${label} ${i + 1}`} value={d} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" className="link small" aria-label={`Quitar: ${d}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="link small" onClick={() => onChange([...items, ""])}>
        {add}
      </button>
    </fieldset>
  );
}

/**
 * The scene order the Consejero prepared from the conversation (docs/consejero.md,
 * «Enviar al Asistente»): the author reviews it — anything misunderstood is corrected or
 * removed here — and only then takes it to the Asistente, which still writes nothing until
 * asked, and applies nothing without a click.
 */
export default function SceneBriefEditor(p: { brief: SceneBrief; memory: Memory; onSend(b: SceneBrief): void; onCancel(): void }) {
  const [b, setB] = useState<SceneBrief>(p.brief);
  const set = (patch: Partial<SceneBrief>) => setB((x) => ({ ...x, ...patch }));
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return (
    <section className="scene-brief" aria-label="Encargo para el Asistente">
      <p className="muted small">
        Encargo para el Asistente{b.source ? ` · ${b.source}` : ""}. Revísalo: el Asistente preparará una escena y no tocará el manuscrito hasta
        que tú lo decidas.
      </p>
      <label className="argument">
        <span>Qué ocurre en la escena</span>
        <textarea rows={5} value={b.argument} onChange={(e) => set({ argument: e.target.value })} />
      </label>
      <Lines label="Decisiones" items={b.decisions} onChange={(decisions) => set({ decisions })} add="+ Añadir decisión" />
      <Lines label="Restricciones" items={b.constraints} onChange={(constraints) => set({ constraints })} add="+ Añadir restricción" />
      <Lines label="Descartado" items={b.discarded} onChange={(discarded) => set({ discarded })} add="+ Añadir algo descartado" />
      {p.memory.characters.length > 0 && (
        <fieldset className="checks inline">
          <legend>Personajes</legend>
          {p.memory.characters.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={b.characterIds.includes(c.id)}
                onChange={(e) => set({ characterIds: e.target.checked ? [...b.characterIds, c.id] : b.characterIds.filter((x) => x !== c.id) })}
              />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="controls">
        {p.memory.places.length > 0 && (
          <label>
            <span>Lugar</span>
            <select value={b.placeId ?? ""} onChange={(e) => set({ placeId: e.target.value || null })}>
              <option value="">Según el argumento</option>
              {p.memory.places.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="checks inline">
          <legend>Dónde va</legend>
          <label className="check">
            <input type="radio" name="brief-target" checked={b.target === "end"} onChange={() => set({ target: "end" })} />
            Al final del capítulo
          </label>
          <label className="check">
            <input type="radio" name="brief-target" checked={b.target === "cursor"} onChange={() => set({ target: "cursor" })} />
            En el cursor
          </label>
        </fieldset>
      </div>
      <div className="actions">
        <button
          className="btn primary"
          disabled={!b.argument.trim()}
          onClick={() =>
            p.onSend({ ...b, argument: b.argument.trim(), decisions: clean(b.decisions), constraints: clean(b.constraints), discarded: clean(b.discarded) })
          }
        >
          Llevar al Asistente
        </button>
        <button className="btn ghost" onClick={p.onCancel}>
          Cancelar
        </button>
      </div>
    </section>
  );
}
