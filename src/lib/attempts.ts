import "server-only";
import { db } from "./supabase";
import { HttpError } from "./http";

/**
 * Failed attempts of a credential, kept in the database (serverless instances share no
 * memory): 'app' for APP_PASSWORD, 'novel:<id>' for a novel's PIN. From the fifth failure
 * on, a wait that doubles from 30 s up to 15 minutes (credential_failure in schema.sql).
 */
export const APP_KEY = "app";
export const novelKey = (novelId: string) => `novel:${novelId}`;

const FAILED_DELAY_MS = 1000;

function tooMany(until: string) {
  const seconds = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 1000));
  return new HttpError(429, `Demasiados intentos. Vuelve a intentarlo en ${formatWait(seconds)}.`, {
    code: "too_many_attempts",
    retryAfter: seconds,
  });
}

export function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Throws 429 while the credential is waiting after too many failures. */
export async function assertNotBlocked(key: string) {
  const { data, error } = await db().from("credential_attempts").select("blocked_until").eq("key", key).maybeSingle();
  if (error) throw error;
  if (data?.blocked_until && new Date(data.blocked_until).getTime() > Date.now()) throw tooMany(data.blocked_until);
}

/** A wrong credential: counted, slowed down, and answered 401 (or 429 once it has to wait). */
export async function failedAttempt(key: string, message: string): Promise<never> {
  const { data, error } = await db().rpc("credential_failure", { p_key: key });
  if (error) throw error;
  await new Promise((r) => setTimeout(r, FAILED_DELAY_MS));
  if (data && new Date(data as string).getTime() > Date.now()) throw tooMany(data as string);
  throw new HttpError(401, message, { code: "wrong_credential" });
}

export async function succeededAttempt(key: string) {
  const { error } = await db().rpc("credential_success", { p_key: key });
  if (error) throw error;
}
