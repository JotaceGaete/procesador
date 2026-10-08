import "server-only";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";

/**
 * A protected novel's PIN or password (docs/privacidad.md). Never stored nor logged: only
 * `scrypt(HMAC-SHA256(pepper, secret), salt)`. The pepper is a server secret
 * (NOVEL_LOCK_PEPPER), so a copy of the database alone doesn't allow trying PINs offline
 * (a 6-digit PIN is only a million combinations).
 */

export type SecretKind = "pin" | "password";

const PARAMS = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LENGTH = 32;
export const PEPPER_VERSION = 1;

function pepper(): string {
  const value = process.env.NOVEL_LOCK_PEPPER;
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new HttpError(503, "Falta configurar NOVEL_LOCK_PEPPER en el servidor para proteger novelas.");
  }
  return "procesador-desarrollo";
}

function derive(secret: string, salt: Buffer, params = PARAMS): Promise<Buffer> {
  const peppered = createHmac("sha256", pepper()).update(secret, "utf8").digest();
  return new Promise((resolve, reject) =>
    scrypt(peppered, salt, KEY_LENGTH, { ...params, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Checks what the author chose before hashing it: a PIN of 6 to 12 digits, or a password of 8 or more characters. */
export function validateSecret(kind: unknown, secret: unknown): { kind: SecretKind; secret: string } {
  if (kind !== "pin" && kind !== "password") throw new HttpError(400, "Elige PIN o contraseña.");
  if (typeof secret !== "string") throw new HttpError(400, kind === "pin" ? "Escribe el PIN." : "Escribe la contraseña.");
  if (kind === "pin" && !/^\d{6,12}$/.test(secret)) throw new HttpError(400, "El PIN debe tener entre 6 y 12 dígitos.");
  if (kind === "password" && (secret.length < 8 || secret.length > 200)) {
    throw new HttpError(400, "La contraseña debe tener al menos 8 caracteres.");
  }
  return { kind, secret };
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(secret, salt);
  return `scrypt$ln=${Math.log2(PARAMS.N)},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifySecret(secret: unknown, stored: string): Promise<boolean> {
  if (typeof secret !== "string" || !secret || secret.length > 200) return false;
  const [scheme, params, salt, hash] = stored.split("$");
  const m = params?.match(/^ln=(\d+),r=(\d+),p=(\d+)$/);
  if (scheme !== "scrypt" || !m || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(secret, Buffer.from(salt, "base64"), { N: 2 ** Number(m[1]), r: Number(m[2]), p: Number(m[3]) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
