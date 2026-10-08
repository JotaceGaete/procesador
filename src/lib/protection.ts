import "server-only";
import { db } from "./supabase";
import { HttpError } from "./http";
import { hashSecret, PEPPER_VERSION, verifySecret, type SecretKind } from "./secret";
import { assertNotBlocked, failedAttempt, novelKey, succeededAttempt } from "./attempts";
import { NOVEL_IDLE_OPTIONS } from "./privacy";

/** A protected novel's stored credential (only on the server, only to verify). */
export async function getProtection(novelId: string): Promise<{ secret_hash: string; secret_kind: SecretKind } | null> {
  const { data, error } = await db().from("novel_protection").select("secret_hash, secret_kind").eq("novel_id", novelId).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * The current PIN, asked again for what can't be undone or weakens the protection (change it,
 * remove it, delete the novel). Counted with the unlock attempts.
 */
export async function checkSecret(novelId: string, secret: unknown) {
  const key = novelKey(novelId);
  await assertNotBlocked(key);
  const stored = await getProtection(novelId);
  if (!stored) throw new HttpError(400, "Esta novela no está protegida.");
  if (!(await verifySecret(secret, stored.secret_hash))) {
    await failedAttempt(key, stored.secret_kind === "password" ? "La contraseña de la novela no es correcta." : "El PIN de la novela no es correcto.");
  }
  await succeededAttempt(key);
}

/** Protects the novel or changes its PIN; it stays unlocked only in this session. */
export async function protect(sessionId: string, novelId: string, kind: SecretKind, secret: string) {
  const { error } = await db().rpc("novel_protect", {
    p_session: sessionId,
    p_novel: novelId,
    p_hash: await hashSecret(secret),
    p_kind: kind,
    p_pepper: PEPPER_VERSION,
  });
  if (error) throw error;
}

export interface ProtectionOptions {
  idle_minutes?: number;
  hide_title?: boolean;
  lock_on_hide?: boolean;
}

export function readOptions(body: Record<string, unknown>): ProtectionOptions {
  const out: ProtectionOptions = {};
  if (body.idleMinutes !== undefined) {
    if (!NOVEL_IDLE_OPTIONS.includes(body.idleMinutes as (typeof NOVEL_IDLE_OPTIONS)[number])) {
      throw new HttpError(400, "Elige 5, 15, 30 o 60 minutos.");
    }
    out.idle_minutes = body.idleMinutes as number;
  }
  if (typeof body.hideTitle === "boolean") out.hide_title = body.hideTitle;
  if (typeof body.lockOnHide === "boolean") out.lock_on_hide = body.lockOnHide;
  return out;
}

export async function saveOptions(novelId: string, options: ProtectionOptions) {
  const { error } = await db().from("novel_protection").update(options).eq("novel_id", novelId);
  if (error) throw error;
}
