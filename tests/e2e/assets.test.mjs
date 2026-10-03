// Novel files (docs/archivos.md) and the character gallery built on them, end to end
// against Postgres + PostgREST and the in-memory Storage (tests/mock-storage.mjs).
// Tests run in order and share state.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { BASE, STACK, aiLog, clearAiLog, client, events, login, png, resetDb } from "./helpers.mjs";

let call, cookie;
const s = {};

// ---------------------------------------------------------------- helpers

const storage = async () => (await (await fetch(`${STACK}/__storage`)).json()).keys;
const filesOf = async (novelId) => (await storage()).filter((k) => k.startsWith(`novel-files/${novelId}/`));

async function startUpload(novel, original, type = "image/png", name = "foto.png") {
  return call(`/api/novels/${novel}/assets`, "POST", { file_name: name, type, bytes: original.length });
}

async function complete(assetId, use, { display = png(64, 48), thumb = png(32, 24) } = {}) {
  const form = new FormData();
  form.append("display", new Blob([display]), "display.png");
  form.append("thumb", new Blob([thumb]), "thumb.png");
  form.append("use", JSON.stringify(use));
  const res = await fetch(`${BASE}/api/assets/${assetId}/complete`, { method: "POST", headers: { cookie }, body: form });
  return { status: res.status, data: await res.json() };
}

/** The whole flow: start, PUT the original to the signed URL, complete with a use. */
async function upload(novel, characterId, { original = png(3000, 2000), caption = "", stage_label = "" } = {}) {
  const start = await startUpload(novel, original);
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const put = await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: original });
  assert.equal(put.status, 200, await put.text());
  const done = await complete(start.data.asset_id, { kind: "character", character_id: characterId, caption, stage_label });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  return { assetId: start.data.asset_id, images: done.data.images, original };
}

const get = (path, headers = {}) => fetch(BASE + path, { headers: { cookie, ...headers }, redirect: "manual" });
const url = (assetId, variant, v = 1) => `/api/assets/${assetId}/${variant}?v=${v}`;
const primaries = (images) => images.filter((i) => i.is_primary).map((i) => i.id);

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  s.A = (await call("/api/novels", "POST", { title: "Novela A" })).data.id;
  s.B = (await call("/api/novels", "POST", { title: "Novela B" })).data.id;
  const character = async (novel, name) => (await call(`/api/novels/${novel}/memory/characters`, "POST", { name })).data.id;
  s.erika = await character(s.A, "Erika");
  s.juan = await character(s.A, "Juan");
  s.otro = await character(s.B, "Otro");
});

// ---------------------------------------------------------------- upload

test("upload: the original is kept as uploaded, with display and thumbnail derivatives", async () => {
  const r = await upload(s.A, s.erika, { caption: "Vestido del baile", stage_label: "1982" });
  s.a1 = r.assetId;
  s.orig1 = r.original;
  assert.equal(r.images.length, 1);
  const [img] = r.images;
  s.i1 = img.id;
  assert.equal(img.is_primary, true, "the first image is the main one");
  assert.equal(img.caption, "Vestido del baile");
  assert.equal(img.stage_label, "1982");
  assert.deepEqual([img.asset.width, img.asset.height], [3000, 2000], "size of the original, not of the 2048 px derivative");
  assert.equal(img.asset.original_type, "image/png");
  assert.equal(img.asset.original_bytes, r.original.length);
  assert.equal(img.asset.file_name, "foto.png");
  assert.ok(!("original_path" in img.asset), "storage paths never reach the browser");
  const files = await filesOf(s.A);
  for (const f of ["original.png", "display.png", "thumb.png"]) {
    assert.ok(files.includes(`novel-files/${s.A}/${s.a1}/v1/${f}`), f);
  }
});

test("upload: the signed URL works once, and only for its own path", async () => {
  const original = png(10, 10);
  const start = await startUpload(s.A, original);
  const put = (u) => fetch(u, { method: "PUT", headers: { "content-type": "image/png" }, body: original });
  const other = start.data.upload_url.replace(start.data.asset_id, "00000000-0000-0000-0000-000000000000");
  assert.notEqual((await put(other)).status, 200, "the token is bound to its path");
  assert.equal((await put(start.data.upload_url)).status, 200);
  assert.notEqual((await put(start.data.upload_url)).status, 200, "single use");
  s.pendingWithFile = start.data.asset_id;
});

test("upload: start validates type and size", async () => {
  const r = (json) => call(`/api/novels/${s.A}/assets`, "POST", json);
  assert.equal((await r({ type: "image/gif", bytes: 10 })).status, 400);
  assert.equal((await r({ type: "image/png", bytes: 0 })).status, 400);
  assert.equal((await r({ type: "image/png", bytes: 50 * 1024 * 1024 + 1 })).status, 413);
  assert.equal((await call(`/api/novels/00000000-0000-0000-0000-000000000000/assets`, "POST", { type: "image/png", bytes: 1 })).status, 404);
});

test("upload: complete checks the original from its bytes and cleans up a bad one", async () => {
  const use = { kind: "character", character_id: s.erika };
  // Nothing uploaded yet.
  const empty = await startUpload(s.A, png(5, 5));
  assert.equal((await complete(empty.data.asset_id, use)).status, 400);

  // Declared PNG, actually text: rejected, row and file removed.
  const fake = Buffer.from("esto no es una imagen, aunque diga image/png");
  const start = await startUpload(s.A, fake);
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: fake });
  const r = await complete(start.data.asset_id, use);
  assert.equal(r.status, 400);
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(start.data.asset_id)), "the bad original is deleted");
  assert.equal((await complete(start.data.asset_id, use)).status, 404, "and so is its row");

  // Derivatives are checked too.
  const bad = await complete(s.pendingWithFile, use, { display: Buffer.from("x"), thumb: png(10, 10) });
  assert.equal(bad.status, 400);
  const big = await complete(s.pendingWithFile, use, { display: png(2049, 10), thumb: png(10, 10) });
  assert.equal(big.status, 400, "display version above 2048 px");
  const huge = await complete(s.pendingWithFile, use, { display: png(100, 100), thumb: png(481, 10) });
  assert.equal(huge.status, 400, "thumbnail above 480 px");
});

test("upload: a completed file can't be completed again", async () => {
  assert.equal((await complete(s.a1, { kind: "character", character_id: s.erika })).status, 409);
});

// ---------------------------------------------------------------- serving & cache

test("serving: derivatives with a short private cache, ETag revalidation, versioned URL", async () => {
  const res = await get(url(s.a1, "thumb"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "private, max-age=600, must-revalidate");
  const etag = res.headers.get("etag");
  assert.equal(etag, `"${s.a1}-v1-thumb"`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png(32, 24));
  assert.equal((await get(url(s.a1, "thumb"), { "if-none-match": etag })).status, 304);
  assert.equal((await get(url(s.a1, "display"))).status, 200);
  assert.equal((await get(url(s.a1, "thumb", 2))).status, 404, "another version");
  assert.equal((await get(`/api/assets/${s.a1}/thumb`)).status, 404, "no version");
  assert.equal((await get(url(s.a1, "big"))).status, 404, "unknown variant");
  assert.equal((await get(url(s.pendingWithFile, "thumb"))).status, 404, "pending files are never served");
});

test("serving: the original downloads through a short-lived signed link, never cached", async () => {
  const res = await get(url(s.a1, "original"));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const file = await fetch(res.headers.get("location"));
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /attachment; filename="foto.png"/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), s.orig1);
});

// ---------------------------------------------------------------- gallery

test("gallery: one main image, set atomically", async () => {
  await upload(s.A, s.erika, { original: png(800, 600) });
  const third = await upload(s.A, s.erika, { original: png(600, 800) });
  s.a3 = third.assetId;
  let images = third.images;
  assert.equal(images.length, 3);
  assert.deepEqual(primaries(images), [s.i1]);
  assert.deepEqual(images.map((i) => i.sort_order), [1, 2, 3], "new images go last");
  s.i3 = images[2].id;
  images = (await call(`/api/character-images/${s.i3}/primary`, "POST")).data;
  assert.deepEqual(primaries(images), [s.i3]);
  assert.equal((await call(`/api/character-images/00000000-0000-0000-0000-000000000000/primary`, "POST")).status, 404);
});

test("gallery: the database itself refuses a second main image", async () => {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/character_images?id=eq.${s.i1}`, {
    method: "PATCH",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ is_primary: true }),
  });
  assert.equal(res.status, 409, "unique index character_images_one_primary");
});

test("gallery: order takes the complete list of that character's images", async () => {
  const images = (await call(`/api/novels/${s.A}`)).data.images.filter((i) => i.character_id === s.erika);
  const ids = images.map((i) => i.id).reverse();
  const r = await call(`/api/characters/${s.erika}/images`, "PUT", { ids });
  assert.deepEqual(r.data.map((i) => i.id), ids);
  assert.equal((await call(`/api/characters/${s.erika}/images`, "PUT", { ids: ids.slice(1) })).status, 400, "incomplete");
  assert.equal((await call(`/api/characters/${s.erika}/images`, "PUT", { ids: [...ids, ids[0]] })).status, 400, "repeated");
  assert.equal((await call(`/api/characters/${s.juan}/images`, "PUT", { ids })).status, 400, "another character's images");
  assert.equal((await call(`/api/characters/${s.erika}/images`, "PUT", { ids: ["x"] })).status, 400);
});

test("gallery: caption and stage label", async () => {
  const r = await call(`/api/character-images/${s.i1}`, "PATCH", { caption: "  Con el pelo corto ", stage_label: "época universitaria" });
  const img = r.data.find((i) => i.id === s.i1);
  assert.equal(img.caption, "Con el pelo corto");
  assert.equal(img.stage_label, "época universitaria");
  assert.equal((await call(`/api/character-images/${s.i1}`, "PATCH", {})).status, 400);
});

// ---------------------------------------------------------------- shared files

test("shared file: reused in another gallery without copying the file", async () => {
  const before = (await filesOf(s.A)).length;
  const r = await call(`/api/characters/${s.juan}/images`, "POST", { asset_id: s.a1, caption: "La foto del puerto" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data[0].asset_id, s.a1);
  assert.equal(r.data[0].is_primary, true);
  s.juanUse = r.data[0].id;
  assert.equal((await filesOf(s.A)).length, before, "no physical duplicate");
  assert.equal((await call(`/api/characters/${s.juan}/images`, "POST", { asset_id: s.pendingWithFile })).status, 404, "pending files can't be used");
});

test("safe deletion: a file is deleted only when its last use goes", async () => {
  // Erika stops using it: Juan still does.
  let r = await call(`/api/character-images/${s.i1}`, "DELETE");
  assert.equal(r.status, 200);
  assert.ok(!r.data.some((i) => i.id === s.i1));
  assert.equal((await get(url(s.a1, "thumb"))).status, 200, "still served: Juan uses it");
  assert.ok((await filesOf(s.A)).includes(`novel-files/${s.A}/${s.a1}/v1/original.png`));

  // Juan stops using it: no uses left, row and files go.
  r = await call(`/api/character-images/${s.juanUse}`, "DELETE");
  assert.deepEqual(r.data, []);
  assert.equal((await get(url(s.a1, "thumb"))).status, 404);
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(s.a1)), "original and derivatives removed");
  assert.equal((await call(`/api/character-images/${s.juanUse}`, "DELETE")).status, 404);
});

test("safe deletion: the database refuses to delete a file that is still in use", async () => {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/assets?id=eq.${s.a3}`, {
    method: "DELETE",
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  assert.equal(res.status, 409, "foreign key from character_images");
});

test("deleting the main image promotes the next one", async () => {
  const r = await call(`/api/character-images/${s.i3}`, "DELETE");
  assert.equal(r.data.length, 1);
  assert.deepEqual(primaries(r.data), [r.data[0].id]);
});

test("gallery limit: 40 images per character", async () => {
  const keep = await upload(s.A, s.juan, { original: png(20, 20) });
  for (let i = 1; i < 40; i++) {
    const r = await call(`/api/characters/${s.juan}/images`, "POST", { asset_id: keep.assetId });
    assert.equal(r.status, 201, `image ${i + 1}`);
  }
  const r = await call(`/api/characters/${s.juan}/images`, "POST", { asset_id: keep.assetId });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /40/);
  s.juanAsset = keep.assetId;
});

// ---------------------------------------------------------------- isolation

test("isolation: a file of one novel can't be used in another", async () => {
  const r = await call(`/api/characters/${s.otro}/images`, "POST", { asset_id: s.juanAsset });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  // Completing an upload of novel A into a character of novel B fails, and the new file is removed.
  const original = png(30, 30);
  const start = await startUpload(s.A, original);
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: original });
  const done = await complete(start.data.asset_id, { kind: "character", character_id: s.otro });
  assert.equal(done.status, 400);
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(start.data.asset_id)));
  assert.equal((await filesOf(s.B)).length, 0);
});

test("isolation: each novel only lists its own images", async () => {
  const a = (await call(`/api/novels/${s.A}`)).data;
  const b = (await call(`/api/novels/${s.B}`)).data;
  assert.ok(a.images.length > 0 && a.images.every((i) => i.novel_id === s.A));
  assert.deepEqual(b.images, []);
  assert.ok(!("images" in a.memory), "images are kept out of the memory the assistant uses");
});

test("the assistant never receives images, captions or labels", async () => {
  await call(`/api/character-images/${(await call(`/api/novels/${s.A}`)).data.images[0].id}`, "PATCH", {
    caption: "LEYENDA-VISUAL",
    stage_label: "ETAPA-VISUAL",
  });
  const ch = (await call(`/api/novels/${s.A}`)).data.chapters[0].id;
  await clearAiLog();
  const r = await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: ch,
    content: "Erika y Juan en el puerto.",
    provider: "anthropic",
    mode: "scene",
    argument: "Erika espera a Juan en el puerto.",
    cursor: 0,
  });
  assert.ok(events(r.data).some((e) => e.type === "text"));
  const sent = JSON.stringify(await aiLog());
  assert.match(sent, /Erika/);
  for (const secret of ["LEYENDA-VISUAL", "ETAPA-VISUAL", "/api/assets", "novel-files"]) {
    assert.ok(!sent.includes(secret), secret);
  }
});

// ---------------------------------------------------------------- lifecycle

test("abandoned uploads are swept when the next upload starts", async () => {
  const key = process.env.E2E_SERVICE_KEY;
  await fetch(`${STACK}/rest/v1/assets?id=eq.${s.pendingWithFile}`, {
    method: "PATCH",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ created_at: "2000-01-01T00:00:00Z" }),
  });
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.pendingWithFile)));
  await startUpload(s.A, png(5, 5));
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(s.pendingWithFile)), "its original was removed");
  assert.equal((await complete(s.pendingWithFile, { kind: "character", character_id: s.erika })).status, 404);
});

test("duplicate: an independent copy, each shared file copied once", async () => {
  // Erika also uses Juan's file: one file, two galleries.
  await call(`/api/characters/${s.erika}/images`, "POST", { asset_id: s.juanAsset });
  const source = (await call(`/api/novels/${s.A}`)).data.images;
  const sourceAssets = new Set(source.map((i) => i.asset_id));
  const readySourceFiles = (await filesOf(s.A)).filter((k) => [...sourceAssets].some((a) => k.includes(a)));
  const sourceCount = (await filesOf(s.A)).length;

  const r = await call(`/api/novels/${s.A}/duplicate`, "POST");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  s.C = r.data.id;
  const copy = (await call(`/api/novels/${s.C}`)).data;
  assert.equal(copy.images.length, source.length);
  const copyAssets = new Set(copy.images.map((i) => i.asset_id));
  assert.equal(copyAssets.size, sourceAssets.size, "shared files stay shared in the copy");
  assert.ok([...copyAssets].every((a) => !sourceAssets.has(a)), "new file ids");
  assert.equal((await filesOf(s.C)).length, readySourceFiles.length, "each file copied once");
  assert.deepEqual(
    copy.images.map((i) => [i.is_primary, i.sort_order, i.caption]).sort(),
    source.map((i) => [i.is_primary, i.sort_order, i.caption]).sort(),
  );
  const one = copy.images[0].asset;
  assert.equal((await get(url(one.id, "thumb", one.version))).status, 200);

  // Deleting the copy leaves the source untouched.
  assert.equal((await call(`/api/novels/${s.C}`, "DELETE")).status, 204);
  assert.equal((await filesOf(s.C)).length, 0);
  assert.equal((await filesOf(s.A)).length, sourceCount, "the source keeps all its files");
  const again = source[0].asset;
  assert.equal((await get(url(again.id, "thumb", again.version))).status, 200);
});

test("duplicate: if a file can't be copied, there is no half-made novel", async () => {
  const before = (await call("/api/novels")).data.length;
  await fetch(`${STACK}/__storage/fail?op=copy&times=1`);
  const r = await call(`/api/novels/${s.A}/duplicate`, "POST");
  assert.equal(r.status, 500);
  assert.equal((await call("/api/novels")).data.length, before);
  const novels = new Set((await call("/api/novels")).data.map((n) => n.id));
  const strays = (await storage()).filter((k) => !novels.has(k.split("/")[1]));
  assert.deepEqual(strays, [], "no files left for a novel that doesn't exist");
});

test("deleting a character deletes the files only it used", async () => {
  // Juan's file is also in Erika's gallery: it stays.
  assert.equal((await call(`/api/memory/characters/${s.juan}`, "DELETE")).status, 204);
  assert.equal((await get(url(s.juanAsset, "thumb"))).status, 200);
  // Erika was its last user.
  const erikaAssets = (await call(`/api/novels/${s.A}`)).data.images.map((i) => i.asset_id);
  assert.equal((await call(`/api/memory/characters/${s.erika}`, "DELETE")).status, 204);
  for (const a of erikaAssets) assert.ok(!(await filesOf(s.A)).some((k) => k.includes(a)), a);
  assert.equal((await get(url(s.juanAsset, "thumb"))).status, 404);
});

test("deleting a novel deletes all its files", async () => {
  s.dana = (await call(`/api/novels/${s.A}/memory/characters`, "POST", { name: "Dana" })).data.id;
  await upload(s.A, s.dana, { original: png(40, 40) });
  assert.ok((await filesOf(s.A)).length > 0);
  assert.equal((await call(`/api/novels/${s.A}`, "DELETE")).status, 204);
  assert.deepEqual(await filesOf(s.A), []);
});
