// In-memory stand-in for Supabase Storage, mounted at /storage/v1 on the E2E gateway.
// It implements the calls the app makes through supabase-js (upload, download,
// remove, copy, list) and enforces what matters for the tests: buckets are
// private, and only a service_role JWT can read or write.
import crypto from "node:crypto";

export function createStorage(jwtSecret, buckets = { "character-images": { public: false } }) {
  const objects = new Map(); // "bucket/path" → { bytes, contentType }
  const failures = new Map(); // op → remaining forced failures (test hook)
  const log = [];

  function role(req) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const [head, payload, sig] = token.split(".");
    if (!sig) return null;
    const expected = crypto.createHmac("sha256", jwtSecret).update(`${head}.${payload}`).digest("base64url");
    if (expected !== sig) return null;
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString()).role ?? null;
    } catch {
      return null;
    }
  }

  const send = (res, status, body, headers = {}) => {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, headers);
      return res.end(body);
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (res, status, error, message) => send(res, 400, { statusCode: String(status), error, message });
  const json = (body) => {
    try {
      return JSON.parse(body.toString() || "{}");
    } catch {
      return {};
    }
  };
  const shouldFail = (op) => {
    const n = failures.get(op) ?? 0;
    if (n > 0) failures.set(op, n - 1);
    return n > 0;
  };

  /** Returns true when the request was for Storage (handled here). */
  function handle(req, res, body) {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__storage") {
      return send(res, 200, { keys: [...objects.keys()].sort(), log }), true;
    }
    if (url.pathname === "/__storage/fail") {
      failures.set(url.searchParams.get("op"), Number(url.searchParams.get("times") ?? 1));
      return send(res, 200, { ok: true }), true;
    }
    if (!url.pathname.startsWith("/storage/v1/")) return false;
    const route = decodeURIComponent(url.pathname.slice("/storage/v1".length));

    // Public URLs: every bucket here is private.
    const pub = route.match(/^\/object\/public\/([^/]+)\//);
    if (pub) return err(res, 400, "Bucket not found", "Bucket is not public"), true;

    if (role(req) !== "service_role") return err(res, 403, "Unauthorized", "new row violates row-level security policy"), true;
    log.push(`${req.method} ${route}`);

    if (req.method === "POST" && route === "/object/copy") {
      const { bucketId, sourceKey, destinationKey } = json(body);
      if (shouldFail("copy")) return err(res, 500, "InternalError", "forced failure"), true;
      const src = objects.get(`${bucketId}/${sourceKey}`);
      if (!src) return err(res, 404, "not_found", "Object not found"), true;
      if (objects.has(`${bucketId}/${destinationKey}`)) return err(res, 409, "Duplicate", "The resource already exists"), true;
      objects.set(`${bucketId}/${destinationKey}`, { ...src });
      return send(res, 200, { Key: `${bucketId}/${destinationKey}` }), true;
    }

    const list = route.match(/^\/object\/list\/([^/]+)$/);
    if (req.method === "POST" && list) {
      const { prefix = "" } = json(body);
      const names = [...objects.keys()]
        .filter((k) => k.startsWith(`${list[1]}/${prefix}`))
        .map((k) => ({ name: k.slice(list[1].length + 1), id: k }));
      return send(res, 200, names), true;
    }

    const bucketOnly = route.match(/^\/object\/([^/]+)$/);
    if (req.method === "DELETE" && bucketOnly) {
      const removed = [];
      for (const p of json(body).prefixes ?? []) {
        if (objects.delete(`${bucketOnly[1]}/${p}`)) removed.push({ name: p });
      }
      return send(res, 200, removed), true;
    }

    const obj = route.match(/^\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/);
    if (obj) {
      const [, bucket, path] = obj;
      if (!buckets[bucket]) return err(res, 404, "Bucket not found", "Bucket not found"), true;
      const key = `${bucket}/${path}`;
      if (req.method === "POST" || req.method === "PUT") {
        if (shouldFail("upload")) return err(res, 500, "InternalError", "forced failure"), true;
        const upsert = req.method === "PUT" || req.headers["x-upsert"] === "true";
        if (objects.has(key) && !upsert) return err(res, 409, "Duplicate", "The resource already exists"), true;
        objects.set(key, { bytes: Buffer.from(body), contentType: req.headers["content-type"] ?? "application/octet-stream" });
        return send(res, 200, { Key: key, Id: crypto.randomUUID() }), true;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const o = objects.get(key);
        if (!o) return err(res, 404, "not_found", "Object not found"), true;
        return send(res, 200, o.bytes, { "content-type": o.contentType }), true;
      }
    }
    return err(res, 404, "not_found", `Unsupported ${req.method} ${route}`), true;
  }

  return { handle };
}
