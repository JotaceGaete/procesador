// No API route can skip the session or a novel's lock (docs/privacidad.md).
// Every exported method of every route.ts is checked here, and must also be listed in
// tests/e2e/routes.mjs, which the E2E security tests hit in every state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain ESM shared with the E2E tests
import { ROUTES } from "../e2e/routes.mjs";

const API = path.resolve("src/app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Routes that touch no novel's data: they still require the session. */
const SESSION_ONLY = new Set(["novels", "session", "session/ping", "session/lock", "session/unlock", "settings"]);
/** Before or outside a session. */
const OPEN = new Set(["login", "logout", "version"]);

function routeFiles(dir = API): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

const routes = routeFiles().map((file) => {
  const route = path.relative(API, path.dirname(file)).split(path.sep).join("/");
  const source = fs.readFileSync(file, "utf8");
  const methods = METHODS.flatMap((m) => {
    const match = source.match(new RegExp(`export (?:const ${m}\\s*=\\s*([A-Za-z]+)|(?:async )?function ${m}\\b)`));
    return match ? [{ method: m, wrapper: match[1] ?? "function" }] : [];
  });
  return { route, source, methods };
});

test("every novel route goes through novelHandler (authorizeNovel), the rest through handler", () => {
  assert.ok(routes.length > 40, "found the routes");
  for (const { route, methods } of routes) {
    assert.ok(methods.length, `${route}: exports a method`);
    for (const { method, wrapper } of methods) {
      const expected = OPEN.has(route) ? "function" : SESSION_ONLY.has(route) ? "handler" : "novelHandler";
      assert.equal(wrapper, expected, `${method} /api/${route}`);
    }
  }
});

test("no route checks the session by itself, around the wrappers", () => {
  for (const { route, source } of routes) {
    if (OPEN.has(route)) continue;
    assert.doesNotMatch(source, /import \{[^}]*\b(checkSession|readCookie)\b[^}]*\} from "@\/lib\/auth"/, route);
  }
});

test("every method of every route is in the E2E list (tests/e2e/routes.mjs)", () => {
  const listed = new Set((ROUTES as { method: string; route: string }[]).map((r) => `${r.method} ${r.route}`));
  const found = routes.flatMap(({ route, methods }) => methods.map((m) => `${m.method} ${route}`));
  for (const r of found) assert.ok(listed.has(r), `${r} falta en tests/e2e/routes.mjs`);
  for (const r of listed) assert.ok(found.includes(r), `${r} está en tests/e2e/routes.mjs pero no existe`);
});
