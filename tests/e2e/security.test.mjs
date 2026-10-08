// Security: sessions, fail-closed without APP_PASSWORD, database closed to the
// public key, no secrets in the browser bundle, no manuscript text in logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BASE, CLOSED, PASSWORD, STACK, client, login } from "./helpers.mjs";
import { ROUTES, routeUrl } from "./routes.mjs";

const U = "00000000-0000-4000-8000-000000000000";
const IDS = new Proxy({}, { get: () => U });
// Every route but the ones before a session (tests/e2e/routes.mjs, complete per tests/unit/routes.test.ts).
const GUARDED = ROUTES.filter((r) => r.scope !== "open").map((r) => [r.method, routeUrl(r, IDS)]);
const hit = (base, method, route, headers = {}) =>
  fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
    redirect: "manual",
  });

test("every API route answers 401 without a session", async () => {
  assert.ok(GUARDED.length > 60);
  for (const [method, route] of GUARDED) {
    assert.equal((await hit(BASE, method, route)).status, 401, `${method} ${route}`);
  }
});

test("forged, tampered, expired and old-format session cookies are rejected", async () => {
  const valid = (await login()).split("=")[1];
  const [sid, exp, sig] = valid.split(".");
  for (const token of [
    `${sid}.9999999999999.${"0".repeat(64)}`,
    `${sid}.${Number(exp) + 1}.${sig}`,
    `${sid}.1000.${sig}`,
    `${U}.${exp}.${sig}`,
    `${exp}.${sig}`, // the format before session ids
    "garbage",
  ]) {
    assert.equal((await hit(BASE, "GET", "/api/novels", { cookie: `procesador_session=${token}` })).status, 401, token);
  }
  assert.equal((await hit(BASE, "GET", "/api/novels", { cookie: `procesador_session=${valid}` })).status, 200);
});

test("a validly signed cookie for a session that doesn't exist is rejected", async () => {
  // Signed like the server does, for an id that was never opened (or was purged).
  const crypto = await import("node:crypto");
  const exp = Date.now() + 60_000;
  const sig = crypto.createHmac("sha256", PASSWORD).update(`session:${U}:${exp}`).digest("hex");
  assert.equal((await hit(BASE, "GET", "/api/novels", { cookie: `procesador_session=${U}.${exp}.${sig}` })).status, 401);
});

test("pages redirect to /login without a session, carrying where the author was going", async () => {
  for (const [page, next] of [["/", null], [`/novela/${U}`, `/novela/${U}`], [`/novela/${U}?editor=visual`, `/novela/${U}?editor=visual`]]) {
    const res = await hit(BASE, "GET", page);
    assert.equal(res.status, 307);
    const to = new URL(res.headers.get("location"), BASE);
    assert.equal(to.pathname, "/login");
    assert.equal(to.searchParams.get("next"), next, page);
  }
});

test("login: wrong password is slow and rejected; cookie is HttpOnly and SameSite=Strict", async () => {
  const t0 = Date.now();
  const bad = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "x" }),
  });
  assert.equal(bad.status, 401);
  assert.ok(Date.now() - t0 >= 900);
  const ok = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=strict/i);
});

test("production without APP_PASSWORD is closed (503), pages and API alike", async () => {
  for (const [method, route] of [
    ["GET", "/"],
    ["GET", "/api/novels"],
    ["POST", "/api/assist"],
    ["POST", "/api/login"],
  ]) {
    assert.equal((await hit(CLOSED, method, route)).status, 503, `${method} ${route}`);
  }
});

test("the public (anon) key can't read tables or call functions", async () => {
  const key = process.env.E2E_ANON_KEY;
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  for (const table of [
    "novels",
    "chapters",
    "characters",
    "relationships",
    "places",
    "facts",
    "fact_characters",
    "assets",
    "character_images",
    "manuscript_images",
    "ai_usage",
    "story_threads",
    "chapter_digests",
    "novel_digests",
    "advisor_conversations",
    "advisor_messages",
    "advisor_observations",
    "chapter_versions",
    "app_settings",
    "app_sessions",
    "credential_attempts",
  ]) {
    const res = await fetch(`${STACK}/rest/v1/${table}`, { headers });
    assert.ok([401, 403].includes(res.status), `${table}: ${res.status}`);
  }
  const rpc = await fetch(`${STACK}/rest/v1/rpc/library`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  assert.ok([401, 403].includes(rpc.status), `rpc: ${rpc.status}`);
  for (const fn of [
    "delete_unused_assets",
    "sweep_assets",
    "set_primary_image",
    "reorder_character_images",
    "replace_asset_uses",
    "sync_chapter_images",
    "finalize_asset",
    "save_chapter_version",
    "trash_chapter",
    "chapter_trash",
    "restore_chapter",
    "session_touch",
    "session_set_locked",
    "session_revoke",
    "credential_failure",
    "credential_success",
    "purge_sessions",
  ]) {
    const res = await fetch(`${STACK}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    assert.ok([401, 403, 404].includes(res.status), `${fn}: ${res.status}`);
  }
});

test("files: the bucket is private and closed to the public key", async () => {
  const cookie = await login();
  const call = client(cookie);
  const novel = (await call("/api/novels", "POST", { title: "Archivos privados" })).data.id;
  const start = await call(`/api/novels/${novel}/assets`, "POST", { type: "image/png", bytes: 10 });
  assert.equal(start.status, 201);
  const path = new URL(start.data.upload_url).pathname.replace("/storage/v1/object/upload/sign/novel-files/", "");
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: "0123456789" });

  const key = process.env.E2E_ANON_KEY;
  const anon = { apikey: key, authorization: `Bearer ${key}` };
  const tries = [
    fetch(`${STACK}/storage/v1/object/novel-files/${path}`, { headers: anon }),
    fetch(`${STACK}/storage/v1/object/public/novel-files/${path}`),
    fetch(`${STACK}/storage/v1/object/novel-files/${path}`),
    fetch(`${STACK}/storage/v1/object/list/novel-files`, {
      method: "POST",
      headers: { ...anon, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "" }),
    }),
    fetch(`${STACK}/storage/v1/object/upload/sign/novel-files/${novel}/x.png`, { method: "POST", headers: anon }),
  ];
  for (const res of await Promise.all(tries)) assert.notEqual(res.status, 200, res.url);
  await call(`/api/novels/${novel}`, "DELETE");
});

test("no keys or key names in the browser bundle", () => {
  const dir = path.resolve(".next/static");
  const offenders = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (
        /\.(js|json|txt)$/.test(f.name) &&
        /test-a|test-o|test-x|SERVICE_ROLE|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|eyJhbGci/.test(fs.readFileSync(p, "utf8"))
      )
        offenders.push(p);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});

test("manuscript text never reaches the server log", async () => {
  // Write recognisable text through every path that touches it, then read the log.
  const call = client(await login());
  const { id } = (await call("/api/novels", "POST", { title: "Privada" })).data;
  const ch = (await call(`/api/novels/${id}`)).data.chapters[0].id;
  const secret = "FRASE-PRIVADA-DEL-MANUSCRITO";
  await call(`/api/chapters/${ch}`, "PATCH", { content: `${secret} uno dos.`, revision: 0 });
  await call(`/api/chapters/${ch}`, "PATCH", { content: `${secret} conflicto`, revision: 0 }); // 409
  await call("/api/assist", "POST", {
    novelId: id,
    chapterId: ch,
    content: `${secret} uno dos.`,
    provider: "anthropic",
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: 10,
  });
  await call("/api/assist", "POST", {
    novelId: id,
    chapterId: ch,
    content: `${secret}`,
    provider: "nope",
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: 5,
  });
  await call(`/api/novels/${id}`, "DELETE");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.readFileSync(process.env.E2E_NEXT_LOG, "utf8").includes(secret));
});
