// Security: sessions, fail-closed without APP_PASSWORD, database closed to the
// public key, no secrets in the browser bundle, no manuscript text in logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BASE, CLOSED, PASSWORD, STACK, client, login } from "./helpers.mjs";

const U = "00000000-0000-0000-0000-000000000000";
const ROUTES = [
  ["GET", "/api/novels"],
  ["POST", "/api/novels"],
  ["GET", `/api/novels/${U}`],
  ["PATCH", `/api/novels/${U}`],
  ["DELETE", `/api/novels/${U}`],
  ["POST", `/api/novels/${U}/duplicate`],
  ["POST", `/api/novels/${U}/chapters`],
  ["PUT", `/api/novels/${U}/chapters`],
  ["POST", `/api/novels/${U}/memory/facts`],
  ["GET", `/api/chapters/${U}`],
  ["PATCH", `/api/chapters/${U}`],
  ["DELETE", `/api/chapters/${U}`],
  ["PATCH", `/api/memory/characters/${U}`],
  ["DELETE", `/api/memory/facts/${U}`],
  ["POST", "/api/assist"],
];
const hit = (base, method, route, headers = {}) =>
  fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
    redirect: "manual",
  });

test("every API route answers 401 without a session", async () => {
  for (const [method, route] of ROUTES) {
    assert.equal((await hit(BASE, method, route)).status, 401, `${method} ${route}`);
  }
});

test("forged, tampered and expired session cookies are rejected", async () => {
  const valid = (await login()).split("=")[1];
  const [exp, sig] = valid.split(".");
  for (const token of [`9999999999999.${"0".repeat(64)}`, `${Number(exp) + 1}.${sig}`, `1000.${sig}`, "garbage"]) {
    assert.equal((await hit(BASE, "GET", "/api/novels", { cookie: `procesador_session=${token}` })).status, 401, token);
  }
  assert.equal((await hit(BASE, "GET", "/api/novels", { cookie: `procesador_session=${valid}` })).status, 200);
});

test("pages redirect to /login without a session", async () => {
  for (const page of ["/", `/novela/${U}`]) {
    const res = await hit(BASE, "GET", page);
    assert.equal(res.status, 307);
    assert.match(res.headers.get("location"), /\/login$/);
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
  for (const table of ["novels", "chapters", "characters", "relationships", "places", "facts", "fact_characters"]) {
    const res = await fetch(`${STACK}/rest/v1/${table}`, { headers });
    assert.ok([401, 403].includes(res.status), `${table}: ${res.status}`);
  }
  const rpc = await fetch(`${STACK}/rest/v1/rpc/library`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  assert.ok([401, 403].includes(rpc.status), `rpc: ${rpc.status}`);
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
