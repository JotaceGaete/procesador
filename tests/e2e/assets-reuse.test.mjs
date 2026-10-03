// Repeated files and replacing a file (docs/archivos.md), end to end against
// Postgres + PostgREST and the in-memory Storage. Tests run in order and share state.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BASE, STACK, client, login, png, resetDb } from "./helpers.mjs";

let call, cookie;
const s = {};
const key = process.env.E2E_SERVICE_KEY;
const service = { apikey: key, authorization: `Bearer ${key}` };

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const filesOf = async (novel) =>
  (await (await fetch(`${STACK}/__storage`)).json()).keys.filter((k) => k.startsWith(`novel-files/${novel}/`));
const assetRows = async (novel) =>
  (await fetch(`${STACK}/rest/v1/assets?novel_id=eq.${novel}&select=id,status,sha256`, { headers: service })).json();
const images = async (novel) => (await call(`/api/novels/${novel}`)).data.images;
const use = (id) => images(s.A).then((list) => list.find((i) => i.id === id));

const start = (novel, file, withHash = true) =>
  call(`/api/novels/${novel}/assets`, "POST", {
    file_name: "f.png",
    type: "image/png",
    bytes: file.length,
    ...(withHash ? { sha256: sha(file) } : {}),
  });

async function complete(assetId, json) {
  const form = new FormData();
  form.append("display", new Blob([png(64, 48)]));
  form.append("thumb", new Blob([png(32, 24)]));
  form.append("use", JSON.stringify(json));
  const res = await fetch(`${BASE}/api/assets/${assetId}/complete`, { method: "POST", headers: { cookie }, body: form });
  return { status: res.status, data: await res.json() };
}

/** Full upload of a file the novel doesn't have yet (no duplicate check, like an old client). */
async function upload(novel, file, json) {
  const st = await start(novel, file, false);
  assert.equal(st.status, 201, JSON.stringify(st.data));
  const put = await fetch(st.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: file });
  assert.equal(put.status, 200);
  const done = await complete(st.data.asset_id, json);
  assert.equal(done.status, 201, JSON.stringify(done.data));
  return done.data;
}

const X = png(1000, 700);
const Y = png(700, 1000);
const Z = png(900, 900);
const W = png(1200, 800);

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  s.A = (await call("/api/novels", "POST", { title: "A" })).data.id;
  s.B = (await call("/api/novels", "POST", { title: "B" })).data.id;
  const character = async (novel, name) => (await call(`/api/novels/${novel}/memory/characters`, "POST", { name })).data.id;
  s.erika = await character(s.A, "Erika");
  s.juan = await character(s.A, "Juan");
  s.otro = await character(s.B, "Otro");
});

// ---------------------------------------------------------------- repeated files

test("the server stores its own hash of every original", async () => {
  const r = await upload(s.A, X, { kind: "character", character_id: s.erika, caption: "En el puerto", stage_label: "1982" });
  s.aX = r.asset_id;
  s.e1 = r.images[0].id;
  assert.equal(r.reused, false);
  const [row] = await assetRows(s.A);
  assert.equal(row.sha256, sha(X), "computed from the stored bytes, not sent by the browser");
});

test("repeated file, before uploading: the novel's existing file and its uses come back; nothing is created", async () => {
  const before = await filesOf(s.A);
  const r = await start(s.A, X);
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate.asset.id, s.aX);
  assert.deepEqual(r.data.duplicate.uses, [{ kind: "character", character_id: s.erika, character_image_id: s.e1 }]);
  assert.ok(!("upload_url" in r.data));
  assert.deepEqual(await filesOf(s.A), before);
  assert.equal((await assetRows(s.A)).length, 1, "no pending file created");
});

test("repeated file, caught when completing: the new copy is discarded and the existing file used", async () => {
  const before = await filesOf(s.A);
  const r = await upload(s.A, X, { kind: "character", character_id: s.juan });
  assert.equal(r.reused, true);
  assert.equal(r.asset_id, s.aX);
  assert.equal(r.images[0].asset_id, s.aX);
  s.j1 = r.images[0].id;
  assert.deepEqual(await filesOf(s.A), before, "still one physical copy");
  assert.equal((await assetRows(s.A)).length, 1);
});

test("reusing a file in a gallery adds a use, never a copy", async () => {
  const before = await filesOf(s.A);
  const r = await call(`/api/characters/${s.juan}/images`, "POST", { asset_id: s.aX });
  assert.equal(r.status, 201);
  s.j2 = r.data[1].id;
  assert.deepEqual(await filesOf(s.A), before);
});

test("repeated files are only matched within a novel", async () => {
  const r = await start(s.B, X);
  assert.equal(r.status, 201, "novel B gets its own copy");
  assert.ok(r.data.upload_url);
  // A hash claimed for a different size never matches.
  const wrong = await call(`/api/novels/${s.A}/assets`, "POST", { type: "image/png", bytes: X.length + 1, sha256: sha(X) });
  assert.equal(wrong.status, 201);
});

// ---------------------------------------------------------------- replacing

test("replace this image only: a shared file stays with its other uses; the image keeps its texts, order and main status", async () => {
  await upload(s.A, Y, { kind: "character", character_id: s.erika });
  const before = await use(s.e1);
  const r = await upload(s.A, Z, { kind: "replace", character_image_id: s.e1, scope: "use" });
  assert.equal(r.reused, false);
  const after = r.images.find((i) => i.id === s.e1);
  assert.notEqual(after.asset_id, s.aX);
  assert.deepEqual(
    [after.caption, after.stage_label, after.is_primary, after.sort_order],
    [before.caption, before.stage_label, true, before.sort_order],
  );
  assert.deepEqual([after.asset.width, after.asset.height], [900, 900], "the new original, untouched");
  s.aZ = after.asset_id;
  // Juan's two images still use the old file, which is still stored.
  for (const id of [s.j1, s.j2]) assert.equal(r.images.find((i) => i.id === id).asset_id, s.aX);
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.aX)));
  assert.ok(r.images.every((i) => i.novel_id === s.A), "the whole novel's images come back");
});

test("replace in every use: all uses of the file change, and the old file goes", async () => {
  const r = await upload(s.A, W, { kind: "replace", character_image_id: s.j1, scope: "all" });
  const j1 = r.images.find((i) => i.id === s.j1);
  const j2 = r.images.find((i) => i.id === s.j2);
  s.aW = j1.asset_id;
  assert.equal(j2.asset_id, s.aW, "Juan's other image with that file changed too");
  assert.equal(r.images.find((i) => i.id === s.e1).asset_id, s.aZ, "Erika's image (another file) untouched");
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(s.aX)), "no uses left: original and derivatives removed");
  assert.ok(!(await assetRows(s.A)).some((a) => a.id === s.aX));
});

test("replace with a file the novel already has: nothing uploaded, the image just points to it", async () => {
  const before = (await filesOf(s.A)).length;
  const dup = await start(s.A, W);
  assert.equal(dup.data.duplicate.asset.id, s.aW);
  const r = await call(`/api/character-images/${s.e1}/replace`, "POST", { asset_id: s.aW, scope: "use" });
  assert.equal(r.status, 200);
  assert.equal(r.data.images.find((i) => i.id === s.e1).asset_id, s.aW);
  assert.ok(!(await assetRows(s.A)).some((a) => a.id === s.aZ), "Z had no other use");
  assert.equal((await filesOf(s.A)).length, before - 3);
  // Same file again: nothing changes.
  const again = await call(`/api/character-images/${s.e1}/replace`, "POST", { asset_id: s.aW, scope: "use" });
  assert.equal(again.data.images.find((i) => i.id === s.e1).asset_id, s.aW);
  assert.equal((await filesOf(s.A)).length, before - 3);
});

test("replace: validation and isolation between novels", async () => {
  const other = await upload(s.B, Y, { kind: "character", character_id: s.otro });
  const r = (json) => call(`/api/character-images/${s.e1}/replace`, "POST", json);
  assert.equal((await r({ asset_id: s.aW, scope: "everything" })).status, 400);
  assert.equal((await r({ asset_id: other.asset_id, scope: "use" })).status, 400, "a file of novel B");
  assert.equal((await r({ asset_id: "00000000-0000-0000-0000-000000000000", scope: "use" })).status, 404);
  assert.equal(
    (await call(`/api/character-images/00000000-0000-0000-0000-000000000000/replace`, "POST", { asset_id: s.aW, scope: "use" })).status,
    404,
  );
  assert.equal((await use(s.e1)).asset_id, s.aW, "nothing changed");
  assert.ok((await filesOf(s.B)).some((k) => k.includes(other.asset_id)), "B keeps its file");
});
