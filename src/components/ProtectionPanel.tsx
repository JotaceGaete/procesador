"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { NOVEL_IDLE_OPTIONS } from "@/lib/privacy";
import { useNovelLock, type NovelStatus } from "./NovelGate";

type Kind = "pin" | "password";

/**
 * Proteger una novela (docs/privacidad.md): its own PIN or password, never stored as is.
 * Changing or removing it asks for the current one; forgetting it, Procesador's password
 * (from the lock screen).
 */
export default function ProtectionPanel({ novelId }: { novelId: string }) {
  const gate = useNovelLock();
  const status = gate?.status;
  const [notice, setNotice] = useState("");
  if (!status) return null;
  const done = async (message: string) => {
    await gate.refresh();
    setNotice(message);
  };
  return (
    <div className="form protection">
      {status.protected ? (
        <>
          <p className="muted small">
            🔒 Protegida con {status.kind === "pin" ? "PIN" : "contraseña"}. Al abrirla se pide; se vuelve a bloquear tras{" "}
            {status.idleMinutes} minutos sin actividad, al cerrar sesión, al bloquear Procesador o con «Bloquear novela».
          </p>
          <Options key={`${status.idleMinutes}-${status.hideTitle}-${status.lockOnHide}`} novelId={novelId} status={status} onDone={done} />
          <ChangeSecret novelId={novelId} current={status.kind ?? "pin"} onDone={done} />
          <Remove novelId={novelId} kind={status.kind ?? "pin"} onDone={done} />
        </>
      ) : (
        <Protect novelId={novelId} onDone={done} />
      )}
      {notice && (
        <p className="muted small" role="status">
          {notice}
        </p>
      )}
      <p className="muted small">
        La protección cubre Procesador: el texto, la Memoria, las imágenes, la IA y la copia de seguridad piden la novela desbloqueada. Una copia
        de seguridad o una exportación ya descargada no queda protegida, ni lo que ya se envió a un proveedor de IA. Si olvidas el{" "}
        {status.kind === "password" ? "contraseña" : "PIN"}, la contraseña de Procesador permite quitar la protección o elegir otro. No dejes que el
        navegador lo guarde.
      </p>
    </div>
  );
}

function SecretFields({ kind, onKind, secret, onSecret, repeat, onRepeat, label = "" }: {
  kind: Kind;
  onKind(k: Kind): void;
  secret: string;
  onSecret(v: string): void;
  repeat: string;
  onRepeat(v: string): void;
  label?: string;
}) {
  const pin = kind === "pin";
  return (
    <>
      <label className="short">
        <span>Tipo{label}</span>
        <select value={kind} onChange={(e) => onKind(e.target.value as Kind)}>
          <option value="pin">PIN (6 a 12 dígitos)</option>
          <option value="password">Contraseña (8 caracteres o más)</option>
        </select>
      </label>
      <label className="short">
        <span>{pin ? "PIN" : "Contraseña"}{label}</span>
        <input type="password" inputMode={pin ? "numeric" : undefined} autoComplete="new-password" value={secret} onChange={(e) => onSecret(e.target.value)} />
      </label>
      <label className="short">
        <span>Repítelo</span>
        <input type="password" inputMode={pin ? "numeric" : undefined} autoComplete="new-password" value={repeat} onChange={(e) => onRepeat(e.target.value)} />
      </label>
    </>
  );
}

function OptionFields({ idle, onIdle, hideTitle, onHideTitle, lockOnHide, onLockOnHide }: {
  idle: number;
  onIdle(v: number): void;
  hideTitle: boolean;
  onHideTitle(v: boolean): void;
  lockOnHide: boolean;
  onLockOnHide(v: boolean): void;
}) {
  return (
    <>
      <label className="short">
        <span>Bloquear tras</span>
        <select value={idle} onChange={(e) => onIdle(Number(e.target.value))}>
          {NOVEL_IDLE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m} minutos sin actividad
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={hideTitle} onChange={(e) => onHideTitle(e.target.checked)} /> Ocultar el título en la biblioteca
        <span className="muted small"> (se verá «Novela protegida»)</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={lockOnHide} onChange={(e) => onLockOnHide(e.target.checked)} /> Bloquear al cambiar de pestaña o de app
        <span className="muted small"> (desactivado: salir un momento no vuelve a pedir el PIN)</span>
      </label>
    </>
  );
}

function useAction() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function Protect({ novelId, onDone }: { novelId: string; onDone(m: string): Promise<void> }) {
  const [kind, setKind] = useState<Kind>("pin");
  const [secret, setSecret] = useState("");
  const [repeat, setRepeat] = useState("");
  const [idle, setIdle] = useState(15);
  const [hideTitle, setHideTitle] = useState(false);
  const [lockOnHide, setLockOnHide] = useState(false);
  const { error, busy, run } = useAction();
  return (
    <form
      className="group"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (secret !== repeat) throw new Error("Los dos no coinciden.");
          await api(`/api/novels/${novelId}/protection`, { method: "PUT", json: { kind, secret, idleMinutes: idle, hideTitle, lockOnHide } });
          setSecret("");
          setRepeat("");
          await onDone("Novela protegida. Sigue abierta en esta sesión hasta que se bloquee.");
        });
      }}
    >
      <p className="muted small">Una novela protegida pide su propio PIN o contraseña al abrirla, aunque Procesador esté abierto.</p>
      <SecretFields kind={kind} onKind={setKind} secret={secret} onSecret={setSecret} repeat={repeat} onRepeat={setRepeat} />
      <OptionFields idle={idle} onIdle={setIdle} hideTitle={hideTitle} onHideTitle={setHideTitle} lockOnHide={lockOnHide} onLockOnHide={setLockOnHide} />
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy || !secret || !repeat}>
        {busy ? "Protegiendo…" : "Proteger esta novela"}
      </button>
    </form>
  );
}

function Options({ novelId, status, onDone }: { novelId: string; status: NovelStatus; onDone(m: string): Promise<void> }) {
  const [idle, setIdle] = useState(status.idleMinutes ?? 15);
  const [hideTitle, setHideTitle] = useState(status.hideTitle);
  const [lockOnHide, setLockOnHide] = useState(status.lockOnHide);
  const { error, busy, run } = useAction();
  const dirty = idle !== status.idleMinutes || hideTitle !== status.hideTitle || lockOnHide !== status.lockOnHide;
  return (
    <form
      className="group"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/api/novels/${novelId}/protection`, { method: "PATCH", json: { idleMinutes: idle, hideTitle, lockOnHide } });
          await onDone("Opciones guardadas.");
        });
      }}
    >
      <OptionFields idle={idle} onIdle={setIdle} hideTitle={hideTitle} onHideTitle={setHideTitle} lockOnHide={lockOnHide} onLockOnHide={setLockOnHide} />
      {error && <p className="error">{error}</p>}
      <button className="btn" disabled={busy || !dirty}>
        Guardar opciones
      </button>
    </form>
  );
}

function ChangeSecret({ novelId, current, onDone }: { novelId: string; current: Kind; onDone(m: string): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [currentSecret, setCurrentSecret] = useState("");
  const [kind, setKind] = useState<Kind>(current);
  const [secret, setSecret] = useState("");
  const [repeat, setRepeat] = useState("");
  const { error, busy, run } = useAction();
  if (!open)
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Cambiar el {current === "pin" ? "PIN" : "contraseña"}
      </button>
    );
  return (
    <form
      className="group"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (secret !== repeat) throw new Error("Los dos nuevos no coinciden.");
          await api(`/api/novels/${novelId}/protection`, { method: "PUT", json: { currentSecret, kind, secret } });
          setOpen(false);
          await onDone("Cambiado. Las demás sesiones y dispositivos vuelven a pedirlo.");
        });
      }}
    >
      <label className="short">
        <span>{current === "pin" ? "PIN" : "Contraseña"} actual</span>
        <input type="password" inputMode={current === "pin" ? "numeric" : undefined} autoComplete="off" value={currentSecret} onChange={(e) => setCurrentSecret(e.target.value)} />
      </label>
      <SecretFields kind={kind} onKind={setKind} secret={secret} onSecret={setSecret} repeat={repeat} onRepeat={setRepeat} label=" nuevo" />
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy || !currentSecret || !secret}>
        Cambiar
      </button>{" "}
      <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
        Cancelar
      </button>
    </form>
  );
}

function Remove({ novelId, kind, onDone }: { novelId: string; kind: Kind; onDone(m: string): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const { error, busy, run } = useAction();
  if (!open)
    return (
      <button type="button" className="link danger" onClick={() => setOpen(true)}>
        Quitar la protección
      </button>
    );
  return (
    <form
      className="group"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/api/novels/${novelId}/protection`, { method: "DELETE", json: { secret } });
          setOpen(false);
          await onDone("La novela ya no está protegida.");
        });
      }}
    >
      <label className="short">
        <span>{kind === "pin" ? "PIN" : "Contraseña"} actual</span>
        <input type="password" inputMode={kind === "pin" ? "numeric" : undefined} autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn danger" disabled={busy || !secret}>
        Quitar la protección
      </button>{" "}
      <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
        Cancelar
      </button>
    </form>
  );
}
