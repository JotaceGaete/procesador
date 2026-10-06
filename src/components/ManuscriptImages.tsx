"use client";

import { useEffect, useRef, useState } from "react";
import type { CharacterImage, ManuscriptImage } from "@/lib/types";
import { ORIGINAL_TYPES, assetUrl } from "@/lib/images";
import { MIN_PRINT_PPI, REFERENCE_TEXT_WIDTH_CM, TARGET_PRINT_PPI, imageIds, pixelsFor, printPpi, strayMarkers } from "@/lib/manuscript";
import { present } from "@/lib/presentation";
import type { UploadStage } from "@/lib/upload";
import Modal from "./Modal";

/**
 * Images of the book (docs/manuscrito-imagenes.md): the card of the image under
 * the cursor, the chapter's images panel and the reading view. The text keeps a
 * marker [[imagen:<id>]] per image; everything else lives in manuscript_images.
 */

export type Pending = Record<string, { name: string; stage: UploadStage | "error"; fraction?: number; error?: string }>;

type Fields = Partial<Pick<ManuscriptImage, "alt" | "decorative" | "caption" | "credit" | "layout" | "align" | "width_pct">>;

const ACCEPT = ORIGINAL_TYPES.join(",");
const STAGE: Record<UploadStage, string> = { preparing: "Preparando…", uploading: "Subiendo", processing: "Guardando…" };

export function pendingLabel(p: Pending[string]) {
  if (p.stage === "error") return p.error ?? "No se pudo subir";
  return `${STAGE[p.stage]}${p.stage === "uploading" && p.fraction !== undefined ? ` ${Math.round(p.fraction * 100)} %` : ""}`;
}

/** Print resolution of the original at its width in the book. Never from the interface copies. */
export function ResolutionNote({ image }: { image: ManuscriptImage }) {
  const pct = image.layout === "page" ? 100 : image.width_pct;
  const ppi = printPpi(image.asset.width, pct);
  const low = ppi < MIN_PRINT_PPI;
  return (
    <p className={`small resolution${low ? " low" : ""}`}>
      {low ? "Resolución baja para imprimir: " : ""}a {pct} % de la caja de texto ({REFERENCE_TEXT_WIDTH_CM} cm de referencia), el
      original ({image.asset.width} × {image.asset.height} px) se imprimiría a {ppi} ppp.
      {low && ` Para ${TARGET_PRINT_PPI} ppp necesitaría ${pixelsFor(pct).toLocaleString("es")} px de ancho, o un ancho menor.`}
    </p>
  );
}

/**
 * The card of the image under the cursor. Texts are saved when a field is left
 * (Enter too), choices at once; nothing here changes the chapter's text except
 * Duplicar / Quitar / Eliminar, which go through the editor (undoable).
 */
export function ImageCard({
  id,
  image,
  pending,
  otherUses,
  repeated,
  onPatch,
  onReplace,
  onDuplicate,
  onRemove,
  onDelete,
  onClose,
}: {
  id: string;
  image: ManuscriptImage | undefined;
  pending: Pending[string] | undefined;
  /** Where else its file is used ("Galería de Erika", "otra imagen del manuscrito"). */
  otherUses: string[];
  /** The same marker appears more than once in the chapter. */
  repeated: boolean;
  onPatch(fields: Fields): Promise<void>;
  onReplace(scope: "use" | "all", file: File): Promise<string>;
  onDuplicate(): Promise<void>;
  onRemove(): void;
  onDelete(): Promise<void>;
  onClose(): void;
}) {
  const [alt, setAlt] = useState(image?.alt ?? "");
  const [caption, setCaption] = useState(image?.caption ?? "");
  const [credit, setCredit] = useState(image?.credit ?? "");
  // Choices show at once and save in the background (back to the saved value if that fails).
  const [choice, setChoice] = useState({
    decorative: image?.decorative ?? false,
    layout: image?.layout ?? "inline",
    align: image?.align ?? "center",
    width_pct: image?.width_pct ?? 100,
  });
  const [status, setStatus] = useState({ text: "", error: false });
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const scope = useRef<"use" | "all">("use");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAlt(image?.alt ?? "");
    setCaption(image?.caption ?? "");
    setCredit(image?.credit ?? "");
    setChoice({
      decorative: image?.decorative ?? false,
      layout: image?.layout ?? "inline",
      align: image?.align ?? "center",
      width_pct: image?.width_pct ?? 100,
    });
    setStatus({ text: "", error: false });
    setChoosing(false);
    // Only when another image is shown: a save or a replacement of this one keeps its confirmation.
  }, [id]);

  async function run(fn: () => Promise<unknown>, done = "Guardado") {
    setBusy(true);
    setStatus({ text: "", error: false });
    try {
      const r = await fn();
      setStatus({ text: typeof r === "string" && r ? r : done, error: false });
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const choose = (fields: Partial<typeof choice>) => {
    const previous = choice;
    setChoice({ ...choice, ...fields });
    run(async () => {
      try {
        await onPatch(fields);
      } catch (e) {
        setChoice(previous);
        throw e;
      }
    });
  };
  const saveText = () => {
    if (!image) return;
    const fields: Fields = {};
    if (alt.trim() !== image.alt) fields.alt = alt;
    if (caption.trim() !== image.caption) fields.caption = caption;
    if (credit.trim() !== image.credit) fields.credit = credit;
    if (Object.keys(fields).length) run(() => onPatch(fields));
  };
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  const pick = (s: "use" | "all") => {
    scope.current = s;
    setChoosing(false);
    fileRef.current?.click();
  };

  if (!image) {
    return (
      <aside className="image-card" aria-label="Imagen del capítulo">
        <header>
          <span className="image-card-title">Imagen</span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Cerrar
          </button>
        </header>
        {pending ? (
          <p className={pending.stage === "error" ? "error small" : "muted small"}>
            {pending.name}: {pendingLabel(pending)}
          </p>
        ) : (
          <p className="error small">Imagen no encontrada: este marcador no corresponde a ninguna imagen de la novela.</p>
        )}
        {(!pending || pending.stage === "error") && (
          <button type="button" className="btn" onClick={onRemove}>
            Quitar el marcador
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside className="image-card" aria-label="Imagen del capítulo">
      <header>
        <span className="image-card-title">Imagen del capítulo</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <div className="image-card-body">
        <img className="image-card-thumb" src={assetUrl(image.asset, "thumb")} alt="" width={image.asset.width} height={image.asset.height} />
        <div className="image-card-fields">
          <label>
            <span>Texto alternativo {choice.decorative ? "(no necesario: decorativa)" : ""}</span>
            <input
              value={alt}
              disabled={choice.decorative}
              onChange={(e) => setAlt(e.target.value)}
              onBlur={saveText}
              onKeyDown={enter}
              placeholder="Qué muestra la imagen, para quien no la ve"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={choice.decorative}
              onChange={(e) => choose({ decorative: e.target.checked })}
            />
            Decorativa (sin contenido informativo)
          </label>
          <label>
            <span>Pie</span>
            <input value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={saveText} onKeyDown={enter} placeholder="Texto bajo la imagen en el libro" />
          </label>
          <label>
            <span>Crédito</span>
            <input value={credit} onChange={(e) => setCredit(e.target.value)} onBlur={saveText} onKeyDown={enter} placeholder="Archivo Nacional, 1972" />
          </label>
          <div className="image-card-row">
            <label>
              <span>Disposición</span>
              <select value={choice.layout} onChange={(e) => choose({ layout: e.target.value as "inline" | "page" })}>
                <option value="inline">En el texto</option>
                <option value="page">Página propia</option>
              </select>
            </label>
            <label>
              <span>Alineación</span>
              <select
                value={choice.align}
                disabled={choice.layout === "page"}
                onChange={(e) => choose({ align: e.target.value as ManuscriptImage["align"] })}
              >
                <option value="center">Centrada</option>
                <option value="left">Izquierda</option>
                <option value="right">Derecha</option>
              </select>
            </label>
            <label>
              <span>Ancho</span>
              <select
                value={choice.width_pct}
                disabled={choice.layout === "page"}
                onChange={(e) => choose({ width_pct: Number(e.target.value) as ManuscriptImage["width_pct"] })}
              >
                {[25, 50, 75, 100].map((w) => (
                  <option key={w} value={w}>
                    {w} %
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
      <ResolutionNote image={{ ...image, ...choice }} />
      {repeated && <p className="error small">Esta imagen aparece más de una vez en el capítulo. Para otra copia independiente, usa Duplicar.</p>}
      {choosing && (
        <div className="replace-choice" role="group" aria-label="Qué reemplazar">
          <p className="small">Este archivo también se usa en: {otherUses.join(", ")}. ¿Dónde quieres reemplazarlo?</p>
          <div className="image-card-actions">
            <button type="button" className="btn" onClick={() => pick("use")}>
              Sólo en esta imagen
            </button>
            <button type="button" className="btn" onClick={() => pick("all")}>
              En todos sus usos ({otherUses.length + 1})
            </button>
            <button type="button" className="link" onClick={() => setChoosing(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label="Archivo de reemplazo"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) run(() => onReplace(scope.current, file), "Imagen reemplazada");
        }}
      />
      <div className="image-card-actions">
        <button type="button" className="link" disabled={busy} onClick={() => (otherUses.length ? setChoosing(true) : pick("use"))}>
          Reemplazar archivo…
        </button>
        <a className="link" href={assetUrl(image.asset, "original")}>
          Descargar original
        </a>
        <button type="button" className="link" disabled={busy} onClick={() => run(onDuplicate, "Duplicada")}>
          Duplicar
        </button>
        <span className="spacer" />
        <button type="button" className="link" onClick={onRemove} title="Sale del texto y queda sin colocar; Ctrl/⌘+Z la devuelve">
          Quitar del capítulo
        </button>
        <button
          type="button"
          className="link danger"
          disabled={busy}
          onClick={() => confirm("¿Eliminar esta imagen del libro? Se quitará del capítulo. No se puede deshacer.") && run(onDelete)}
        >
          Eliminar
        </button>
      </div>
      {status.text && <p className={`small ${status.error ? "error" : "muted"}`}>{status.text}</p>}
    </aside>
  );
}

/**
 * The chapter's images, in order; the novel's images not placed anywhere; and
 * images from the characters' galleries, insertable without copying the file.
 */
export function ChapterImagesModal({
  text,
  chapterId,
  images,
  gallery,
  names,
  pending,
  onGo,
  onInsertExisting,
  onInsertFromAsset,
  onDelete,
  onFiles,
  onClose,
}: {
  text: string;
  chapterId: string;
  images: ManuscriptImage[];
  gallery: CharacterImage[];
  names: Map<string, string>;
  pending: Pending;
  onGo(id: string): void;
  onInsertExisting(id: string): void;
  onInsertFromAsset(assetId: string): void;
  onDelete(id: string): void;
  onFiles(files: File[]): void;
  onClose(): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [showGallery, setShowGallery] = useState(false);
  const byId = new Map(images.map((i) => [i.id, i]));
  const here = [...new Set(imageIds(text))];
  const unplaced = images.filter((i) => !here.includes(i.id) && (i.chapter_id === null || i.chapter_id === chapterId));
  const stray = strayMarkers(text);
  const label = (i: ManuscriptImage) => i.caption || i.alt || i.asset.file_name || "Sin pie";

  return (
    <Modal title="Imágenes del capítulo" onClose={onClose} wide>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label="Añadir imágenes al capítulo"
        onChange={(e) => {
          if (e.target.files?.length) onFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <section className="chapter-images">
        <h3>En este capítulo</h3>
        {here.length ? (
          <ul className="image-rows">
            {here.map((id) => {
              const img = byId.get(id);
              return (
                <li key={id}>
                  {img ? <img src={assetUrl(img.asset, "thumb")} alt="" /> : <span className="image-rows-missing" />}
                  <span className="image-rows-text">
                    {img ? label(img) : pending[id] ? `${pending[id].name}: ${pendingLabel(pending[id])}` : "Imagen no encontrada"}
                    {img && !img.decorative && !img.alt && <span className="muted small"> · sin texto alternativo</span>}
                  </span>
                  <button type="button" className="link" onClick={() => onGo(id)}>
                    Ir
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted small">Este capítulo no tiene imágenes. Usa Añadir, pega una imagen en el texto o arrástrala.</p>
        )}
        {stray.length > 0 && (
          <p className="error small">
            {stray.length === 1 ? "Hay un marcador" : `Hay ${stray.length} marcadores`} dentro de un párrafo: una imagen debe ir sola en su línea.
          </p>
        )}
        <div className="image-card-actions">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Añadir imágenes
          </button>
          {gallery.length > 0 && (
            <button type="button" className="btn ghost" onClick={() => setShowGallery((v) => !v)} aria-expanded={showGallery}>
              Desde las galerías
            </button>
          )}
          <span className="muted small">Se insertan en la posición del cursor.</span>
        </div>
        {showGallery && (
          <ul className="thumbs pick" aria-label="Imágenes de las galerías">
            {gallery.map((g) => (
              <li key={g.id}>
                <button type="button" className="thumb" onClick={() => onInsertFromAsset(g.asset_id)} aria-label={`Insertar ${g.caption || names.get(g.character_id) || "imagen"}`}>
                  <img src={assetUrl(g.asset, "thumb")} alt="" loading="lazy" />
                </button>
                <span className="thumb-caption">{names.get(g.character_id)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="chapter-images">
        <h3>Sin colocar</h3>
        {unplaced.length ? (
          <ul className="image-rows">
            {unplaced.map((img) => (
              <li key={img.id}>
                <img src={assetUrl(img.asset, "thumb")} alt="" />
                <span className="image-rows-text">{label(img)}</span>
                <button type="button" className="link" onClick={() => onInsertExisting(img.id)}>
                  Insertar aquí
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => confirm("¿Eliminar esta imagen del libro? No se puede deshacer.") && onDelete(img.id)}
                >
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Ninguna. Una imagen quitada del texto queda aquí, conservada, hasta que la vuelvas a insertar o la elimines.</p>
        )}
      </section>
    </Modal>
  );
}

/**
 * The chapter as it will read: the paragraphs as a printed novel sets them (src/lib/presentation.ts:
 * one per line, indented, none after the heading, a scene break or an image, no space between
 * them), its italics, scene breaks with their own space, and images with their caption, credit,
 * layout, alignment and width. Uses the interface's display copy; the book will use the original.
 */
export function ReadingView({
  text,
  heading,
  images,
  pending,
  onOpen,
}: {
  text: string;
  /** The chapter's number and own title, as the book opens it. */
  heading?: { number: string; title: string };
  images: ManuscriptImage[];
  pending: Pending;
  onOpen(id: string): void;
}) {
  const byId = new Map(images.map((i) => [i.id, i]));
  return (
    <article className="reading" aria-label="Vista de lectura">
      {heading && (
        <header className="reading-chapter">
          <div className="reading-number">{heading.number}</div>
          {heading.title && <h2>{heading.title}</h2>}
        </header>
      )}
      {present(text).map((b, n) => {
        if (b.kind === "para") {
          return (
            <p key={n} className={b.first ? "first" : undefined}>
              {b.spans.map((s, j) => (s.italic ? <em key={j}>{s.text}</em> : s.text))}
            </p>
          );
        }
        if (b.kind === "break") return <hr key={n} className="scene-break" aria-label="Cambio de escena" />;
        const img = byId.get(b.id);
        if (!img) {
          return (
            <figure key={n} className="fig missing">
              <span>{pending[b.id] ? `${pending[b.id].name}: ${pendingLabel(pending[b.id])}` : "Imagen no encontrada"}</span>
            </figure>
          );
        }
        const width = img.layout === "page" ? 100 : img.width_pct;
        return (
          <figure
            key={n}
            className={`fig layout-${img.layout} align-${img.align}`}
            style={{ width: `${width}%` }}
            data-image-id={img.id}
          >
            <button type="button" onClick={() => onOpen(img.id)} aria-label="Editar imagen">
              <img
                src={assetUrl(img.asset, "display")}
                alt={img.decorative ? "" : img.alt}
                width={img.asset.width}
                height={img.asset.height}
                loading="lazy"
                decoding="async"
              />
            </button>
            {(img.caption || img.credit) && (
              <figcaption>
                {img.caption && <span className="fig-caption">{img.caption}</span>}
                {img.credit && <span className="fig-credit">{img.credit}</span>}
              </figcaption>
            )}
          </figure>
        );
      })}
    </article>
  );
}
