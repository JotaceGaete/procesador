// Shared by the E2E tests. Environment comes from tests/e2e/run.mjs.
import zlib from "node:zlib";
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

/** A real (grey) PNG of the given size. */
export function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The plain-text editor, chosen explicitly (as an author does with the switch): these tests drive
 * the textarea. The visual editor is the default (docs/editor-visual.md); the plain one stays as
 * the manual fallback, and these tests keep it covered.
 */
export const textEditor = (ctx) => ctx.addInitScript(() => localStorage.setItem("editor", "texto"));
