"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { TRIM_SIZES, isbnProblem, type BookLayout, type BookMeta } from "@/lib/book";
import { bookModel, defaultCopyright, type ExportSource } from "@/lib/export/model";
import { docx } from "@/lib/export/docx";
import { epub } from "@/lib/export/epub";
import { exportName, prepareImages } from "@/lib/export/prepare";
import { zip } from "@/lib/zip";

type Kind = "manuscript" | "book" | "epub";

const KINDS: { kind: Kind; label: string; suffix: string; ext: string; type: string }[] = [
  { kind: "manuscript", label: "DOCX · Manuscrito", suffix: "manuscrito", ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { kind: "book", label: "DOCX · Libro", suffix: "libro", ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { kind: "epub", label: "EPUB", suffix: "libro", ext: "epub", type: "application/epub+zip" },
];

/**
 * Libro (docs/exportacion.md): the book's data (saved with the novel's «Guardar») and the
 * exports, built in the browser from the saved chapters and the original image files. The
 * checks never block an export: they say what will come out wrong, and the author decides.
 */
export default function BookExport({
  novelId,
  title,
  book,
  onChange,
}: {
  novelId: string;
  title: string;
  book: BookMeta;
  onChange(b: BookMeta): void;
}) {
  const [source, setSource] = useState<ExportSource | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = () => api<ExportSource>(`/api/novels/${novelId}/backup`);
  useEffect(() => {
    load().then(setSource, (e: Error) => setLoadError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId]);

  const withBook = (src: ExportSource): ExportSource => ({ ...src, novel: { ...src.novel, title, book } });
  const model = useMemo(() => (source ? bookModel(withBook(source)) : null), [source, book, title]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof BookMeta>(key: K, value: BookMeta[K]) => onChange({ ...book, [key]: value });
  const setLayout = <K extends keyof BookLayout>(key: K, value: BookLayout[K]) => set("layout", { ...book.layout, [key]: value });
  const setMargin = (key: keyof BookLayout["margins"], value: number) => setLayout("margins", { ...book.layout.margins, [key]: value });
  // An emptied number field stays empty while typing (saving falls back to the default).
  const num = (v: string) => (v === "" ? NaN : Number(v));
  const shown = (n: number) => (Number.isFinite(n) ? n : "");

  const covers = (source?.images.files ?? []).filter((f) => f.width > 0);
  const isbn = isbnProblem(book.isbn);

  async function download(kind: Kind) {
    const k = KINDS.find((x) => x.kind === kind)!;
    setBusy(true);
    setStatus("Preparando…");
    try {
      // The chapters as saved right now (not as they were when the tab opened).
      const fresh = await load();
      setSource(fresh);
      const m = bookModel(withBook(fresh));
      const { images, missing } = await prepareImages(m.files, (i, n) => setStatus(`Imágenes: ${i + 1} de ${n}…`));
      const entries = kind === "epub" ? epub(m, images) : docx(m, kind, images);
      const url = URL.createObjectURL(new Blob(zip(entries) as BlobPart[], { type: k.type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exportName(title, k.suffix, k.ext);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus(
        missing.length
          ? `Descargado, pero sin ${missing.length === 1 ? "esta imagen" : "estas imágenes"}, que no se pudieron leer: ${missing.join(", ")}. Vuelve a intentarlo más tarde.`
          : `Descargado: ${a.download}`,
      );
    } catch (e) {
      setStatus(`No se pudo exportar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted small">
        Todo es opcional. Estos datos van en la portadilla, la página de créditos y los metadatos del libro; se guardan con
        «Guardar» y se usan al exportar.
      </p>
      <details className="group" open>
        <summary>Portadilla y créditos</summary>
        <label>
          <span>Autor o autora</span>
          <input value={book.author} onChange={(e) => set("author", e.target.value)} placeholder="Como debe aparecer en el libro" />
        </label>
        <label>
          <span>Subtítulo</span>
          <input value={book.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
        </label>
        <label>
          <span>Editorial o sello</span>
          <input value={book.publisher} onChange={(e) => set("publisher", e.target.value)} />
        </label>
        <div className="book-row">
          <label>
            <span>ISBN</span>
            <input value={book.isbn} inputMode="numeric" onChange={(e) => set("isbn", e.target.value)} placeholder="978-…" aria-invalid={!!isbn} />
          </label>
          <label>
            <span>Año</span>
            <input value={book.year} inputMode="numeric" maxLength={4} onChange={(e) => set("year", e.target.value)} />
          </label>
          <label>
            <span>Idioma</span>
            <input value={book.language} onChange={(e) => set("language", e.target.value)} placeholder="es, es-CL…" />
          </label>
        </div>
        {isbn && <p className="error small">{isbn}</p>}
        <label>
          <span>Página de créditos</span>
          <textarea rows={4} value={book.copyright} onChange={(e) => set("copyright", e.target.value)} placeholder={defaultCopyright(title, book)} />
        </label>
        <label>
          <span>Dedicatoria</span>
          <textarea rows={2} value={book.dedication} onChange={(e) => set("dedication", e.target.value)} />
        </label>
        <label>
          <span>Epígrafe</span>
          <textarea rows={3} value={book.epigraph} onChange={(e) => set("epigraph", e.target.value)} />
        </label>
        <label>
          <span>Autor del epígrafe</span>
          <input value={book.epigraphSource} onChange={(e) => set("epigraphSource", e.target.value)} />
        </label>
        <label>
          <span>Portada (EPUB)</span>
          <select value={book.coverAssetId ?? ""} onChange={(e) => set("coverAssetId", e.target.value || null)}>
            <option value="">Sin portada</option>
            {covers.map((f) => (
              <option key={f.id} value={f.id}>
                {f.file_name || "Imagen"} ({f.width} × {f.height})
              </option>
            ))}
          </select>
        </label>
      </details>

      <details className="group">
        <summary>Página del libro impreso</summary>
        <p className="muted small">Para «DOCX · Libro». El manuscrito usa siempre el formato de envío (A4 o carta, doble espacio).</p>
        <label>
          <span>Tamaño de página</span>
          <select value={book.layout.trim} onChange={(e) => setLayout("trim", e.target.value)}>
            {TRIM_SIZES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="book-row">
          {(
            [
              ["top", "Superior"],
              ["bottom", "Inferior"],
              ["inside", "Interior (lomo)"],
              ["outside", "Exterior"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <span>Margen {label.toLowerCase()} (mm)</span>
              <input type="number" min={5} max={60} value={shown(book.layout.margins[key])} onChange={(e) => setMargin(key, num(e.target.value))} />
            </label>
          ))}
        </div>
        <div className="book-row">
          <label>
            <span>Cuerpo de letra (pt)</span>
            <input type="number" min={8} max={16} step={0.5} value={shown(book.layout.fontSize)} onChange={(e) => setLayout("fontSize", num(e.target.value))} />
          </label>
          <label>
            <span>Sangría (mm)</span>
            <input type="number" min={0} max={20} value={shown(book.layout.indent)} onChange={(e) => setLayout("indent", num(e.target.value))} />
          </label>
        </div>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={book.layout.runningHead} onChange={(e) => setLayout("runningHead", e.target.checked)} />
            Cornisa: autor en las páginas pares, título en las impares
          </label>
        </div>
      </details>

      <section className="book-export" aria-label="Exportar">
        <h3>Exportar</h3>
        {loadError && <p className="error small">{loadError}</p>}
        {model && (
          <>
            <p className="muted small">
              {model.chapters.length === 1 ? "1 capítulo" : `${model.chapters.length} capítulos`}, ≈ {model.words.toLocaleString("es")} palabras
              {model.files.length ? `, ${model.files.length === 1 ? "1 imagen" : `${model.files.length} imágenes`}` : ""}. Se exporta lo
              guardado, con los datos de esta pestaña.
            </p>
            {model.checks.length > 0 && (
              <ul className="book-checks" aria-label="Antes de exportar">
                {model.checks.map((c, i) => (
                  <li key={i} className={c.level}>
                    {c.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="book-buttons">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" className="btn" disabled={busy || !source} onClick={() => download(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <p className="muted small" role="status">
          {status ||
            "Manuscrito: para enviar a editoriales y agencias. Libro: con el tamaño de página elegido, para revisar o pasar a PDF desde Word o LibreOffice. EPUB: libro electrónico."}
        </p>
      </section>
    </>
  );
}
