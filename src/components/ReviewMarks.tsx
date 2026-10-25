"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { Selection } from "./ChapterEditor";

interface Mark {
  id: string; chapter_id: string; category: string; note: string; quote: string;
  start_offset: number; end_offset: number; status: "pending" | "resolved";
  created_at: string;
}
const categories = [
  ["incoherencia", "Incoherencia"], ["continuidad", "Continuidad"], ["repeticion", "Repetición"],
  ["estilo", "Estilo"], ["ortografia", "Ortografía"], ["otro", "Otro"],
];
export default function ReviewMarks({ novelId, chapterId, selection, flush, goTo, onClose }: {
  novelId: string; chapterId: string; selection: Selection | null;
  flush: () => Promise<boolean>;
  goTo: (chapterId: string, start: number, end: number, quote: string) => Promise<void>;
  onClose: () => void;
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [category, setCategory] = useState("incoherencia");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const load = useCallback(async () => {
    try { setMarks(await api<Mark[]>(`/api/novels/${novelId}/review-marks`)); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudieron cargar las marcas"); }
  }, [novelId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!note.trim()) { setError("Escribe qué necesitas revisar."); return; }
    setBusy(true); setError("");
    try {
      if (!(await flush())) throw new Error("Primero debes guardar el capítulo.");
      const s = selection?.text ? selection : { start: 0, end: 0, text: "" };
      await api(`/api/novels/${novelId}/review-marks`, {
        method: "POST", json: {
          chapter_id: chapterId, category, note: note.trim(), quote: s.text,
          start_offset: s.start, end_offset: s.end,
        },
      });
      setNote("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo crear la marca"); }
    finally { setBusy(false); }
  };
  const update = async (mark: Mark, status?: Mark["status"]) => {
    setBusy(true); setError("");
    try {
      await api(`/api/novels/${novelId}/review-marks/${mark.id}`, {
        method: status ? "PATCH" : "DELETE",
        ...(status ? { json: { status } } : {}),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo actualizar"); }
    finally { setBusy(false); }
  };
  return (
    <section aria-label="Marcas de revisión" style={{ padding: "1rem", borderBottom: "1px solid var(--border, #ccc)", maxHeight: "55vh", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Marcas de revisión</h2>
        <button className="link" onClick={onClose}>Cerrar</button>
      </div>
      <p className="muted">Selecciona un fragmento del editor y anota lo que quieres corregir. También puedes crear una nota general del capítulo.</p>
      {selection?.text ? <blockquote style={{ maxHeight: 90, overflow: "auto" }}>{selection.text.slice(0, 300)}{selection.text.length > 300 ? "…" : ""}</blockquote> : <p className="muted">Sin fragmento seleccionado: nota general del capítulo.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        <label>Tipo de observación
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ display: "block", width: "100%", minHeight: 44, fontSize: 16 }}>
            {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Qué debo corregir
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} rows={3} style={{ display: "block", width: "100%", fontSize: 16 }} />
        </label>
        <button disabled={busy} onClick={() => void create()}>Marcar para revisar</button>
      </div>
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      <h3>Pendientes ({marks.filter((m) => m.status === "pending").length})</h3>
      <label><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Mostrar también las resueltas</label>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {marks.filter((m) => showResolved || m.status === "pending").map((m) => (
          <article key={m.id} style={{ border: "1px solid var(--border, #ccc)", borderRadius: 8, padding: 12 }}>
            <strong>{categories.find(([value]) => value === m.category)?.[1] ?? m.category}</strong>
            <p style={{ whiteSpace: "pre-wrap" }}>{m.note}</p>
            {m.quote && <blockquote style={{ overflowWrap: "anywhere" }}>{m.quote.slice(0, 200)}</blockquote>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button disabled={busy} onClick={() => void goTo(m.chapter_id, m.start_offset, m.end_offset, m.quote)}>Ir al texto</button>
              <button disabled={busy} onClick={() => void update(m, m.status === "pending" ? "resolved" : "pending")}>{m.status === "pending" ? "Resolver" : "Reabrir"}</button>
              <button disabled={busy} onClick={() => { if (window.confirm("¿Eliminar esta marca?")) void update(m); }}>Eliminar</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
