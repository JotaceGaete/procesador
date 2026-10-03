// Images of the book (docs/manuscrito-imagenes.md), end to end against Postgres +
// PostgREST, the in-memory Storage and the mock AI. Tests run in order and share state.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { BASE, STACK, aiLog, clearAiLog, client, events, login, png, resetDb } from "./helpers.mjs";

let call, cookie;
const s = {};
const marker = (id) => `[[imagen:${id}]]`;
const uuid = () => crypto.randomUUID();
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const filesOf = async (novel) =>
  (await (await fetch(`${STACK}/__storage`)).json()).keys.filter((k) => k.startsWith(`novel-files/${novel}/`));
const book = async (novel = s.A) => (await call(`/api/novels/${novel}`)).data;
const mimg = async (id, novel = s.A) => (await book(novel)).manuscriptImages.find((i) => i.id === id);

/** Saves a chapter's text with its current revision. */
async function save(chapterId, content) {
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  const r = await call(`/api/chapters/${chapterId}`, "PATCH", { content, revision });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

/** Full upload (start, signed PUT, complete) with a use; `withHash` false skips the early duplicate check. */
async function upload(novel, file, use, { type = "image/png", withHash = false } = {}) {
  const start = await call(`/api/novels/${novel}/assets`, "POST", {
    file_name: "f",
    type,
    bytes: file.length,
    ...(withHash ? { sha256: sha(file) } : {}),
  });
  if (start.data.duplicate) return { duplicate: start.data.duplicate };
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const put = await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": type }, body: file });
  assert.equal(put.status, 200);
  const form = new FormData();
  form.append("display", new Blob([png(64, 48)]));
  form.append("thumb", new Blob([png(32, 24)]));
  form.append("use", JSON.stringify(use));
  const res = await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data;
}

/** A JPEG header as a phone writes it: EXIF orientation, then the frame size as stored. */
function jpeg(storedWidth, storedHeight, orientation) {
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, ...u16(orientation), 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe1, ...u16(2 + exif.length), ...exif,
    0xff, 0xc0, ...u16(17), 8, ...u16(storedHeight), ...u16(storedWidth), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}

before(async () => {
  await resetDb();
  cookie = await login();
  call = client(cookie);
  s.A = (await call("/api/novels", "POST", { title: "A" })).data.id;
  s.B = (await call("/api/novels", "POST", { title: "B" })).data.id;
  s.ch1 = (await book()).chapters[0].id;
  s.ch2 = (await call(`/api/novels/${s.A}/chapters`, "POST", { title: "Dos" })).data.id;
  s.chB = (await book(s.B)).chapters[0].id;
  s.erika = (await call(`/api/novels/${s.A}/memory/characters`, "POST", { name: "Erika" })).data.id;
});

// ---------------------------------------------------------------- insert, edit

test("insert: the marker goes into the text first; the finished upload is placed in that chapter", async () => {
  s.m1 = uuid();
  await save(s.ch1, `La casa al final del camino.\n\n${marker(s.m1)}\n\nErika dejó el bolso.`);
  const r = await upload(s.A, png(2400, 1600), { kind: "manuscript", id: s.m1, alt: "Plano de la casa" });
  assert.equal(r.reused, false);
  const img = r.manuscriptImage;
  assert.equal(img.id, s.m1);
  assert.equal(img.chapter_id, s.ch1, "placed without waiting for another save");
  assert.deepEqual(
    [img.alt, img.decorative, img.caption, img.credit, img.layout, img.align, img.width_pct],
    ["Plano de la casa", false, "", "", "inline", "center", 100],
  );
  assert.deepEqual([img.asset.width, img.asset.height, img.asset.orientation], [2400, 1600, 1], "the original's size");
  s.a1 = img.asset_id;
});

test("edit: caption and credit apart, alt text independent; never touches the chapter", async () => {
  const rev = (await call(`/api/chapters/${s.ch1}`)).data.revision;
  const r = await call(`/api/manuscript-images/${s.m1}`, "PATCH", {
    caption: "La casa en 1972",
    credit: "Archivo familiar",
    layout: "page",
    width_pct: 50,
    align: "left",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.data.alt, r.data.caption, r.data.credit, r.data.layout, r.data.width_pct, r.data.align],
    ["Plano de la casa", "La casa en 1972", "Archivo familiar", "page", 50, "left"],
  );
  const deco = await call(`/api/manuscript-images/${s.m1}`, "PATCH", { decorative: true, alt: "" });
  assert.deepEqual([deco.data.decorative, deco.data.alt], [true, ""], "decorative: no alt text needed");
  await call(`/api/manuscript-images/${s.m1}`, "PATCH", { decorative: false, alt: "Plano de la casa" });
  assert.equal((await call(`/api/chapters/${s.ch1}`)).data.revision, rev, "the chapter's revision didn't change");
  for (const bad of [{ layout: "full" }, { align: "justify" }, { width_pct: 60 }, { decorative: "sí" }, {}]) {
    assert.equal((await call(`/api/manuscript-images/${s.m1}`, "PATCH", bad)).status, 400, JSON.stringify(bad));
  }
});

test("word count: markers are not words (chapter list and database)", async () => {
  const ch = (await book()).chapters.find((c) => c.id === s.ch1);
  assert.equal(ch.words, 10, "'La casa al final del camino.' + 'Erika dejó el bolso.'");
});

// ---------------------------------------------------------------- move, unplace, recover

test("move: cut from one chapter, pasted in another", async () => {
  await save(s.ch1, "La casa al final del camino.\n\nErika dejó el bolso.");
  await save(s.ch2, `Capítulo dos.\n\n${marker(s.m1)}`);
  assert.equal((await mimg(s.m1)).chapter_id, s.ch2);
});

test("unplace: removing the marker keeps the image and its file, not placed", async () => {
  await save(s.ch2, "Capítulo dos.");
  const img = await mimg(s.m1);
  assert.equal(img.chapter_id, null);
  assert.equal(img.caption, "La casa en 1972");
  assert.ok((await filesOf(s.A)).some((k) => k.includes(`${s.a1}/v1/original`)), "the original stays");
});

test("recover: inserting the marker again places it with everything it had", async () => {
  await save(s.ch1, `La casa al final del camino.\n\n${marker(s.m1)}\n\nErika dejó el bolso.`);
  const img = await mimg(s.m1);
  assert.equal(img.chapter_id, s.ch1);
  assert.equal(img.credit, "Archivo familiar");
});

test("a marker inside a paragraph is not an image (stays not placed)", async () => {
  const m = uuid();
  await call(`/api/novels/${s.A}/manuscript-images`, "POST", { asset_id: s.a1, id: m });
  await save(s.ch2, `Mira ${marker(m)} aquí.`);
  assert.equal((await mimg(m)).chapter_id, null);
  s.stray = m;
});

test("deleting a chapter leaves its images not placed, never deleted", async () => {
  const ch3 = (await call(`/api/novels/${s.A}/chapters`, "POST", { title: "Tres" })).data.id;
  await save(s.ch2, "Capítulo dos.");
  await save(ch3, marker(s.stray));
  assert.equal((await mimg(s.stray)).chapter_id, ch3);
  assert.equal((await call(`/api/chapters/${ch3}`, "DELETE")).status, 204);
  const img = await mimg(s.stray);
  assert.ok(img, "still there");
  assert.equal(img.chapter_id, null);
});

// ---------------------------------------------------------------- reuse & sharing

test("reuse: a gallery file inserted in the book is the same file, never a copy", async () => {
  const g = await upload(s.A, png(900, 1200), { kind: "character", character_id: s.erika, caption: "Erika" });
  s.galleryImage = g.images[0].id;
  s.aShared = g.asset_id;
  const before = (await filesOf(s.A)).length;
  s.m2 = uuid();
  const r = await call(`/api/novels/${s.A}/manuscript-images`, "POST", { asset_id: s.aShared, id: s.m2, caption: "Erika en el muelle" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.asset_id, s.aShared);
  assert.equal((await filesOf(s.A)).length, before);
  await save(s.ch2, `Capítulo dos.\n\n${marker(s.m2)}`);
});

test("reuse: uploading a file the novel already has, for the book, reuses it", async () => {
  const early = await upload(s.A, png(900, 1200), { kind: "manuscript", id: uuid() }, { withHash: true });
  assert.equal(early.duplicate.asset.id, s.aShared, "found before uploading");
  assert.deepEqual(
    early.duplicate.uses.map((u) => u.kind).sort(),
    ["character", "manuscript"],
    "its uses include the gallery and the book",
  );
  const before = (await filesOf(s.A)).length;
  const late = await upload(s.A, png(900, 1200), { kind: "manuscript", id: uuid() });
  assert.equal(late.reused, true, "caught when completing");
  assert.equal(late.manuscriptImage.asset_id, s.aShared);
  assert.equal((await filesOf(s.A)).length, before);
  s.m3 = late.manuscriptImage.id;
});

test("shared file: replacing it in the gallery only leaves the book untouched", async () => {
  const r = await upload(s.A, png(1000, 1000), { kind: "replace", character_image_id: s.galleryImage, scope: "use" });
  assert.notEqual(r.images.find((i) => i.id === s.galleryImage).asset_id, s.aShared);
  assert.equal(r.manuscriptImages.find((i) => i.id === s.m2).asset_id, s.aShared, "the book keeps its file");
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.aShared)));
  s.aGallery = r.images.find((i) => i.id === s.galleryImage).asset_id;
});

test("shared file: replacing in every use from the book changes the gallery too; position and texts kept", async () => {
  // Make the gallery share the book's file again, then replace from the book.
  await call(`/api/character-images/${s.galleryImage}/replace`, "POST", { asset_id: s.aShared, scope: "use" });
  const rev = (await call(`/api/chapters/${s.ch2}`)).data.revision;
  const r = await upload(s.A, png(1300, 900), { kind: "replace", manuscript_image_id: s.m2, scope: "all" });
  const m2 = r.manuscriptImages.find((i) => i.id === s.m2);
  const m3 = r.manuscriptImages.find((i) => i.id === s.m3);
  const g = r.images.find((i) => i.id === s.galleryImage);
  assert.notEqual(m2.asset_id, s.aShared);
  assert.equal(m3.asset_id, m2.asset_id, "the other image of the book with that file");
  assert.equal(g.asset_id, m2.asset_id, "and the gallery");
  assert.equal(m2.caption, "Erika en el muelle");
  assert.equal(m2.chapter_id, s.ch2);
  assert.equal((await call(`/api/chapters/${s.ch2}`)).data.revision, rev, "the chapter text is untouched");
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(s.aShared)), "the old file had no uses left");
  s.aNew = m2.asset_id;
});

// ---------------------------------------------------------------- safe deletion

test("safe deletion: removing a file's gallery use keeps it while the book uses it", async () => {
  await call(`/api/character-images/${s.galleryImage}`, "DELETE");
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.aNew)));
  // An unplaced image is a use too.
  await save(s.ch2, "Capítulo dos.");
  assert.equal((await mimg(s.m2)).chapter_id, null);
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.aNew)));
});

test("safe deletion: deleting the last image of a file deletes the file; the other uses keep theirs", async () => {
  assert.equal((await call(`/api/manuscript-images/${s.m2}`, "DELETE")).status, 204);
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.aNew)), "m3 still uses it");
  assert.equal((await call(`/api/manuscript-images/${s.m3}`, "DELETE")).status, 204);
  assert.ok(!(await filesOf(s.A)).some((k) => k.includes(s.aNew)));
  assert.equal((await call(`/api/manuscript-images/${s.m3}`, "DELETE")).status, 404);
});

test("duplicate image: another image of the book, same file, same texts, not placed", async () => {
  const before = (await filesOf(s.A)).length;
  const r = await call(`/api/manuscript-images/${s.m1}/duplicate`, "POST");
  assert.equal(r.status, 201);
  assert.notEqual(r.data.id, s.m1);
  assert.equal(r.data.asset_id, s.a1);
  assert.deepEqual([r.data.caption, r.data.credit, r.data.chapter_id], ["La casa en 1972", "Archivo familiar", null]);
  assert.equal((await filesOf(s.A)).length, before);
  await call(`/api/manuscript-images/${r.data.id}`, "DELETE");
});

// ---------------------------------------------------------------- orientation

test("EXIF orientation: a phone photo held upright keeps its real proportions", async () => {
  const r = await upload(s.A, jpeg(4032, 3024, 6), { kind: "manuscript", id: uuid() }, { type: "image/jpeg" });
  const a = r.manuscriptImage.asset;
  assert.deepEqual([a.width, a.height, a.orientation], [3024, 4032, 6]);
  const flat = await upload(s.A, jpeg(4032, 3024, 3), { kind: "manuscript", id: uuid() }, { type: "image/jpeg" });
  assert.deepEqual([flat.manuscriptImage.asset.width, flat.manuscriptImage.asset.height, flat.manuscriptImage.asset.orientation], [4032, 3024, 3]);
  await call(`/api/manuscript-images/${r.manuscriptImage.id}`, "DELETE");
  await call(`/api/manuscript-images/${flat.manuscriptImage.id}`, "DELETE");
});

// ---------------------------------------------------------------- assistant

test("assistant: images reach it as a neutral line; a selection carries [IMAGEN n], never ids or files", async () => {
  const content = (await call(`/api/chapters/${s.ch1}`)).data.content;
  await clearAiLog();
  await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.ch1,
    content,
    provider: "anthropic",
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: content.length,
  });
  const sent = JSON.stringify((await aiLog())[0].body);
  assert.match(sent, /\[IMAGEN 1\]/);
  assert.match(sent, /conserva cada marcador exactamente igual/);
  assert.ok(!sent.includes(s.m1) && !sent.includes(s.a1) && !sent.includes("[[imagen:"), "no ids, no markers");

  await clearAiLog();
  const scene = await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.ch1,
    content,
    provider: "anthropic",
    mode: "scene",
    argument: "Erika vuelve a la casa.",
    cursor: content.length,
  });
  assert.ok(events(scene.data).some((e) => e.type === "text"));
  const sceneSent = JSON.stringify((await aiLog())[0].body);
  assert.match(sceneSent, /\[Imagen: Plano de la casa\]/);
  assert.ok(!sceneSent.includes(s.m1));
});

// ---------------------------------------------------------------- duplicate novel & isolation

test("duplicate novel: images copied with new ids and the copy's markers rewritten to them", async () => {
  const source = await book();
  const r = await call(`/api/novels/${s.A}/duplicate`, "POST");
  assert.equal(r.status, 201);
  s.C = r.data.id;
  const copy = await book(s.C);
  assert.equal(copy.manuscriptImages.length, source.manuscriptImages.length);
  const oldIds = new Set(source.manuscriptImages.map((i) => i.id));
  assert.ok(copy.manuscriptImages.every((i) => !oldIds.has(i.id)), "new ids");
  const ch1copy = copy.chapters[0].id;
  const text = (await call(`/api/chapters/${ch1copy}`)).data.content;
  const placed = copy.manuscriptImages.find((i) => i.chapter_id === ch1copy);
  assert.ok(placed, "the placed image points at the copy's chapter");
  assert.ok(text.includes(marker(placed.id)), "the copy's text has the copy's marker");
  assert.ok(![...oldIds].some((id) => text.includes(id)), "no marker of the original survives in the copy");
  assert.equal(placed.caption, "La casa en 1972");
  // The copy is independent: deleting it leaves the source's images and files.
  await call(`/api/novels/${s.C}`, "DELETE");
  assert.equal((await mimg(s.m1)).chapter_id, s.ch1);
  assert.ok((await filesOf(s.A)).some((k) => k.includes(s.a1)));
});

test("isolation: a marker or a file of another novel never resolves there", async () => {
  await save(s.chB, `Otra novela.\n\n${marker(s.m1)}`);
  assert.equal((await mimg(s.m1)).chapter_id, s.ch1, "A's image is not moved into B");
  assert.deepEqual((await book(s.B)).manuscriptImages, []);
  const r = await call(`/api/novels/${s.B}/manuscript-images`, "POST", { asset_id: s.a1 });
  assert.equal(r.status, 400, "a file of A can't be used in B");
  const m = await upload(s.B, png(10, 10), { kind: "manuscript", id: uuid() });
  const swap = await call(`/api/manuscript-images/${m.manuscriptImage.id}/replace`, "POST", { asset_id: s.a1, scope: "use" });
  assert.equal(swap.status, 400);
});
