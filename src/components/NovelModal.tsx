"use client";

import { useState } from "react";
import type { Guide, GuideKey, Novel } from "@/lib/types";
import { GUIDE_SECTIONS, compileGuide } from "@/lib/guide";
import { api } from "@/lib/client";
import Modal from "./Modal";
import BuildStamp from "./BuildStamp";

type Tab = "novela" | "guia";

/** Title, synopsis and notes, and the Guía Maestra (all optional, in plain writer's terms). */
export default function NovelModal({ novel, onClose, onSaved }: { novel: Novel; onClose(): void; onSaved(n: Novel): void }) {
  const [tab, setTab] = useState<Tab>("novela");
  const [form, setForm] = useState({ title: novel.title, synopsis: novel.synopsis, notes: novel.notes });
  const [guide, setGuide] = useState<Guide>(novel.guide ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dirty =
    form.title !== novel.title ||
    form.synopsis !== novel.synopsis ||
    form.notes !== novel.notes ||
    JSON.stringify(guide) !== JSON.stringify(novel.guide ?? {});

  const leave = () => (!dirty || confirm("Hay cambios sin guardar. ¿Descartarlos?")) && onClose();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await api<Novel>(`/api/novels/${novel.id}`, { method: "PATCH", json: { ...form, guide } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const setField = (key: GuideKey, value: string) => setGuide((g) => ({ ...g, [key]: value }));

  return (
    <Modal title={novel.title} onClose={leave} wide>
      <nav className="tabs" aria-label="Secciones">
        <button className={tab === "novela" ? "on" : undefined} onClick={() => setTab("novela")}>
          Novela
        </button>
        <button className={tab === "guia" ? "on" : undefined} onClick={() => setTab("guia")}>
          Guía Maestra
        </button>
      </nav>
      <form onSubmit={submit} className="form">
        {tab === "novela" ? (
          <>
            <label className="short">
              <span>Título</span>
              <input value={form.title} required onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label>
              <span>Sinopsis</span>
              <textarea
                rows={7}
                value={form.synopsis}
                placeholder="De qué va la historia y hacia dónde va."
                onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
              />
            </label>
            <label>
              <span>Notas</span>
              <textarea
                rows={5}
                value={form.notes}
                placeholder="Ideas, pendientes, lo que no quieres olvidar."
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <p className="muted small">
              Todo es opcional. Lo que escribas aquí guía cada propuesta del asistente para esta novela, con cualquier modelo.
            </p>
            {GUIDE_SECTIONS.map((section, i) => (
              <details key={section.title} open={i === 0} className="group">
                <summary>{section.title}</summary>
                {section.fields.map((f) => (
                  <label key={f.key}>
                    <span>{f.label}</span>
                    {f.rows === 1 ? (
                      <>
                        <input
                          value={guide[f.key] ?? ""}
                          placeholder={f.hint}
                          list={f.options ? `opts-${f.key}` : undefined}
                          onChange={(e) => setField(f.key, e.target.value)}
                        />
                        {f.options && (
                          <datalist id={`opts-${f.key}`}>
                            {f.options.map((o) => (
                              <option key={o} value={o} />
                            ))}
                          </datalist>
                        )}
                      </>
                    ) : (
                      <textarea
                        rows={f.rows}
                        value={guide[f.key] ?? ""}
                        placeholder={f.hint}
                        onChange={(e) => setField(f.key, e.target.value)}
                      />
                    )}
                  </label>
                ))}
              </details>
            ))}
            <details className="group advanced">
              <summary>Ver instrucciones maestras</summary>
              <p className="muted small">
                Esto es lo que recibe el modelo, generado a partir de la guía, la sinopsis y las notas. Para cambiarlo, edita los
                campos (o «Instrucciones libres»).
              </p>
              <pre className="compiled">
                {compileGuide({ title: form.title, synopsis: form.synopsis, notes: form.notes, guide })}
              </pre>
            </details>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <footer className="modal-foot">
          <BuildStamp />
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={leave}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !form.title.trim() || !dirty}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
