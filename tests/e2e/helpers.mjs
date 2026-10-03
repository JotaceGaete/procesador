// Shared by the E2E tests. Environment comes from tests/e2e/run.mjs.
export const BASE = process.env.E2E_BASE;
export const CLOSED = process.env.E2E_CLOSED;
export const STACK = process.env.E2E_STACK;
export const PASSWORD = process.env.E2E_PASSWORD;

if (!BASE) {
  console.error("Run the E2E tests with `npm run test:e2e` (it starts the stack).");
  process.exit(1);
}

export async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get("set-cookie").split(";")[0];
}

/** API client with a session. Returns { status, data } (data is text for NDJSON streams). */
export function client(cookie) {
  return async (path, method = "GET", json) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const type = res.headers.get("content-type") ?? "";
    const data =
      res.status === 204 ? null : type.includes("ndjson") || !type.includes("json") ? await res.text() : await res.json();
    return { status: res.status, data };
  };
}

/** Requests the mock AI providers received, oldest first. */
export const aiLog = async () => (await fetch(`${STACK}/__log`)).json();
export const clearAiLog = () => fetch(`${STACK}/__log/clear`);

/** Empties the database between test files (cascade from novels). */
export async function resetDb() {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/novels?id=not.is.null`, {
    method: "DELETE",
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`reset failed: ${res.status} ${await res.text()}`);
}

export const events = (ndjson) =>
  ndjson
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
