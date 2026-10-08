"use client";

import { useState } from "react";
import { PLOT_MAX, type Guide, type GuideKey, type Novel } from "@/lib/types";
import { countWords } from "@/lib/manuscript";
import { GUIDE_SECTIONS, compileGuide } from "@/lib/guide";
import { api } from "@/lib/client";
import Modal from "./Modal";
import BuildStamp from "./BuildStamp";
import BackupButton from "./BackupButton";
import BookExport from "./BookExport";
import { cleanBook, type BookMeta } from "@/lib/book";

export type NovelTab = "novela" | "argumento" | "guia" | "libro";

/** Title, synopsis and notes, the Argumento general, the Guía Maestra (all optional, in plain writer's terms), and the book: its data and the exports. */
export default function NovelModal({
  novel,
  initialTab = "novela",
  onClose,
  onSaved,
}: {
  novel: Novel;
  initialTab?: NovelTab;
  onClose(): void;
  onSaved(n: Novel): void;
}) {
  const [tab, setTab] = useState<NovelTab>(initialTab);
  const [form, setForm] = useState({ title: novel.title, synopsis: novel.synopsis, notes: novel.notes, plot: novel.plot ?? "" });
  const [guide, setGuide] = useState<Guide>(novel.guide ?? {});
  const savedBook = cleanBook(novel.book);
  const [book, setBook] = useState<BookMeta>(savedBook);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const dirty =
    form.title !== novel.title ||
    form.synopsis !== novel.synopsis ||
    form.notes !== novel.notes ||
    form.plot !== (novel.plot ?? "") ||
    JSON.stringify(guide) !== JSON.stringify(novel.guide ?? {}) ||
    JSON.stringify(book) !== JSON.stringify(savedBook);

  const leave = () => (!dirty || confirm("Hay cambios sin guardar. ¿Descartarlos?")) && onClose();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await api<Novel>(`/api/novels/${novel.id}`, { method: "PATCH", json: { ...form, guide, book } }));
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
        <button className={tab === "argumento" ? "on" : undefined} onClick={() => setTab("argumento")}>
          Argumento general
        </button>
        <button className={tab === "guia" ? "on" : undefined} onClick={() => setTab("guia")}>
          Guía Maestra
        </button>
        <button className={tab === "libro" ? "on" : undefined} onClick={() => setTab("libro")}>
          Libro
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
            <p className="muted small field-help">
              La sinopsis y las notas son tu plan, como el Argumento general: las lee el Consejero, como intención (no como algo
              que ya ocurrió). El Asistente no las recibe, para que una escena no adelante lo que aún no debe saberse; lo que
              necesite saber de siempre va en la Memoria (personajes, relaciones, hechos) y en lo que el Consejero le envía.
            </p>
            <label>
              <span>Notas</span>
              <textarea
                rows={5}
                value={form.notes}
                placeholder="Ideas, pendientes, lo que no quieres olvidar."
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <BackupButton novelId={novel.id} />
          </>
        ) : tab === "argumento" ? (
          <>
            <p className="muted small">
              Toda la trama, de principio a fin: lo que pasa, los secretos, lo que cada uno oculta y el desenlace que tienes
              previsto. Solo lo lee el Consejero, como tu plan (no como algo ya escrito), para entender hacia dónde va la novela.
              El Asistente nunca lo recibe: una escena no puede adelantar lo que no conoce.
            </p>
            <label>
              <span>Argumento general</span>
              <textarea
                className="plot"
                rows={20}
                maxLength={PLOT_MAX}
                value={form.plot}
                placeholder={"Premisa: de qué va la novela.\n\nLo que pasa, por partes o capítulos (puedes usar títulos: ## Primera parte).\n\nSecretos y revelaciones: qué se sabe, quién y cuándo.\n\nDesenlace previsto."}
                onChange={(e) => setForm({ ...form, plot: e.target.value })}
              />
            </label>
            <p className="muted small field-help">
              {countWords(form.plot).toLocaleString("es")} palabras · {form.plot.length.toLocaleString("es")} de{" "}
              {PLOT_MAX.toLocaleString("es")} caracteres. El Consejero no lo lee entero en cada consulta: una visión general
              (el comienzo, los títulos, la primera frase de cada párrafo y el final) y, completos, los párrafos que tienen que
              ver con lo que le preguntas. Escribe el desenlace al final y separa los párrafos con una línea en blanco.
            </p>
            {!form.plot.trim() && form.synopsis.trim() && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => setForm({ ...form, plot: form.synopsis.trim() })}
                title="Copia aquí la sinopsis para desarrollarla; la sinopsis se queda como está"
              >
                Empezar desde la sinopsis
              </button>
            )}
          </>
        ) : tab === "libro" ? (
          <BookExport novelId={novel.id} title={form.title.trim() || novel.title} book={book} onChange={setBook} />
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
                Esto es lo que recibe el modelo, generado a partir de la guía (sin la sinopsis, las notas ni el Argumento
                general, que no van al Asistente). Para cambiarlo, edita los campos (o «Instrucciones libres»).
              </p>
              <pre className="compiled">
                {compileGuide({ title: form.title, guide })}
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
