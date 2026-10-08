"use client";

import Link from "next/link";
import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState } from "react";
import { abortTrackedRequests, api, LOCK_EVENT, markProtected, type LockDetail } from "@/lib/client";
import { WARN_BEFORE_MS } from "@/lib/privacy";
import { openChannel, runGuards, useLock } from "./LockProvider";

/**
 * A protected novel (docs/privacidad.md). The server decides: while the novel is locked in
 * this session every route of its data answers 423. This gate shows the unlock screen
 * instead of the workspace, and on locking (Bloquear novela, the idle time, leaving the tab
 * if the author chose so, or a 423) saves what is open, stops requests and unmounts it.
 */

export interface NovelStatus {
  id: string;
  protected: boolean;
  locked: boolean;
  kind: "pin" | "password" | null;
  hideTitle: boolean;
  title?: string | null;
  idleMinutes: number | null;
  lockOnHide: boolean;
  remainingMs: number | null;
}

interface NovelLockApi {
  status: NovelStatus;
  lockNovel(): Promise<void>;
  /** After protecting, changing or removing protection: the new state, from the server. */
  refresh(): Promise<void>;
}

const NovelLockContext = createContext<NovelLockApi | null>(null);

export function useNovelLock(): NovelLockApi | null {
  return useContext(NovelLockContext);
}

export default function NovelGate({ novelId, children }: { novelId: string; children: React.ReactNode }) {
  const lock = useLock();
  const [status, setStatus] = useState<NovelStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  const [warning, setWarning] = useState(false);
  const timers = useRef<number[]>([]);
  const lockedRef = useRef(false);
  const statusRef = useRef<NovelStatus | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };

  const enterLocked = useCallback(
    (next?: Partial<NovelStatus>) => {
      clearTimers();
      abortTrackedRequests();
      lockedRef.current = true;
      setWarning(false);
      markProtected(novelId, true);
      setStatus((s) => ({ ...(s ?? emptyStatus(novelId)), ...next, protected: true, locked: true, remainingMs: null }));
    },
    [novelId],
  );

  const lockNovel = useCallback(async () => {
    if (lockedRef.current) return;
    await runGuards(lock.guards);
    abortTrackedRequests();
    // keepalive: it still arrives if the tab is being hidden (lock on leaving the tab).
    const res = await fetch(`/api/novels/${novelId}/lock`, { method: "POST", keepalive: true }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    enterLocked(data?.novel);
    channel.current?.postMessage({ type: "novel-locked", id: novelId });
  }, [lock.guards, novelId, enterLocked]);

  const atDeadline = useRef(async () => {});

  const apply = useCallback(
    (s: NovelStatus) => {
      statusRef.current = s;
      // Before the workspace mounts: a protected novel's drafts never touch localStorage.
      markProtected(novelId, s.protected);
      if (s.locked) {
        if (!lockedRef.current) enterLocked(s);
        else setStatus(s);
        return;
      }
      if (lockedRef.current) {
        lockedRef.current = false;
        setGeneration((g) => g + 1);
      }
      setStatus(s);
      clearTimers();
      setWarning(false);
      if (!s.protected || s.remainingMs === null) return;
      const left = s.remainingMs;
      timers.current.push(window.setTimeout(() => setWarning(true), Math.max(0, left - WARN_BEFORE_MS)));
      timers.current.push(window.setTimeout(() => void atDeadline.current(), Math.max(0, left)));
    },
    [enterLocked, novelId],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ novel: NovelStatus }>(`/api/session?novelId=${novelId}`);
      if (data.novel) apply(data.novel);
    } catch {
      setStatus((s) => s ?? emptyStatus(novelId));
    }
  }, [apply, novelId]);

  atDeadline.current = async () => {
    await refresh();
    const s = statusRef.current;
    if (s && !s.locked && (s.remainingMs ?? 0) > 1000) return;
    await lockNovel();
  };

  useEffect(() => {
    void refresh();
    // The ping carries this novel: reading it counts as activity for it too.
    lock.setPingExtra({
      novelId,
      onStatus: (data) => {
        const novel = (data as { novel?: NovelStatus }).novel;
        if (novel) apply(novel);
      },
    });
    channel.current = openChannel();
    const onMessage = (e: MessageEvent) => {
      if (e.data?.id !== novelId) return;
      if (e.data.type === "novel-locked") {
        enterLocked();
        void refresh(); // its lock screen's title
      } else if (e.data.type === "novel-unlocked") void refresh();
    };
    channel.current?.addEventListener("message", onMessage);
    const onLock = (e: Event) => {
      const d = (e as CustomEvent<LockDetail>).detail;
      if (d.scope === "novel" && d.novel?.id === novelId) enterLocked({ title: d.novel.title, kind: d.novel.kind ?? "pin" });
    };
    window.addEventListener(LOCK_EVENT, onLock);
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && statusRef.current?.lockOnHide && !lockedRef.current) void lockNovel();
      else if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onShow = (e: PageTransitionEvent) => e.persisted && void refresh();
    window.addEventListener("pageshow", onShow);
    return () => {
      clearTimers();
      lock.setPingExtra(null);
      channel.current?.removeEventListener("message", onMessage);
      channel.current?.close();
      window.removeEventListener(LOCK_EVENT, onLock);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per novel
  }, [novelId]);

  if (!status) return <main className="fatal muted">Cargando…</main>;
  if (status.locked) {
    return (
      <NovelLockScreen
        status={status}
        onUnlocked={(s) => {
          channel.current?.postMessage({ type: "novel-unlocked", id: novelId });
          apply(s);
        }}
      />
    );
  }
  return (
    <NovelLockContext.Provider value={{ status, lockNovel, refresh }}>
      <Fragment key={generation}>{children}</Fragment>
      {warning && (
        <p className="lock-warning" role="alert">
          Esta novela se bloqueará en un minuto por inactividad.{" "}
          <button className="btn primary" onClick={lock.ping}>
            Seguir
          </button>
        </p>
      )}
    </NovelLockContext.Provider>
  );
}

function emptyStatus(id: string): NovelStatus {
  return { id, protected: false, locked: false, kind: null, hideTitle: false, idleMinutes: null, lockOnHide: false, remainingMs: null };
}

function NovelLockScreen({ status, onUnlocked }: { status: NovelStatus; onUnlocked(s: NovelStatus): void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const pin = status.kind !== "password";
  const name = status.title ?? "Novela protegida";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/novels/${status.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setSecret("");
    setBusy(false);
    if (res?.ok) return onUnlocked(data.novel);
    if (res?.status === 423 && data.code === "app_locked") {
      window.dispatchEvent(new CustomEvent<LockDetail>(LOCK_EVENT, { detail: { scope: "app" } }));
      return;
    }
    if (res?.status === 401 && data.code !== "wrong_credential") {
      window.location.href = "/login";
      return;
    }
    setError(data.error ?? "No se pudo desbloquear.");
  }

  if (recovering) return <RecoverScreen status={status} onBack={() => setRecovering(false)} onDone={onUnlocked} />;

  return (
    <main className="login lock-screen">
      <form onSubmit={submit} className="login-card">
        <span className="lock-icon" aria-hidden="true">
          🔒
        </span>
        <h1>{name}</h1>
        <p className="muted small">Esta novela está protegida. Escribe su {pin ? "PIN" : "contraseña"} para abrirla.</p>
        <label className="sr-only" htmlFor="novel-unlock">
          {pin ? "PIN" : "Contraseña de la novela"}
        </label>
        <input
          id="novel-unlock"
          name={`novel-secret-${status.id}`}
          type="password"
          inputMode={pin ? "numeric" : undefined}
          autoComplete="off"
          autoFocus
          placeholder={pin ? "PIN" : "Contraseña de la novela"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <button className="btn primary" disabled={busy || !secret}>
          {busy ? "Comprobando…" : "Desbloquear"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Link href="/" className="link small">
          Volver a la biblioteca
        </Link>
        <button type="button" className="link muted small" onClick={() => setRecovering(true)}>
          Olvidé el {pin ? "PIN" : "contraseña"}
        </button>
      </form>
    </main>
  );
}

/** «Olvidé el PIN»: with Procesador's password, remove the protection or set a new PIN. */
function RecoverScreen({ status, onBack, onDone }: { status: NovelStatus; onBack(): void; onDone(s: NovelStatus): void }) {
  const [appPassword, setAppPassword] = useState("");
  const [action, setAction] = useState<"reset" | "remove">("reset");
  const [kind, setKind] = useState<"pin" | "password">(status.kind ?? "pin");
  const [secret, setSecret] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (action === "reset" && secret !== repeat) return setError("Los dos no coinciden.");
    setBusy(true);
    setError("");
    const res = await fetch(`/api/novels/${status.id}/protection/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appPassword, action, kind, secret }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    setAppPassword("");
    if (res?.ok) return onDone(data.novel);
    if (res?.status === 401 && data.code !== "wrong_credential") {
      window.location.href = "/login";
      return;
    }
    setError(data.error ?? "No se pudo recuperar.");
  }

  return (
    <main className="login lock-screen">
      <form onSubmit={submit} className="login-card">
        <h1>Recuperar la novela</h1>
        <p className="muted small">Con la contraseña de Procesador puedes quitar la protección o elegir un PIN nuevo.</p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Contraseña de Procesador"
          aria-label="Contraseña de Procesador"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
        />
        <label className="choice">
          <input type="radio" checked={action === "reset"} onChange={() => setAction("reset")} /> Elegir un {kind === "pin" ? "PIN" : "contraseña"} nuevo
        </label>
        <label className="choice">
          <input type="radio" checked={action === "remove"} onChange={() => setAction("remove")} /> Quitar la protección
        </label>
        {action === "reset" && (
          <>
            <select value={kind} onChange={(e) => setKind(e.target.value as "pin" | "password")} aria-label="Tipo">
              <option value="pin">PIN (6 a 12 dígitos)</option>
              <option value="password">Contraseña (8 caracteres o más)</option>
            </select>
            <input
              type="password"
              inputMode={kind === "pin" ? "numeric" : undefined}
              autoComplete="new-password"
              placeholder={kind === "pin" ? "PIN nuevo" : "Contraseña nueva"}
              aria-label={kind === "pin" ? "PIN nuevo" : "Contraseña nueva"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <input
              type="password"
              inputMode={kind === "pin" ? "numeric" : undefined}
              autoComplete="new-password"
              placeholder="Repítelo"
              aria-label="Repetir"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </>
        )}
        <button className="btn primary" disabled={busy || !appPassword || (action === "reset" && !secret)}>
          {busy ? "Comprobando…" : action === "reset" ? "Guardar y abrir" : "Quitar la protección"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="link small" onClick={onBack}>
          Volver
        </button>
      </form>
    </main>
  );
}
