"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client";
import { COMPANIONS, pickCompanion, type Companion } from "@/lib/companions";
import { appendImages } from "@/lib/manuscript";
import type { ProviderId } from "@/lib/types";

type Turn = { speaker: "autor" | "compañero"; text: string; companion?: string };

type Props = {
  novelId: string;
  chapterId: string;
  genre?: string;
  providers: ProviderId[];
  defaultProvider: ProviderId | null;
  onClose(): void;
  /** The author sends a reply to the Asistente, edited if needed; `write` asks for the scene now. */
  onSendToAssistant(text: string, write: boolean): void;
  /** Replaces the chapter body with a reviewed text, after the author's click. Resolves to success. */
  onApplyChapter(text: string): Promise<boolean>;
};

/** Pedidos de un clic. El que necesita un nombre pide el personaje o el tema antes de enviar. */
const ACTIONS: { id: string; label: string; request: string; ask?: string }[] = [
  { id: "leer", label: "Leamos juntos", request: "Lee conmigo el capítulo abierto. Dime en dos o tres frases qué te llama la atención y hazme una pregunta. Nada de listas." },
  { id: "personajes", label: "Repasar personajes", request: "Repasa los personajes que ya conoces. Di en pocas líneas en qué punto está cada uno en este capítulo y qué le falta resolver." },
  { id: "nuevo", label: "Personaje nuevo", request: "Propón un solo personaje nuevo que encaje en esta novela: nombre, qué quiere, qué esconde y qué papel cumpliría en lo que sigue.", ask: "Rol o tema (opcional)" },
  { id: "cerrar", label: "Terminé el capítulo", request: "Terminé este capítulo. Dime en tres frases qué podemos hacer en el siguiente con lo que ya pasó, y pregúntame por dónde quiero ir. Nada de listas." },
];

export default function CompanionPanel(props: Props) {
  const initial = pickCompanion(props.genre);
  const [companionId, setCompanionId] = useState<Companion["id"]>(initial.id);
  const [provider, setProvider] = useState<ProviderId | null>(props.defaultProvider ?? props.providers[0] ?? null);
  const [history, setHistory] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [extra, setExtra] = useState("");
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState<{ proposal: string; missing: string[]; changes: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<{ text: string; write: boolean } | null>(null);
  // Esc cierra el diálogo de envío si está abierto; si no, cierra el panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sending) setSending(null);
      else props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, props]);
  const confirmSend = () => {
    if (!sending?.text.trim()) return;
    props.onSendToAssistant(sending.text.trim(), sending.write);
    setSending(null);
  };
  const companion = COMPANIONS.find((c) => c.id === companionId) ?? initial;

  /** Envía un mensaje con los turnos recientes; el historial se acota en la ruta. */
  const send = async (label: string, request: string) => {
    if (busy || !provider || !request.trim()) return;
    setBusy(true); setError("");
    const recent = history.slice(-6).map((t) => ({ speaker: t.speaker, text: t.text }));
    try {
      const result = await api<{ text: string }>("/api/companion", {
        method: "POST",
        body: JSON.stringify({ novelId: props.novelId, chapterId: props.chapterId, companionId, provider, request, history: recent }),
      });
      setHistory((h) => [...h, { speaker: "autor", text: label }, { speaker: "compañero", text: result.text, companion: companion.name }]);
      setExtra("");
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "No se pudo responder");
    } finally {
      setBusy(false);
    }
  };
  const ask = (action: (typeof ACTIONS)[number]) => {
    const request = action.ask && extra.trim() ? `${action.request} Sobre: ${extra.trim()}.` : action.request;
    void send(action.label, request);
  };
  /** Revisión del capítulo entero, con lo que el autor cuenta en la caja. Nada se aplica aquí. */
  const reviewChapter = async () => {
    if (busy || !provider) return;
    const notes = draft.trim();
    setBusy(true); setError(""); setReview(null);
    try {
      const result = await api<{ proposal: string; missing: string[]; changes: string }>("/api/companion", {
        method: "POST",
        body: JSON.stringify({ novelId: props.novelId, chapterId: props.chapterId, companionId, provider, task: "revisar", request: notes }),
      });
      setReview({ proposal: result.proposal, missing: result.missing, changes: result.changes });
      setDraft("");
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "No se pudo revisar el capítulo");
    } finally {
      setBusy(false);
    }
  };
  const applyReview = async () => {
    if (!review || applying) return;
    setApplying(true); setError("");
    const text = review.missing.length ? appendImages(review.proposal, review.missing) : review.proposal;
    try {
      const ok = await props.onApplyChapter(text);
      if (ok) {
        setReview(null);
        setHistory((h) => [...h, { speaker: "compañero", text: "Revisión aplicada al capítulo. Antes quedó una copia en el historial.", companion: companion.name }]);
      } else setError("No se pudo aplicar la revisión. Tu capítulo no cambió.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo aplicar la revisión. Tu capítulo no cambió.");
    } finally {
      setApplying(false);
    }
  };
  const chat = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text, text);
  };

  const avatar = (id: string, name: string) =>
    broken[id] ? (
      <span className="companion-initial" aria-hidden="true">{name.charAt(0)}</span>
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/companions/${id}.png`} alt="" onError={() => setBroken((b) => ({ ...b, [id]: true }))} />
    );

  return (
    <aside className="companion-panel" aria-label="Compañero de lectura">
      <header className="companion-head">
        <div className="companion-avatar">{avatar(companion.id, companion.name)}</div>
        <select value={companionId} onChange={(e) => setCompanionId(e.target.value)} aria-label="Compañero">
          {COMPANIONS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {props.providers.length > 1 && (
          <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value as ProviderId)} aria-label="Proveedor">
            {props.providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <button className="link" onClick={() => { setHistory([]); setError(""); setSending(null); }} disabled={busy || history.length === 0} title="Borra la conversación en pantalla y empieza de cero">Nueva conversación</button>
        <button className="link companion-x" onClick={props.onClose} aria-label="Cerrar compañero" title="Cerrar (Esc)">×</button>
      </header>

      <div className="companion-actions">
        {ACTIONS.map((a) => (
          <button key={a.id} className="link" disabled={busy || !provider} onClick={() => ask(a)}>{a.label}</button>
        ))}
        <button className="link" disabled={busy || !provider} onClick={() => void reviewChapter()} title="Revisa el capítulo entero con lo que le cuentes en la caja. Antes de cambiar algo, te muestra la propuesta.">Revisar capítulo entero</button>
      </div>
      <input
        className="companion-extra"
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder="Rol o tema para «Personaje nuevo» (opcional)"
        maxLength={200}
      />

      {review && (
        <div className="companion-review" role="dialog" aria-modal="false" aria-label="Revisión propuesta">
          <p><strong>Propuesta de revisión</strong></p>
          {review.changes && <p className="companion-hint">{review.changes}</p>}
          {review.missing.length > 0 && (
            <p className="companion-error">La propuesta quitó {review.missing.length === 1 ? "una imagen" : `${review.missing.length} imágenes`}. Si aplicas, las añado al final del capítulo.</p>
          )}
          <div className="companion-review-text">{review.proposal}</div>
          <div className="companion-send-actions">
            <button className="link" onClick={() => void applyReview()} disabled={applying}>
              {review.missing.length ? "Reemplazar y añadir imágenes al final" : "Reemplazar el capítulo"}
            </button>
            <button className="link" onClick={() => setReview(null)} disabled={applying}>Descartar</button>
          </div>
          <p className="companion-hint">Se guarda una copia del capítulo antes de reemplazarlo.</p>
        </div>
      )}
      {sending && (
        <div className="companion-send" role="dialog" aria-modal="true" aria-label="Enviar al asistente">
          <p><strong>Enviar al asistente</strong></p>
          <p className="companion-hint">Revisa el texto que va al Asistente. Si la respuesta trae varios caminos, deja sólo el que quieras.</p>
          <textarea value={sending.text} onChange={(e) => setSending({ ...sending, text: e.target.value })} rows={8} maxLength={10000} aria-label="Texto para el Asistente" />
          <label className="companion-choice">
            <input type="radio" name="send-mode" checked={!sending.write} onChange={() => setSending({ ...sending, write: false })} />
            Dejarlo como argumento de escena, sin escribir
          </label>
          <label className="companion-choice">
            <input type="radio" name="send-mode" checked={sending.write} onChange={() => setSending({ ...sending, write: true })} />
            Escribir el capítulo según esta idea ahora (usa el proveedor; no entra a la novela hasta que lo aceptes)
          </label>
          <div className="companion-send-actions">
            <button className="link" onClick={confirmSend} disabled={!sending.text.trim()}>Enviar</button>
            <button className="link" onClick={() => setSending(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="companion-chat">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chat(); } }}
          placeholder={`Escríbele a ${companion.name}… (Enter envía, Shift+Enter salta línea)`}
          rows={2}
          maxLength={2000}
          aria-label={`Mensaje para ${companion.name}`}
          disabled={!provider}
        />
        <button className="link" onClick={chat} disabled={busy || !draft.trim() || !provider}>Enviar</button>
      </div>

      <div className="companion-log" aria-live="polite">
        {history.length === 0 && <p className="companion-hint">Lee el argumento y el capítulo abierto. Nada de lo que responde se escribe en tu novela.</p>}
        {history.map((t, i) => (
          <p key={i} className={t.speaker === "autor" ? "companion-say-author" : "companion-say"}>
            {t.speaker === "compañero" && <strong>{t.companion}: </strong>}
            {t.text}
            {t.speaker === "compañero" && (
              <button className="link companion-send-btn" onClick={() => setSending({ text: t.text, write: false })}>Enviar al asistente</button>
            )}
          </p>
        ))}
        {busy && <p className="companion-hint">{companion.name} está leyendo…</p>}
        {error && <p className="companion-error" role="alert">{error}</p>}
      </div>
    </aside>
  );
}
