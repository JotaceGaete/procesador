"use client";

import { useEffect, useRef, useState } from "react";
import type { Character, CharacterImage, ManuscriptImage } from "@/lib/types";
import { MAX_IMAGES_PER_CHARACTER, ORIGINAL_TYPES, assetUrl } from "@/lib/images";
import { api } from "@/lib/client";
import { addCharacterImage, rejectReason, replaceImage, type UploadStage } from "@/lib/upload";

/**
 * Visual memory of a character (docs/personajes-galeria.md): reference images,
 * not part of the book. Every action here is saved at once, independently of
 * the character sheet's Guardar button. Cards and grids use thumbnails only;
 * the viewer uses the display version; the original is only downloaded on request.
 */

type OnImages = (characterId: string, images: CharacterImage[]) => void;
/** After a replacement: the novel's gallery and manuscript images (with "all" uses, both can change). */
type OnAllImages = (all: { images: CharacterImage[]; manuscriptImages: ManuscriptImage[] }) => void;

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toLocaleUpperCase("es");
}

/** A stable, quiet hue per name, so each character keeps its colour. */
function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

const primaryOf = (images: CharacterImage[]) => images.find((i) => i.is_primary) ?? null;

/** The main image's thumbnail, or the initials when there is none. */
export function CharacterAvatar({ name, image, className = "" }: { name: string; image: CharacterImage | null; className?: string }) {
  if (image) {
    return (
      <span className={`avatar ${className}`}>
        <img
          src={assetUrl(image.asset, "thumb")}
          alt={image.caption || name}
          width={image.asset.width}
          height={image.asset.height}
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }
  return (
    <span className={`avatar initials ${className}`} style={{ "--h": hue(name) } as React.CSSProperties} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** One card in the Personajes overview. */
export function CharacterCard({ character, images, onOpen }: { character: Character; images: CharacterImage[]; onOpen(): void }) {
  const alias = character.aliases.split(",")[0]?.trim();
  const facts = [character.age.trim(), alias ? `«${alias}»` : ""].filter(Boolean).join(" · ");
  return (
    <button type="button" className="character-card" onClick={onOpen}>
      <CharacterAvatar name={character.name} image={primaryOf(images)} />
      <span className="card-text">
        <span className="card-name">{character.name}</span>
        {character.role && <span className="card-role">{character.role}</span>}
        {facts && <span className="card-facts">{facts}</span>}
        {images.length > 0 && (
          <span className="card-count">
            {images.length} {images.length === 1 ? "imagen" : "imágenes"}
          </span>
        )}
      </span>
    </button>
  );
}

/** Shared by the portrait, the gallery and the viewer: uploads, one at a time, with progress. */
function useUploads(novelId: string, characterId: string, count: number, onImages: OnImages) {
  const [queue, setQueue] = useState<{ id: number; name: string; stage: UploadStage | "error"; fraction?: number; error?: string }[]>([]);
  const [notice, setNotice] = useState("");
  const [info, setInfo] = useState("");
  const seq = useRef(0);
  const chain = useRef(Promise.resolve());
  const room = useRef(MAX_IMAGES_PER_CHARACTER - count);
  room.current = MAX_IMAGES_PER_CHARACTER - count - queue.filter((u) => u.stage !== "error").length;

  function add(files: FileList | File[]) {
    setNotice("");
    setInfo("");
    const list = [...files];
    const accepted: File[] = [];
    const problems: string[] = [];
    for (const f of list) {
      const reason = rejectReason(f);
      if (reason) problems.push(`${f.name}: ${reason}`);
      else accepted.push(f);
    }
    const allowed = accepted.slice(0, Math.max(0, room.current));
    if (allowed.length < accepted.length) problems.push(`Límite de ${MAX_IMAGES_PER_CHARACTER} imágenes por personaje.`);
    if (problems.length) setNotice(problems.join(" "));
    for (const file of allowed) {
      const id = ++seq.current;
      setQueue((q) => [...q, { id, name: file.name, stage: "preparing" }]);
      const update = (patch: object) => setQueue((q) => q.map((u) => (u.id === id ? { ...u, ...patch } : u)));
      chain.current = chain.current.then(async () => {
        try {
          const r = await addCharacterImage({
            novelId,
            characterId,
            file,
            onProgress: (stage, fraction) => update({ stage, fraction }),
          });
          if (r.images) onImages(characterId, r.images);
          if (r.notice) setInfo(r.notice);
          setQueue((q) => q.filter((u) => u.id !== id));
        } catch (e) {
          update({ stage: "error", error: (e as Error).message });
        }
      });
    }
  }
  const dismiss = (id: number) => setQueue((q) => q.filter((u) => u.id !== id));
  return { queue, notice, info, add, dismiss, full: room.current <= 0 };
}

const ACCEPT = ORIGINAL_TYPES.join(",");

const STAGE_LABEL: Record<UploadStage, string> = {
  preparing: "Preparando…",
  uploading: "Subiendo",
  processing: "Guardando…",
};

/**
 * The character sheet's visual part: the main image on top, then `children`
 * (the sheet's first section), then the Galería section. Rendered only for saved
 * characters (images need a character id).
 */
export function CharacterVisual({
  novelId,
  character,
  images,
  allImages,
  manuscriptImages,
  names,
  onImages,
  onAllImages,
  onInsertInChapter,
  children,
}: {
  novelId: string;
  character: Pick<Character, "id" | "name" | "role">;
  images: CharacterImage[];
  /** Every gallery and manuscript image of the novel: to know where else a file is used. */
  allImages: CharacterImage[];
  manuscriptImages: ManuscriptImage[];
  names: Map<string, string>;
  onImages: OnImages;
  onAllImages: OnAllImages;
  /** Inserts this image's file in the open chapter, at the cursor (same file, not copied). */
  onInsertInChapter?: (assetId: string) => void;
  children?: React.ReactNode;
}) {
  const uploads = useUploads(novelId, character.id, images.length, onImages);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const primary = primaryOf(images);
  const pick = () => input.current?.click();

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) uploads.add(e.dataTransfer.files);
    },
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        aria-label="Añadir imágenes"
        onChange={(e) => {
          if (e.target.files?.length) uploads.add(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="portrait-row">
        <button
          type="button"
          className={`portrait${dragging ? " dragging" : ""}`}
          onClick={() => (primary ? setViewing(primary.id) : pick())}
          aria-label={primary ? "Ver imagen principal" : "Añadir imagen principal"}
          {...dropProps}
        >
          <CharacterAvatar name={character.name} image={primary} className="large" />
          {!primary && <span className="portrait-hint">Añadir imagen</span>}
        </button>
        <div className="portrait-text">
          <span className="portrait-name">{character.name}</span>
          {character.role && <span className="muted">{character.role}</span>}
          {primary?.stage_label && <span className="muted small">{primary.stage_label}</span>}
        </div>
      </div>

      {children}

      <details className="group gallery" open>
        <summary>
          Galería <span className="muted small">{images.length || ""}</span>
        </summary>
        <div className={`dropzone${dragging ? " dragging" : ""}`} {...dropProps} data-testid="gallery-dropzone">
          {images.length > 0 ? (
            <ul className="thumbs" aria-label="Imágenes de la galería">
              {images.map((img) => (
                <li key={img.id}>
                  <button type="button" className="thumb" onClick={() => setViewing(img.id)} aria-label={img.caption || "Ver imagen"}>
                    <img
                      src={assetUrl(img.asset, "thumb")}
                      alt={img.caption || ""}
                      width={img.asset.width}
                      height={img.asset.height}
                      loading="lazy"
                      decoding="async"
                    />
                    {img.is_primary && (
                      <span className="badge" title="Imagen principal">
                        ★<span className="sr-only"> Principal</span>
                      </span>
                    )}
                  </button>
                  {(img.caption || img.stage_label) && (
                    <span className="thumb-caption">{[img.stage_label, img.caption].filter(Boolean).join(" · ")}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small gallery-empty">Aspecto, vestuario, peinados, edades o etapas: referencias visuales para escribir.</p>
          )}
          {uploads.queue.length > 0 && (
            <ul className="uploads" aria-live="polite">
              {uploads.queue.map((u) => (
                <li key={u.id} className={u.stage === "error" ? "error" : undefined}>
                  <span className="upload-name">{u.name}</span>
                  {u.stage === "error" ? (
                    <>
                      <span>{u.error}</span>
                      <button type="button" className="link" onClick={() => uploads.dismiss(u.id)}>
                        Quitar
                      </button>
                    </>
                  ) : (
                    <span className="muted">
                      {STAGE_LABEL[u.stage]}
                      {u.stage === "uploading" && u.fraction !== undefined ? ` ${Math.round(u.fraction * 100)} %` : ""}
                    </span>
                  )}
                  {u.stage === "uploading" && <progress max={1} value={u.fraction ?? 0} />}
                </li>
              ))}
            </ul>
          )}
          <div className="gallery-actions">
            <button type="button" className="btn" onClick={pick} disabled={uploads.full}>
              Añadir imágenes
            </button>
            <span className="muted small">
              {uploads.full
                ? `Límite de ${MAX_IMAGES_PER_CHARACTER} imágenes alcanzado.`
                : "o arrástralas aquí. Se guardan al momento, sin pulsar Guardar."}
            </span>
          </div>
          {uploads.notice && <p className="error small">{uploads.notice}</p>}
          {uploads.info && <p className="muted small gallery-info">{uploads.info}</p>}
        </div>
      </details>

      {viewing && images.some((i) => i.id === viewing) && (
        <Viewer
          novelId={novelId}
          images={images}
          id={viewing}
          name={character.name}
          otherUses={(() => {
            const current = images.find((i) => i.id === viewing)!;
            return [
              ...allImages
                .filter((i) => i.asset_id === current.asset_id && i.id !== current.id)
                .map((i) => (i.character_id === character.id ? `${character.name} (otra imagen)` : (names.get(i.character_id) ?? ""))),
              ...manuscriptImages.filter((m) => m.asset_id === current.asset_id).map(() => "el manuscrito"),
            ];
          })()}
          onInsertInChapter={onInsertInChapter}
          onMove={setViewing}
          onClose={() => setViewing(null)}
          onImages={(list) => onImages(character.id, list)}
          onAllImages={onAllImages}
        />
      )}
    </>
  );
}

/** Full-screen viewer: display version, caption and stage label, and the gallery's actions. */
function Viewer({
  novelId,
  images,
  id,
  name,
  otherUses,
  onMove,
  onClose,
  onImages,
  onAllImages,
  onInsertInChapter,
}: {
  novelId: string;
  images: CharacterImage[];
  id: string;
  name: string;
  /** Where else this image's file is used (other characters, or another image of this one). */
  otherUses: string[];
  onMove(id: string): void;
  onClose(): void;
  onImages(images: CharacterImage[]): void;
  onAllImages: OnAllImages;
  onInsertInChapter?: (assetId: string) => void;
}) {
  const index = images.findIndex((i) => i.id === id);
  const img = images[index];
  const [caption, setCaption] = useState(img.caption);
  const [stage, setStage] = useState(img.stage_label);
  const [busy, setBusy] = useState(false);
  // Status line under the actions: progress and confirmations, or an error.
  const [status, setStatus] = useState({ text: "", error: false });
  const setState = (text: string, error = false) => setStatus({ text, error });
  const closeRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<"use" | "all">("use");
  const [choosing, setChoosing] = useState(false);

  // Another image: its own texts, and no status carried over. (Not on every gallery
  // update, or "Guardado" would vanish the moment the save comes back.)
  useEffect(() => {
    setCaption(img.caption);
    setStage(img.stage_label);
    setState("");
    setChoosing(false);
  }, [img.id]);

  // Arrows and Escape belong to the viewer while it is open (Escape must not close the sheet behind).
  const nav = useRef({ prev: () => {}, next: () => {}, close: onClose });
  nav.current = {
    prev: () => index > 0 && onMove(images[index - 1].id),
    next: () => index < images.length - 1 && onMove(images[index + 1].id),
    close: onClose,
  };
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea");
      if (e.key === "Escape") nav.current.close();
      else if (e.key === "ArrowLeft" && !typing) nav.current.prev();
      else if (e.key === "ArrowRight" && !typing) nav.current.next();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  async function run(fn: () => Promise<CharacterImage[]>, done?: (list: CharacterImage[]) => void) {
    setBusy(true);
    setState("");
    try {
      const list = await fn();
      onImages(list);
      done?.(list);
    } catch (e) {
      setState((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const saveText = () => {
    if (caption.trim() === img.caption && stage.trim() === img.stage_label) return;
    run(
      () => api(`/api/character-images/${img.id}`, { method: "PATCH", json: { caption, stage_label: stage } }),
      () => setState("Guardado"),
    );
  };
  const move = (delta: number) => {
    const ids = images.map((i) => i.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved);
    run(() => api(`/api/characters/${img.character_id}/images`, { method: "PUT", json: { ids } }));
  };
  /**
   * Replace: a file used only here is simply replaced. A shared one asks first:
   * this image only (the others keep the current file) or every use.
   */
  const startReplace = () => (otherUses.length ? setChoosing(true) : pickReplacement("use"));
  const pickReplacement = (scope: "use" | "all") => {
    scopeRef.current = scope;
    setChoosing(false);
    fileRef.current?.click();
  };
  const replace = async (file: File) => {
    setBusy(true);
    setState("Preparando…");
    try {
      const r = await replaceImage({
        novelId,
        target: "character",
        imageId: img.id,
        scope: scopeRef.current,
        file,
        onProgress: (stage, fraction) =>
          setState(stage === "uploading" ? `Subiendo ${Math.round((fraction ?? 0) * 100)} %` : stage === "processing" ? "Guardando…" : "Preparando…"),
      });
      onAllImages(r);
      setState(r.notice || "Imagen reemplazada");
    } catch (e) {
      setState((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!confirm("¿Eliminar esta imagen de la galería? No se puede deshacer.")) return;
    const next = images[index + 1] ?? images[index - 1];
    run(
      () => api(`/api/character-images/${img.id}`, { method: "DELETE" }),
      (list) => (next && list.some((i) => i.id === next.id) ? onMove(next.id) : onClose()),
    );
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Imagen de ${name}`}>
      <header className="viewer-bar">
        <span className="viewer-count">
          {index + 1} / {images.length}
        </span>
        <span className="spacer" />
        <button ref={closeRef} type="button" className="link" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <div className="viewer-stage">
        <button type="button" className="viewer-nav prev" onClick={nav.current.prev} disabled={index === 0} aria-label="Imagen anterior">
          ‹
        </button>
        <img
          key={img.id}
          src={assetUrl(img.asset, "display")}
          alt={img.caption || name}
          width={img.asset.width}
          height={img.asset.height}
          decoding="async"
        />
        <button
          type="button"
          className="viewer-nav next"
          onClick={nav.current.next}
          disabled={index === images.length - 1}
          aria-label="Imagen siguiente"
        >
          ›
        </button>
      </div>
      <div className="viewer-panel">
        <div className="viewer-fields">
          <label>
            <span>Pie</span>
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onBlur={saveText}
              onKeyDown={blurOnEnter}
              placeholder="Vestido del baile, con el pelo corto…"
            />
          </label>
          <label>
            <span>Etapa (etiqueta)</span>
            <input
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              onBlur={saveText}
              onKeyDown={blurOnEnter}
              placeholder="1982, tras la cárcel…"
            />
          </label>
        </div>
        <div className="viewer-actions">
          {img.is_primary ? (
            <span className="primary-mark">★ Imagen principal</span>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => api(`/api/character-images/${img.id}/primary`, { method: "POST" }))}
            >
              Usar como principal
            </button>
          )}
          <button type="button" className="btn" disabled={busy || index === 0} onClick={() => move(-1)} aria-label="Mover antes">
            ← Antes
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || index === images.length - 1}
            onClick={() => move(1)}
            aria-label="Mover después"
          >
            Después →
          </button>
          <span className="spacer" />
          <button type="button" className="link" disabled={busy} onClick={startReplace}>
            Reemplazar archivo…
          </button>
          {onInsertInChapter && (
            <button type="button" className="link" onClick={() => onInsertInChapter(img.asset_id)}>
              Insertar en el capítulo
            </button>
          )}
          <a className="link" href={assetUrl(img.asset, "original")}>
            Descargar original
          </a>
          <button type="button" className="link danger" disabled={busy} onClick={remove}>
            Eliminar
          </button>
        </div>
        {choosing && (
          <div className="replace-choice" role="group" aria-label="Qué reemplazar">
            <p className="small">
              Este archivo también se usa en: {otherUses.join(", ")}. ¿Dónde quieres reemplazarlo?
            </p>
            <div className="viewer-actions">
              <button type="button" className="btn" onClick={() => pickReplacement("use")}>
                Sólo en esta imagen
              </button>
              <button type="button" className="btn" onClick={() => pickReplacement("all")}>
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
            if (file) replace(file);
          }}
        />
        <p className="muted small viewer-meta">
          {status.text && <span className={status.error ? "error" : "viewer-status"}>{status.text} · </span>}
          Original: {img.asset.width} × {img.asset.height} px · {formatBytes(img.asset.original_bytes)}
        </p>
      </div>
    </div>
  );
}

/** The viewer lives inside the sheet's form: Enter saves the field instead of submitting the sheet. */
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toLocaleString("es", { maximumFractionDigits: 1 })} MB`;
}
