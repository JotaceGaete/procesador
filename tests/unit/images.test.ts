import { test } from "node:test";
import assert from "node:assert/strict";
import { assetPaths, assetUrl, exifOrientation, imageInfo } from "../../src/lib/images";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

test("imageInfo: PNG", () => {
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(3000), u32be(2000), [8, 2]);
  assert.deepEqual(imageInfo(png), { type: "image/png", width: 3000, height: 2000, orientation: 1 });
});

test("imageInfo: JPEG, skipping APP segments (EXIF) before the frame", () => {
  const app1 = [0xff, 0xe1, ...u16be(2 + 300), ...new Array(300).fill(0)];
  const sof2 = [0xff, 0xc2, ...u16be(17), 8, ...u16be(1200), ...u16be(1600), 3];
  const jpeg = bytes([0xff, 0xd8], app1, sof2, new Array(16).fill(0));
  assert.deepEqual(imageInfo(jpeg), { type: "image/jpeg", width: 1600, height: 1200, orientation: 1 });
  assert.equal(imageInfo(bytes([0xff, 0xd8], app1)), null, "header cut before the frame");
  assert.equal(imageInfo(bytes([0xff, 0xd8, 0xff, 0xc4, 0, 4, 0, 0], sof2.map(() => 0))), null, "DHT is not a frame");
});

test("imageInfo: WebP lossy, lossless and extended", () => {
  const riff = (chunk: string, body: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk, [0, 0, 0, 0], body);
  const vp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(640), ...u16le(480), 0, 0]);
  assert.deepEqual(imageInfo(vp8), { type: "image/webp", width: 640, height: 480, orientation: 1 });
  const w = 1999, h = 1001;
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  const vp8l = riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(vp8l), { type: "image/webp", width: w, height: h, orientation: 1 });
  const vp8x = riff("VP8X", [0, 0, 0, 0, ...u24le(4095), ...u24le(2047)]);
  assert.deepEqual(imageInfo(vp8x), { type: "image/webp", width: 4096, height: 2048, orientation: 1 });
});

test("imageInfo: AVIF from its ispe box", () => {
  const avif = bytes(u32be(24), "ftyp", "avif", [0, 0, 0, 0], "mif1avif", u32be(20), "ispe", [0, 0, 0, 0], u32be(5000), u32be(3333));
  assert.deepEqual(imageInfo(avif), { type: "image/avif", width: 5000, height: 3333, orientation: 1 });
});

test("imageInfo: anything else is rejected", () => {
  for (const b of [bytes("GIF89a", new Array(20).fill(1)), bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"), bytes(""), bytes("%PDF-1.7")]) {
    assert.equal(imageInfo(b), null);
  }
  const zero = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(0), u32be(10), [8, 2]);
  assert.equal(imageInfo(zero), null, "zero width");
});

test("assetPaths: per novel and per file (not per use), versioned, original keeps its format", () => {
  assert.deepEqual(assetPaths("n", "a", 3, "image/jpeg", "image/webp"), {
    original_path: "n/a/v3/original.jpg",
    display_path: "n/a/v3/display.webp",
    thumb_path: "n/a/v3/thumb.webp",
  });
  assert.deepEqual(assetPaths("n", "a", 1, "image/avif"), {
    original_path: "n/a/v1/original.avif",
    display_path: null,
    thumb_path: null,
  });
});

test("assetUrl carries the version, so a replaced file gets a new URL", () => {
  assert.equal(assetUrl({ id: "a", version: 2 }, "thumb"), "/api/assets/a/thumb?v=2");
  assert.notEqual(assetUrl({ id: "a", version: 2 }, "display"), assetUrl({ id: "a", version: 3 }, "display"));
});

// ---------------------------------------------------------------- orientation

/** A big-endian TIFF block with one IFD entry: Orientation = value. */
const tiff = (value: number) => [..."MM".split("").map((c) => c.charCodeAt(0)), 0, 42, ...u32be(8), 0, 1, 0x01, 0x12, 0, 3, ...u32be(1), ...u16be(value), 0, 0, ...u32be(0)];

test("EXIF orientation: read from a TIFF block, either byte order", () => {
  assert.equal(exifOrientation(new Uint8Array(tiff(6)), 0), 6);
  const le = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(exifOrientation(new Uint8Array(le), 0), 8);
  assert.equal(exifOrientation(new Uint8Array([1, 2, 3]), 0), 1, "unreadable → as stored");
});

test("JPEG from a phone held upright: EXIF 6, stored 4032×3024, seen 3024×4032", () => {
  const exif = [..."Exif".split("").map((c) => c.charCodeAt(0)), 0, 0, ...tiff(6)];
  const app1 = [0xff, 0xe1, ...u16be(2 + exif.length), ...exif];
  const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(3024), ...u16be(4032), 3];
  const jpeg = bytes([0xff, 0xd8], app1, sof0, new Array(16).fill(0));
  assert.deepEqual(imageInfo(jpeg), { type: "image/jpeg", width: 3024, height: 4032, orientation: 6 });
});

test("orientations 2–4 keep width and height; 5–8 swap them", () => {
  const exif = (o: number) => [..."Exif".split("").map((c) => c.charCodeAt(0)), 0, 0, ...tiff(o)];
  const jpeg = (o: number) =>
    bytes([0xff, 0xd8], [0xff, 0xe1, ...u16be(2 + exif(o).length), ...exif(o)], [0xff, 0xc0, ...u16be(17), 8, ...u16be(100), ...u16be(300), 3], new Array(16).fill(0));
  for (const o of [1, 2, 3, 4]) assert.deepEqual([imageInfo(jpeg(o))!.width, imageInfo(jpeg(o))!.height], [300, 100], `orientation ${o}`);
  for (const o of [5, 6, 7, 8]) assert.deepEqual([imageInfo(jpeg(o))!.width, imageInfo(jpeg(o))!.height], [100, 300], `orientation ${o}`);
});

test("PNG eXIf and AVIF irot are read too", () => {
  const ihdr = [...u32be(13), ..."IHDR".split("").map((c) => c.charCodeAt(0)), ...u32be(800), ...u32be(600), 8, 2, 0, 0, 0, 0, 0, 0, 0];
  const exifChunk = [...u32be(tiff(8).length), ..."eXIf".split("").map((c) => c.charCodeAt(0)), ...tiff(8), 0, 0, 0, 0];
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ihdr, exifChunk, u32be(0), "IDAT");
  assert.deepEqual(imageInfo(png), { type: "image/png", width: 600, height: 800, orientation: 8 });
  const avif = bytes(u32be(24), "ftyp", "avif", [0, 0, 0, 0], "mif1avif", u32be(20), "ispe", [0, 0, 0, 0], u32be(4000), u32be(3000), u32be(9), "irot", [3]);
  assert.deepEqual(imageInfo(avif), { type: "image/avif", width: 3000, height: 4000, orientation: 6 });
});
