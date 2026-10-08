import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hashSecret, validateSecret, verifySecret } from "@/lib/secret";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

test("a PIN is stored only as a salted scrypt hash, and verifies", async () => {
  process.env.NOVEL_LOCK_PEPPER = "pimienta";
  const hash = await hashSecret("246810");
  assert.match(hash, /^scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!hash.includes("246810"));
  assert.notEqual(hash, await hashSecret("246810"), "a new salt every time");
  assert.ok(await verifySecret("246810", hash));
  assert.ok(!(await verifySecret("246811", hash)));
  assert.ok(!(await verifySecret("", hash)));
  assert.ok(!(await verifySecret(246810, hash)));
  assert.ok(!(await verifySecret("246810", "plain:246810")), "anything but a scrypt hash is refused");
});

test("the pepper matters: the same PIN and hash don't verify with another server secret", async () => {
  process.env.NOVEL_LOCK_PEPPER = "pimienta";
  const hash = await hashSecret("246810");
  process.env.NOVEL_LOCK_PEPPER = "otra";
  assert.ok(!(await verifySecret("246810", hash)));
});

test("without NOVEL_LOCK_PEPPER in production, nothing is hashed (503)", async () => {
  delete process.env.NOVEL_LOCK_PEPPER;
  process.env = { ...process.env, NODE_ENV: "production" };
  await assert.rejects(hashSecret("246810"), (e: { status?: number }) => e.status === 503);
});

test("PIN of 6 to 12 digits; password of 8 or more characters", () => {
  assert.deepEqual(validateSecret("pin", "123456"), { kind: "pin", secret: "123456" });
  for (const bad of ["12345", "12345a", "1234567890123", ""]) assert.throws(() => validateSecret("pin", bad), /PIN/);
  assert.throws(() => validateSecret("password", "corta"), /8 caracteres/);
  assert.equal(validateSecret("password", "una frase larga").kind, "password");
  assert.throws(() => validateSecret("huella", "x"), /PIN o contraseña/);
});
