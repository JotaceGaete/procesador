#!/usr/bin/env node
// End-to-end test runner. Brings up a throwaway stack, runs tests/e2e/*.test.mjs,
// and tears everything down. Nothing external is created and no real keys are used.
//
//   Postgres (temporary cluster) ← PostgREST ← gateway at /rest/v1 (like Supabase)
//   In-memory Storage (tests/mock-storage.mjs) at /storage/v1, private buckets only
//   Mock Anthropic / OpenAI / xAI APIs (tests/mock-ai.mjs) on the same gateway
//   The app: `next build` + two `next start` servers
//     - main:   APP_PASSWORD set, all three providers pointing at the mocks
//     - closed: production without APP_PASSWORD (must answer 503 everywhere)
//
// Requirements: PostgreSQL binaries (initdb, pg_ctl, psql; set PG_BIN if not found),
// PostgREST (set POSTGREST_BIN, or it is downloaded once on Linux x64), and a
// Chromium for Playwright (`npx playwright install chromium` if missing).
//
// Options: E2E_SKIP_BUILD=1 reuses the current .next build. E2E_KEEP=1 keeps the
// stack running after the tests (Ctrl+C to stop).

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleAI } from "../mock-ai.mjs";
import { createStorage } from "../mock-storage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POSTGREST_VERSION = "v12.2.3";
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const procs = [];
let pg = null;

const log = (...a) => console.log("[e2e]", ...a);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function jwt(role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, iss: "e2e" })}`;
  return `${head}.${crypto.createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
}

function start(name, cmd, args, opts = {}) {
  const out = fs.openSync(path.join(opts.logDir, `${name}.log`), "w");
  const p = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    stdio: ["ignore", out, out],
    detached: true,
  });
  procs.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function findPgBin() {
  const candidates = [process.env.PG_BIN];
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"]).toString().trim());
  } catch {}
  if (fs.existsSync("/usr/lib/postgresql")) {
    for (const v of fs.readdirSync("/usr/lib/postgresql").sort().reverse()) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  candidates.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  const bin = candidates.find((d) => d && fs.existsSync(path.join(d, "initdb")));
  if (!bin) throw new Error("No se encontró PostgreSQL (initdb). Instálalo o define PG_BIN.");
  return bin;
}

/** initdb refuses to run as root: in that case run the server as the postgres user. */
function pgExec(bin, tool, args) {
  const full = path.join(bin, tool);
  if (process.getuid?.() === 0) {
    const quoted = [full, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    return execFileSync("su", ["postgres", "-s", "/bin/sh", "-c", quoted], { stdio: "pipe" });
  }
  return execFileSync(full, args, { stdio: "pipe" });
}

async function startPostgres(dir) {
  const bin = findPgBin();
  const port = await freePort();
  const data = path.join(dir, "pgdata");
  if (process.getuid?.() === 0) execFileSync("chown", ["-R", "postgres", dir]);
  pgExec(bin, "initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"]);
  pgExec(bin, "pg_ctl", [
    "-D",
    data,
    "-o",
    `-p ${port} -k ${dir} -c listen_addresses=''`,
    "-l",
    path.join(dir, "postgres.log"),
    "-w",
    "start",
  ]);
  pg = { bin, data, port, dir };
  const psql = (sql, file) =>
    execFileSync(
      path.join(bin, "psql"),
      [
        "-h",
        dir,
        "-p",
        String(port),
        "-U",
        "postgres",
        "-d",
        "app",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        ...(file ? ["-f", file] : ["-c", sql]),
      ],
      {
        stdio: "pipe",
        env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" },
      },
    );
  execFileSync(path.join(bin, "psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-q", "-c", "create database app"], {
    stdio: "pipe",
  });
  // The roles Supabase provides.
  psql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  const schema = path.join(ROOT, "supabase/schema.sql");
  psql(null, schema);
  psql(null, schema); // must be idempotent
  log(`postgres ${path.basename(path.dirname(bin))} on socket ${dir}:${port}, schema applied twice`);
  return { port, socketDir: dir };
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------

async function postgrestBin() {
  if (process.env.POSTGREST_BIN) return process.env.POSTGREST_BIN;
  const cacheDir = path.join(ROOT, "node_modules/.cache/procesador-e2e");
  const bin = path.join(cacheDir, `postgrest-${POSTGREST_VERSION}`);
  if (fs.existsSync(bin)) return bin;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Instala PostgREST y define POSTGREST_BIN (la descarga automática sólo cubre Linux x64).");
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-${POSTGREST_VERSION}-linux-static-x64.tar.xz`;
  log(`downloading PostgREST ${POSTGREST_VERSION}…`);
  const archive = path.join(cacheDir, "postgrest.tar.xz");
  execFileSync("curl", ["-sSfL", "-o", archive, url]);
  execFileSync("tar", ["xf", archive, "-C", cacheDir]);
  fs.renameSync(path.join(cacheDir, "postgrest"), bin);
  fs.rmSync(archive);
  return bin;
}

// ---------------------------------------------------------------------------
// Gateway: /rest/v1 → PostgREST (like Supabase), /storage/v1 → mock Storage, AI mocks, request log
// ---------------------------------------------------------------------------

function startGateway(port, postgrestPort) {
  const aiLog = [];
  const storage = createStorage(JWT_SECRET);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString();
      if (req.url.startsWith("/rest/v1/")) {
        const up = http.request(
          {
            host: "127.0.0.1",
            port: postgrestPort,
            path: req.url.slice("/rest/v1".length),
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${postgrestPort}` },
          },
          (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
          },
        );
        up.on("error", () => (res.writeHead(502), res.end()));
        return up.end(raw);
      }
      if (storage.handle(req, res, raw)) return;
      if (req.url === "/__log") return res.end(JSON.stringify(aiLog));
      if (req.url === "/__log/clear") {
        aiLog.length = 0;
        return res.end("ok");
      }
      try {
        if (handleAI(req, res, body, aiLog)) return;
      } catch (e) {
        res.writeHead(500);
        return res.end(String(e));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

// ---------------------------------------------------------------------------

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "procesador-e2e-"));
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir);
  process.on("SIGINT", () => cleanup(dir).then(() => process.exit(130)));

  const db = await startPostgres(dir);

  const pgrstPort = await freePort();
  const pgrstConf = path.join(dir, "postgrest.conf");
  fs.writeFileSync(
    pgrstConf,
    `db-uri = "postgres://postgres@/app?host=${db.socketDir}&port=${db.port}"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${JWT_SECRET}"\nserver-host = "127.0.0.1"\nserver-port = ${pgrstPort}\n`,
  );
  start("postgrest", await postgrestBin(), [pgrstConf], { logDir });

  const gatewayPort = await freePort();
  const gateway = await startGateway(gatewayPort, pgrstPort);
  const STACK = `http://127.0.0.1:${gatewayPort}`;
  const keys = { service: jwt("service_role"), anon: jwt("anon") };
  await waitFor(`http://127.0.0.1:${pgrstPort}/`);
  log(`postgrest + mock AI gateway on ${STACK}`);

  if (process.env.E2E_SKIP_BUILD !== "1") {
    log("next build…");
    execFileSync(path.join(ROOT, "node_modules/.bin/next"), ["build"], { cwd: ROOT, stdio: "pipe" });
  }

  const appEnv = {
    ...process.env,
    NODE_ENV: "production",
    APP_PASSWORD: "secreto-e2e",
    SUPABASE_URL: STACK,
    SUPABASE_SERVICE_ROLE_KEY: keys.service,
    ANTHROPIC_API_KEY: "test-a",
    ANTHROPIC_BASE_URL: `${STACK}/anthropic`,
    OPENAI_API_KEY: "test-o",
    OPENAI_BASE_URL: `${STACK}/openai`,
    XAI_API_KEY: "test-x",
    XAI_BASE_URL: `${STACK}/xai`,
    AI_PROVIDER: "anthropic",
    // The Consejero answers with its own model; only the writing model has a price.
    ANTHROPIC_MODEL_ADVISE: "claude-consejero-e2e",
    AI_PRICES: JSON.stringify({ "claude-opus-5-5": { input: 5, cached: 0.5, output: 25 } }),
  };
  const mainPort = await freePort();
  const closedPort = await freePort();
  const next = path.join(ROOT, "node_modules/.bin/next");
  start("next", next, ["start", "-p", String(mainPort), "-H", "127.0.0.1"], { logDir, env: appEnv });
  const closedEnv = { ...appEnv };
  delete closedEnv.APP_PASSWORD;
  start("next-closed", next, ["start", "-p", String(closedPort), "-H", "127.0.0.1"], { logDir, env: closedEnv });
  await waitFor(`http://127.0.0.1:${mainPort}/login`);
  await waitFor(`http://127.0.0.1:${closedPort}/login`);
  log(`app on http://127.0.0.1:${mainPort} (closed variant on :${closedPort})`);

  const files = fs
    .readdirSync(path.join(ROOT, "tests/e2e"))
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => path.join("tests/e2e", f));
  const code = await new Promise((resolve) => {
    const t = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE: `http://127.0.0.1:${mainPort}`,
        E2E_CLOSED: `http://127.0.0.1:${closedPort}`,
        E2E_STACK: STACK,
        E2E_PASSWORD: appEnv.APP_PASSWORD,
        E2E_SERVICE_KEY: keys.service,
        E2E_ANON_KEY: keys.anon,
        E2E_NEXT_LOG: path.join(logDir, "next.log"),
      },
    });
    t.on("exit", resolve);
  });

  if (process.env.E2E_KEEP === "1") {
    log(`stack kept running (logs in ${logDir}); Ctrl+C to stop`);
    return;
  }
  gateway.close();
  await cleanup(dir);
  process.exit(code ?? 1);
}

async function cleanup(dir) {
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
  if (pg) {
    try {
      pgExec(pg.bin, "pg_ctl", ["-D", pg.data, "-m", "fast", "stop"]);
    } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch(async (e) => {
  console.error("[e2e] setup failed:", e.message);
  if (e.stderr?.length) console.error(e.stderr.toString());
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
  }
  if (pg) {
    try {
      pgExec(pg.bin, "pg_ctl", ["-D", pg.data, "-m", "fast", "stop"]);
    } catch {}
  }
  process.exit(1);
});
