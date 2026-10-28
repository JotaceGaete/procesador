"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/client";
import { COMPANIONS, pickCompanion, type Companion } from "@/lib/companions";
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
};

/** Pedidos de un clic. El que necesita un nombre pide el personaje o el tema antes de enviar. */
const ACTIONS: { id: string; label: string; request: string; ask?: string }[] = [
  { id: "leer", label: "Leamos juntos", request: "Lee conmigo el capítulo abierto. Comenta el último párrafo que escribí y hazme una pregunta." },
  { id: "tramas", label: "Propón tramas", request: "Propón tres caminos posibles para lo que sigue en el capítulo, con qué cambia cada uno en la historia." },
  { id: "personaje", label: "Pon a funcionar a este personaje", request: "Pon a funcionar a este personaje dentro del capítulo: qué quiere, qué teme y qué haría ahora.", ask: "Personaje (opcional)" },
  { id: "flash", label: "Flashback", request: "Propón un flashback que explique una reacción del capítulo. Dime dónde iría y qué muestra, sin escribirlo entero.", ask: "Reacción a explicar (opcional)" },
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
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<{ text: string; write: boolean } | null>(null);
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
        <button className="link" onClick={props.onClose}>Cerrar</button>
      </header>

      <div className="companion-actions">
        {ACTIONS.map((a) => (
          <button key={a.id} className="link" disabled={busy || !provider} onClick={() => ask(a)}>{a.label}</button>
        ))}
      </div>
      <input
        className="companion-extra"
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder="Personaje o tema para «Pon a funcionar» y «Flashback»"
        maxLength={200}
      />

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
