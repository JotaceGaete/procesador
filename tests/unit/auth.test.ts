import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DEV_SESSION_ID, checkSession, createSessionToken, readCookie, safeEqual, SESSION_COOKIE } from "@/lib/auth";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
const setEnv = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const SID = "6f0d5a3e-2b1c-4d5e-8f9a-0b1c2d3e4f5a";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const later = () => Date.now() + 60_000;

test("a signed session carries its id; tampered, expired, foreign or old-format tokens are not valid", async () => {
  setEnv({ APP_PASSWORD: "secreto" });
  const expires = later();
  const token = await createSessionToken("secreto", SID, expires);
  assert.deepEqual(await checkSession(token), { state: "ok", sessionId: SID });
  const [, exp, sig] = token.split(".");
  assert.equal((await checkSession(`${SID}.${Number(exp) + 1000}.${sig}`)).state, "denied", "expiry can't be extended");
  assert.equal((await checkSession(`${OTHER}.${exp}.${sig}`)).state, "denied", "the id can't be swapped");
  assert.equal((await checkSession(await createSessionToken("secreto", SID, Date.now() - 1))).state, "denied", "expired");
  assert.equal((await checkSession(await createSessionToken("otra", SID, expires))).state, "denied", "another password");
  assert.equal((await checkSession(`${exp}.${sig}`)).state, "denied", "the format before session ids");
  assert.equal((await checkSession(`${token}.x`)).state, "denied");
  assert.equal((await checkSession(`not-a-uuid.${exp}.${sig}`)).state, "denied");
  assert.equal((await checkSession(undefined)).state, "denied");
});

test("without APP_PASSWORD: one development session, closed in production", async () => {
  setEnv({ APP_PASSWORD: undefined, NODE_ENV: "development" });
  assert.deepEqual(await checkSession(undefined), { state: "ok", sessionId: DEV_SESSION_ID });
  setEnv({ NODE_ENV: "production" });
  assert.equal((await checkSession(undefined)).state, "misconfigured");
});

test("readCookie finds the session among other cookies", () => {
  const req = new Request("http://x/api/novels", { headers: { cookie: `a=1; ${SESSION_COOKIE}=abc.def; b=2` } });
  assert.equal(readCookie(req), "abc.def");
  assert.equal(readCookie(new Request("http://x/")), undefined);
});

test("safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});
