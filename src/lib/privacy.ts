// Shared by the server and the browser (docs/privacidad.md).

/** Minutes without activity before Procesador locks. */
export const APP_IDLE_OPTIONS = [15, 30, 60, 120, 240] as const;
export const DEFAULT_APP_IDLE = 15;

/** The browser says the author is here at most this often (and only after real input). */
export const PING_EVERY_MS = 60_000;
/** The notice before locking, so a moment of reading doesn't end in the lock screen. */
export const WARN_BEFORE_MS = 60_000;

export type LockScope = "app" | "novel";
