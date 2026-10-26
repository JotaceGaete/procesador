"use client";
import { useState } from "react";
import type { Memory, ProviderId } from "@/lib/types";
import { api } from "@/lib/client";

type Person = { key: string; role: "habla" | "escucha" };
type Props = { novelId: string; chapterId: string; memory: Memory; providers: ProviderId[]; defaultProvider: ProviderId | null; locked: boolean; onInsert(text: string): Promise<boolean>; onClose(): void };
export default function DialogueDirector(props: Props) {
  const [people, setPeople] = useState<Person[]>([]);
  const [casual, setCasual] = useState("");
  const [argument, setArgument] = useState("");
  const [context, setContext] = useState("");
  const [length, setLength] = useState<"breve" | "media" | "larga">("breve");
  const [provider, setProvider] = useState<ProviderId | null>(props.defaultProvider);
  const [preview, setPreview] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (key: string) => {
    setPeople((list) => list.some((p) => p.key === key) ? list.filter((p) => p.key !== key) : [...list, { key, role: "habla" }]);
    setPreview("");
  };
  const generate = async () => {
    if (!provider) return;
    setBusy(true); setError(""); setPreview("");
    try {
      const participants = people.map((p) => p.key.startsWith("oc:") ? { name: p.key.slice(3), role: p.role } : { id: p.key, role: p.role });
      const result = await api<{ text: string; truncated: boolean }>("/api/dialogue", {
        method: "POST", body: JSON.stringify({ novelId: props.novelId, chapterId: props.chapterId, provider, participants, argument, context, length }),
      });
      setPreview(result.text); setTruncated(result.truncated);
    } catch (e) { setError(e instanceof Error ? e.message : "Error al generar"); }
    finally { setBusy(false); }
  };
  const canGenerate = Boolean(provider && people.length >= 2 && argument.trim() && !busy);
  const reason = people.length < 2 ? "Selecciona o añade al menos dos personajes." : !argument.trim() ? "Escribe qué debe ocurrir y cómo termina la conversación." : !provider ? "Selecciona un proveedor de IA." : "";
  const field = { display: "block", marginTop: 16 } as const;
  return <div className="modal-backdrop">
    <section className="modal" role="dialog" aria-modal="true" aria-label="Director de diálogos" style={{ width: "min(94vw, 700px)", maxWidth: 700, maxHeight: "90vh", overflowY: "auto", padding: 22 }}>
      <h2 style={{ marginBottom: 10 }}>Director de diálogos</h2>
      <button type="button" onClick={props.onClose}>Cerrar</button>
      <p>Selecciona quién participa y quién solo escucha. Si falta una ficha, añade ese personaje por su nombre; no se guardará una ficha nueva.</p>
      {props.memory.characters.map((c) => {
        const selected = people.find((p) => p.key === c.id);
        return <div key={c.id}>
          <label><input type="checkbox" checked={!!selected} onChange={() => toggle(c.id)} />{c.name}</label>
          {selected && <select aria-label={c.name + " participación"} value={selected.role} onChange={(e) => setPeople((list) => list.map((p) => p.key === c.id ? { ...p, role: e.target.value as Person["role"] } : p))}><option value="habla">Habla</option><option value="escucha">Escucha</option></select>}
        </div>;
      })}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}><input aria-label="Añadir participante por nombre" placeholder="Carlos, Sonia, camarero..." value={casual} onChange={(e) => setCasual(e.target.value)} />
      <button type="button" onClick={() => {
        const name = casual.trim();
        if (name && !people.some((p) => p.key.toLowerCase() === ("oc:" + name).toLowerCase())) {
          setPeople((list) => [...list, { key: "oc:" + name, role: "habla" }]); setCasual("");
        }
      }}>Añadir participante</button></div>
      {people.filter((p) => p.key.startsWith("oc:")).map((p) => <div key={p.key}>
        {p.key.slice(3)}
        <select value={p.role} onChange={(e) => setPeople((list) => list.map((x) => x.key === p.key ? { ...x, role: e.target.value as Person["role"] } : x))}><option value="habla">Habla</option><option value="escucha">Escucha</option></select>
        <button type="button" onClick={() => toggle(p.key)}>Quitar</button>
      </div>)}
      <label style={field}>Argumento y desenlace<textarea style={{ width: "100%", minHeight: 100 }} value={argument} onChange={(e) => setArgument(e.target.value)} /></label>
      <label style={field}>Contexto breve (opcional)<textarea style={{ width: "100%" }} value={context} onChange={(e) => setContext(e.target.value)} /></label>
      <label style={field}>Extensión <select value={length} onChange={(e) => setLength(e.target.value as typeof length)}><option value="breve">Breve</option><option value="media">Media</option><option value="larga">Larga</option></select></label>
      <label style={field}>Proveedor <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value as ProviderId)}>{props.providers.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      <p>Modo económico: solo fichas seleccionadas y contexto breve.</p>
      {reason && <p role="status" style={{ marginTop: 12 }}>{reason}</p>}
      <button type="button" disabled={!canGenerate} onClick={() => void generate()}>{busy ? "Generando…" : "Generar diálogo"}</button>
      {error && <p role="alert">{error}</p>}
      {preview && <div>
        {truncated && <p>Respuesta incompleta: no se puede insertar.</p>}
        <label>Vista previa editable<textarea style={{ width: "100%", minHeight: 200 }} value={preview} onChange={(e) => setPreview(e.target.value)} /></label>
        <button type="button" disabled={busy || props.locked || truncated} onClick={async () => {
          setBusy(true);
          try { if (await props.onInsert(preview)) props.onClose(); }
          catch (e) { setError(e instanceof Error ? e.message : "Error al insertar"); }
          finally { setBusy(false); }
        }}>Insertar al final del capítulo</button>
        {props.locked && <p>Capítulo bloqueado: desbloquéalo para insertar.</p>}
      </div>}
    </section>
  </div>;
}
