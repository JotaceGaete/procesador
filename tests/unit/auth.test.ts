import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkSession, createSessionToken, requireAuth, safeEqual, SESSION_COOKIE } from "@/lib/auth";

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

test("a signed session is valid; tampered, expired or foreign ones are not", async () => {
  setEnv({ APP_PASSWORD: "secreto" });
  const token = await createSessionToken("secreto");
  assert.equal(await checkSession(token), "ok");
  const [exp, sig] = token.split(".");
  assert.equal(await checkSession(`${Number(exp) + 1000}.${sig}`), "denied", "expiry can't be extended");
  assert.equal(await checkSession(`1000.${sig}`), "denied", "expired");
  assert.equal(await checkSession(await createSessionToken("otra")), "denied", "signed with another password");
  assert.equal(await checkSession(undefined), "denied");
});

test("without APP_PASSWORD: open in development, closed in production", async () => {
  setEnv({ APP_PASSWORD: undefined, NODE_ENV: "development" });
  assert.equal(await checkSession(undefined), "ok");
  setEnv({ NODE_ENV: "production" });
  assert.equal(await checkSession(undefined), "misconfigured");
  const res = await requireAuth(new Request("http://x/api/novels"));
  assert.equal(res?.status, 503);
});

test("requireAuth reads the cookie from the request", async () => {
  setEnv({ APP_PASSWORD: "secreto" });
  assert.equal((await requireAuth(new Request("http://x/api/novels")))?.status, 401);
  const cookie = `${SESSION_COOKIE}=${await createSessionToken("secreto")}`;
  assert.equal(await requireAuth(new Request("http://x/api/novels", { headers: { cookie } })), null);
});

test("safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});
