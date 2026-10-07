"use client";

import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState } from "react";
import { abortTrackedRequests, api, LOCK_EVENT, type LockDetail } from "@/lib/client";
import { PING_EVERY_MS, WARN_BEFORE_MS } from "@/lib/privacy";

/**
 * Bloqueo de Procesador por inactividad (docs/privacidad.md). The server decides: every
 * request checks the session, and past the idle time it answers 423. This only makes it
 * prompt and tidy in the browser:
 *   - real input (keys, pointer, wheel, scroll, touch) is sent as a ping at most once a minute;
 *   - a notice a minute before the end, and the lock at the end, with the browser's own clock;
 *   - before locking, what is open is saved (guards), requests stop, and everything under
 *     the provider is unmounted: text, Memoria, proposals and undo history leave memory.
 * The same tracker carries a protected novel's activity (NovelGate).
 */

interface AppStatus {
  enabled: boolean;
  locked: boolean;
  idleMinutes: number;
  remainingMs: number | null;
}

type Guard = () => Promise<unknown> | unknown;

interface LockApi {
  /** Procesador can lock (there is an APP_PASSWORD to unlock with). */
  enabled: boolean;
  lockApp(): Promise<void>;
  /** Runs before any lock: saves what is open. At most a few seconds. Use useLockGuard. */
  guards: Set<Guard>;
  /** Extra data sent with each ping (the open novel), and what to do with the answer. */
  setPingExtra(extra: { novelId: string; onStatus(data: unknown): void } | null): void;
  /** Counts as activity now (the notice's «Seguir»). */
  ping(): void;
}

const LockContext = createContext<LockApi | null>(null);

export function useLock(): LockApi {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error("useLock fuera de LockProvider");
  return ctx;
}

/** Saves what the component has open before any lock (Procesador's or the novel's). */
export function useLockGuard(fn: Guard) {
  const { guards } = useLock();
  useEffect(() => {
    guards.add(fn);
    return () => void guards.delete(fn);
  }, [guards, fn]);
}

const CHANNEL = "procesador-lock";
const GUARD_TIMEOUT_MS = 3000;

export async function runGuards(guards: Set<Guard>) {
  await Promise.race([
    Promise.allSettled([...guards].map((g) => Promise.resolve().then(g))),
    new Promise((r) => setTimeout(r, GUARD_TIMEOUT_MS)),
  ]);
}

export function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

export default function LockProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [locked, setLocked] = useState(false);
  const [warning, setWarning] = useState(false);
  // Remounts everything under the provider after unlocking: it loads again from the server.
  const [generation, setGeneration] = useState(0);

  const deadline = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  const lastPing = useRef(0);
  const guards = useRef(new Set<Guard>());
  const pingExtra = useRef<{ novelId: string; onStatus(data: unknown): void } | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const lockedRef = useRef(false);
  const enabledRef = useRef(false);

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };

  /** Unmounts what was open (the server already knows, or is told by lockApp). */
  const enterLocked = useCallback(() => {
    clearTimers();
    abortTrackedRequests();
    lockedRef.current = true;
    deadline.current = null;
    setWarning(false);
    setLocked(true);
  }, []);

  const apply = useCallback(
    (app: AppStatus) => {
      setStatus(app);
      enabledRef.current = app.enabled;
      if (app.locked && app.enabled) return enterLocked();
      clearTimers();
      setWarning(false);
      deadline.current = app.enabled && app.remainingMs !== null ? Date.now() + app.remainingMs : null;
      if (deadline.current === null) return;
      const left = deadline.current - Date.now();
      timers.current.push(window.setTimeout(() => setWarning(true), Math.max(0, left - WARN_BEFORE_MS)));
      timers.current.push(window.setTimeout(() => void atDeadline.current(), Math.max(0, left)));
    },
    [enterLocked],
  );

  const refresh = useCallback(async () => {
    try {
      const { app } = await api<{ app: AppStatus }>("/api/session");
      if (!app.locked && lockedRef.current) {
        // Unlocked in another tab: this one opens too, reloading what it shows.
        lockedRef.current = false;
        setLocked(false);
        setGeneration((g) => g + 1);
      }
      apply(app);
      return app;
    } catch {
      // No answer (offline): show what there is; the next request will tell.
      setStatus((s) => s ?? { enabled: false, locked: false, idleMinutes: 15, remainingMs: null });
      return null;
    }
  }, [apply]);

  const lockApp = useCallback(async () => {
    if (!enabledRef.current || lockedRef.current) return;
    await runGuards(guards.current);
    abortTrackedRequests();
    await fetch("/api/session/lock", { method: "POST" }).catch(() => {});
    enterLocked();
    channel.current?.postMessage({ type: "app-locked" });
  }, [enterLocked]);

  // At the browser's deadline, ask the server (another tab may have kept the session alive).
  const atDeadline = useRef(async () => {});
  atDeadline.current = async () => {
    const app = await refresh();
    if (app && !app.locked && (app.remainingMs ?? 0) > 1000) return;
    await lockApp();
  };

  const ping = useCallback(() => {
    if (lockedRef.current) return;
    lastPing.current = Date.now();
    const extra = pingExtra.current;
    api<{ app: AppStatus }>("/api/session/ping", { method: "POST", json: extra ? { novelId: extra.novelId } : {} })
      .then((data) => {
        apply(data.app);
        extra?.onStatus(data);
      })
      .catch(() => {});
  }, [apply]);

  useEffect(() => {
    void refresh();
    channel.current = openChannel();
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "app-locked") enterLocked();
      else if (e.data?.type === "app-unlocked") void refresh();
    };
    channel.current?.addEventListener("message", onMessage);
    const onLock = (e: Event) => {
      if ((e as CustomEvent<LockDetail>).detail.scope === "app") enterLocked();
    };
    window.addEventListener(LOCK_EVENT, onLock);
    const onActivity = () => {
      if (lockedRef.current || !enabledRef.current) return;
      if (Date.now() - lastPing.current >= PING_EVERY_MS) ping();
    };
    const events = ["keydown", "pointerdown", "wheel", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true, capture: true });
    window.addEventListener("scroll", onActivity, { passive: true, capture: true });
    // Timers sleep in a background tab or a phone's app switcher: check again on return.
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    // Back/forward cache: the page may come back exactly as it was before locking.
    const onShow = (e: PageTransitionEvent) => e.persisted && void refresh();
    window.addEventListener("pageshow", onShow);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void lockApp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimers();
      channel.current?.removeEventListener("message", onMessage);
      channel.current?.close();
      window.removeEventListener(LOCK_EVENT, onLock);
      for (const ev of events) window.removeEventListener(ev, onActivity, { capture: true });
      window.removeEventListener("scroll", onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh, enterLocked, ping, lockApp]);

  const api_: LockApi = {
    enabled: status?.enabled ?? false,
    lockApp,
    guards: guards.current,
    setPingExtra: useCallback((extra) => {
      pingExtra.current = extra;
    }, []),
    ping,
  };

  if (!status) return <main className="fatal muted">Cargando…</main>;

  return (
    <LockContext.Provider value={api_}>
      {locked ? (
        <AppLockScreen
          onUnlocked={(app) => {
            lockedRef.current = false;
            setLocked(false);
            setGeneration((g) => g + 1);
            apply(app);
            lastPing.current = Date.now();
            channel.current?.postMessage({ type: "app-unlocked" });
          }}
        />
      ) : (
        <Fragment key={generation}>{children}</Fragment>
      )}
      {warning && !locked && (
        <p className="lock-warning" role="alert">
          Procesador se bloqueará en un minuto por inactividad.{" "}
          <button className="btn primary" onClick={ping}>
            Seguir
          </button>
        </p>
      )}
    </LockContext.Provider>
  );
}

function AppLockScreen({ onUnlocked }: { onUnlocked(app: AppStatus): void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/session/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setPassword("");
    setBusy(false);
    if (res?.ok) return onUnlocked(data.app);
    if (res?.status === 401 && data.code !== "wrong_credential") {
      window.location.href = "/login";
      return;
    }
    setError(data.error ?? "No se pudo desbloquear.");
  }

  return (
    <main className="login lock-screen">
      <form onSubmit={submit} className="login-card">
        <h1>Procesador bloqueado</h1>
        <p className="muted small">Se bloqueó por inactividad o a petición tuya. Escribe la contraseña de Procesador para seguir.</p>
        <label className="sr-only" htmlFor="app-unlock">
          Contraseña
        </label>
        <input
          id="app-unlock"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" disabled={busy || !password}>
          {busy ? "Comprobando…" : "Desbloquear"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="link muted small"
          onClick={async () => {
            await fetch("/api/logout", { method: "POST" }).catch(() => {});
            window.location.href = "/login";
          }}
        >
          Cerrar sesión
        </button>
      </form>
    </main>
  );
}
