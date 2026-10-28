"use client";
import { useEffect, useRef, useState } from "react";
import type { Memory, ProviderId } from "@/lib/types";
import { api } from "@/lib/client";
import type { RoleTurn } from "@/lib/ai/roleplay";

type Props = { novelId: string; chapterId: string; memory: Memory; providers: ProviderId[]; defaultProvider: ProviderId | null; locked: boolean; onInsert(text: string): Promise<boolean>; onClose(): void };
export default function DialogueDirector(props: Props) {
  const [characterId, setCharacterId] = useState("");
  const [casualName, setCasualName] = useState("");
  const [authorName, setAuthorName] = useState("Carlos");
  const [objective, setObjective] = useState("");
  const [direction, setDirection] = useState("");
  const [avoid, setAvoid] = useState("");
  const [provider, setProvider] = useState<ProviderId | null>(props.defaultProvider ?? props.providers[0] ?? null);
  const [history, setHistory] = useState<RoleTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sceneNote, setSceneNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The scene setup is open until the conversation starts; it can be reopened at any time.
  const [setupOpen, setSetupOpen] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const name = props.memory.characters.find((c) => c.id === characterId)?.name ?? casualName.trim();
  const reset = () => { setHistory([]); setError(""); setSetupOpen(true); };

  // The newest line is always in view: the reply never hides under the composer.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, busy]);

  const send = async () => {
    if (!name || (!draft.trim() && !sceneNote.trim() && !direction.trim()) || !provider || busy) return;
    const next: RoleTurn[] = [...history, { speaker: "autor", text: draft.trim().slice(0, 500), context: sceneNote.trim().slice(0, 600) }];
    setHistory(next); setDraft(""); setSceneNote(""); setBusy(true); setError(""); setSetupOpen(false);
    try {
      const result = await api<{ text: string; truncated: boolean }>("/api/roleplay", {
        method: "POST", body: JSON.stringify({ novelId: props.novelId, chapterId: props.chapterId,
          characterId: characterId || undefined, casualName: characterId ? undefined : casualName,
          authorName, objective, direction, avoid, provider, history: next }),
      });
      setHistory([...next, { speaker: "personaje", text: result.text }]);
      setDirection("");
      if (result.truncated) setError("Respuesta incompleta: revisa el último mensaje.");
    } catch (e) {
      setHistory(history);
      setDraft(draft);
      setSceneNote(sceneNote);
      setError((e instanceof Error ? e.message : "No se pudo responder") + ". Tu mensaje se conservó: puedes reintentar.");
    }
    finally { setBusy(false); }
  };
  const transcript = history.map((t) => (t.speaker === "autor" ? authorName : name) + ": " + (t.context ? "[" + t.context + "]\n" : "") + t.text).join("\n\n");
  const canSend = !!name && (!!draft.trim() || !!sceneNote.trim() || !!direction.trim()) && !!provider && !busy;

  return <div className="modal-backdrop">
    <section className="modal" role="dialog" aria-modal="true" aria-label="Conversar con un personaje"
      style={{ width: "min(94vw, 740px)", maxWidth: 740, height: "min(92vh, 860px)", display: "flex", flexDirection: "column", overflow: "hidden", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <h2>Conversar con un personaje</h2><button type="button" onClick={props.onClose}>Cerrar</button>
      </div>
      <p style={{ flexShrink: 0 }}>Tú interpretas a un personaje; Procesador responde como el otro, un mensaje cada vez.</p>

      <details open={setupOpen} onToggle={(e) => setSetupOpen(e.currentTarget.open)} style={{ flexShrink: 0, maxHeight: "34vh", overflowY: "auto" }}>
        <summary style={{ cursor: "pointer", marginBottom: 8 }}>Escena: personajes, situación y reglas</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <label>Yo interpreto a
            <input style={{ display: "block", width: "100%" }} value={authorName} maxLength={100}
              onChange={(e) => { setAuthorName(e.target.value); reset(); }} placeholder="Carlos" />
          </label>
          <label>Converso con
            <select style={{ display: "block", width: "100%" }} value={characterId}
              onChange={(e) => { setCharacterId(e.target.value); reset(); }}>
              <option value="">Personaje sin ficha (por nombre)</option>
              {props.memory.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        {!characterId && <label style={{ display: "block", marginTop: 10 }}>Nombre del personaje
          <input style={{ display: "block", width: "100%" }} value={casualName} maxLength={100}
            onChange={(e) => { setCasualName(e.target.value); reset(); }} placeholder="Any, Sonia, camarero..." />
        </label>}
        <label style={{ display: "block", marginTop: 12 }}>Situación inicial de la escena (opcional)
          <textarea style={{ display: "block", width: "100%", minHeight: 56 }} value={objective} maxLength={900}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Any quiere aceptar la invitación, pero disimula. No debe adelantarse a mi siguiente intervención." />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>Qué debe evitar el personaje (prompt negativo)
          <textarea style={{ display: "block", width: "100%", minHeight: 56 }} value={avoid} maxLength={900}
            onChange={(e) => setAvoid(e.target.value)}
            placeholder="No tutear al jefe; tratarlo de usted. No hacerse la difícil, ni usar frases como tienes que conquistarme." />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>Proveedor
          <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            {props.providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <p style={{ fontSize: 12 }}>Ahorro de tokens: ficha, reglas, contexto escénico y últimas 16 intervenciones. Cada mensaje enviado consume tokens.</p>
      </details>

      <div ref={logRef} aria-label="Conversación" aria-live="polite"
        style={{ flex: 1, minHeight: 120, overflowY: "auto", padding: 12, margin: "12px 0", border: "1px solid #999", borderRadius: 8 }}>
        {!history.length && <p>Escribe un mensaje o dirige la escena para comenzar.</p>}
        {history.map((t, i) => <p key={i} style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>
          <strong>{t.speaker === "autor" ? authorName : name}:</strong> {t.context && <span style={{ display: "block", fontStyle: "italic", opacity: 0.8 }}>Contexto: {t.context}</span>}{t.text}
        </p>)}
        {busy && <p>{name} está respondiendo…</p>}
      </div>

      <div style={{ flexShrink: 0, display: "grid", gap: 8 }}>
        <label>Dirección del director para la próxima respuesta
          <textarea style={{ display: "block", width: "100%", minHeight: 44 }} rows={2} value={direction} maxLength={900}
            onChange={(e) => setDirection(e.target.value)} placeholder="Ahora acepta sin condiciones. Interpreta su reacción con gestos y diálogo." />
        </label>
        <label>Contexto de este momento (gestos y situación; no es diálogo)
          <textarea style={{ display: "block", width: "100%", minHeight: 36 }} rows={1} value={sceneNote} maxLength={600}
            onChange={(e) => setSceneNote(e.target.value)} placeholder="Describe solo lo que ocurre ahora: gestos, movimientos o circunstancias nuevas." />
        </label>
        <label>Tu mensaje
          <textarea style={{ display: "block", width: "100%", minHeight: 64 }} rows={3} value={draft} maxLength={500}
            onChange={(e) => setDraft(e.target.value)} placeholder={"Hola, " + (name || "¿cómo estás?")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSend) void send(); } }} />
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" disabled={!canSend} onClick={() => void send()}>Enviar mensaje</button>
          <button type="button" disabled={busy || !history.length} onClick={reset}>Nueva conversación</button>
          <button type="button" disabled={busy || props.locked || history.length < 2}
            onClick={async () => {
              setBusy(true); setError("");
              try { if (await props.onInsert(transcript)) props.onClose(); }
              catch (e) { setError(e instanceof Error ? e.message : "No se pudo insertar"); }
              finally { setBusy(false); }
            }}>Insertar conversación en capítulo</button>
        </div>
        {props.locked && <p style={{ margin: 0 }}>El capítulo está bloqueado; puedes conversar, pero no insertar.</p>}
        {error && <p role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </section>
  </div>;
}
