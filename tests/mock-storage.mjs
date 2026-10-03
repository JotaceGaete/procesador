// In-memory stand-in for Supabase Storage, mounted at /storage/v1 on the E2E gateway.
// It implements the calls the app makes (upload, download with Range, remove, copy,
// list, signed upload URLs, signed download URLs) and enforces what matters for the
// tests: buckets are private, only a service_role JWT can read or write, and a signed
// upload URL works once, for its own path, before it expires.
import crypto from "node:crypto";

export function createStorage(jwtSecret, buckets = { "novel-files": { public: false } }) {
  const objects = new Map(); // "bucket/path" → { bytes, contentType }
  const uploadTokens = new Map(); // token → { key, expires, used }
  const downloadTokens = new Map(); // token → { key, expires }
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
    // Like Supabase: the browser uploads originals cross-origin with a signed URL.
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, apikey, content-type, x-upsert, cache-control",
      });
      return res.end(), true;
    }

    // Public URLs: every bucket here is private.
    const pub = route.match(/^\/object\/public\/([^/]+)\//);
    if (pub) return err(res, 400, "Bucket not found", "Bucket is not public"), true;

    // Uploads with a signed URL: no key needed, but the token must match the path, be unused and unexpired.
    const signedUp = route.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/);
    if (signedUp && req.method === "PUT") {
      const key = `${signedUp[1]}/${signedUp[2]}`;
      const t = uploadTokens.get(url.searchParams.get("token"));
      if (!t || t.key !== key || t.used || t.expires < Date.now()) {
        return err(res, 400, "InvalidSignature", "The signature is invalid or was used"), true;
      }
      if (objects.has(key)) return err(res, 409, "Duplicate", "The resource already exists"), true;
      t.used = true;
      log.push(`PUT (signed) ${route}`);
      objects.set(key, { bytes: Buffer.from(body), contentType: req.headers["content-type"] ?? "application/octet-stream" });
      return send(res, 200, { Key: key }), true;
    }
    // Downloads with a signed URL.
    const signedDown = route.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
    if (signedDown && req.method === "GET") {
      const key = `${signedDown[1]}/${signedDown[2]}`;
      const t = downloadTokens.get(url.searchParams.get("token"));
      if (!t || t.key !== key || t.expires < Date.now()) return err(res, 400, "InvalidSignature", "Invalid signature"), true;
      const o = objects.get(key);
      if (!o) return err(res, 404, "not_found", "Object not found"), true;
      const name = url.searchParams.get("download");
      return send(res, 200, o.bytes, {
        "content-type": o.contentType,
        ...(name !== null ? { "content-disposition": `attachment; filename="${name || key.split("/").pop()}"` } : {}),
      }), true;
    }

    if (role(req) !== "service_role") return err(res, 403, "Unauthorized", "new row violates row-level security policy"), true;
    log.push(`${req.method} ${route}`);

    // Create signed URLs (service_role only).
    const signUp = route.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/);
    if (signUp && req.method === "POST") {
      const token = crypto.randomBytes(16).toString("hex");
      uploadTokens.set(token, { key: `${signUp[1]}/${signUp[2]}`, expires: Date.now() + 2 * 3600_000, used: false });
      return send(res, 200, { url: `/object/upload/sign/${signUp[1]}/${signUp[2]}?token=${token}` }), true;
    }
    const signDown = route.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
    if (signDown && req.method === "POST") {
      const key = `${signDown[1]}/${signDown[2]}`;
      if (!objects.has(key)) return err(res, 404, "not_found", "Object not found"), true;
      const token = crypto.randomBytes(16).toString("hex");
      downloadTokens.set(token, { key, expires: Date.now() + (json(body).expiresIn ?? 60) * 1000 });
      return send(res, 200, { signedURL: `/object/sign/${key}?token=${token}` }), true;
    }

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
        const range = (req.headers.range ?? "").match(/^bytes=(\d+)-(\d*)$/);
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(range[2] ? Number(range[2]) : o.bytes.length - 1, o.bytes.length - 1);
          return send(res, 206, o.bytes.subarray(start, end + 1), {
            "content-type": o.contentType,
            "content-range": `bytes ${start}-${end}/${o.bytes.length}`,
          }), true;
        }
        return send(res, 200, o.bytes, { "content-type": o.contentType }), true;
      }
    }
    return err(res, 404, "not_found", `Unsupported ${req.method} ${route}`), true;
  }

  return { handle };
}
