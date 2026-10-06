// Procesador's icon (docs/icono.md): served without a session (the login page shows it and
// browsers fetch the manifest without cookies), declared in every page, and the rest of the
// app still closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE } from "./helpers.mjs";

const get = (path) => fetch(`${BASE}${path}`, { redirect: "manual" });

test("icons and manifest are public, with their types", async () => {
  for (const [path, type] of [
    ["/favicon.ico", /image\/(x-icon|vnd\.microsoft\.icon)/],
    ["/icon.svg", /image\/svg\+xml/],
    ["/apple-icon.png", /image\/png/],
    ["/manifest.webmanifest", /application\/manifest\+json/],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", type, path);
  }
  const ico = Buffer.from(await (await get("/favicon.ico")).arrayBuffer());
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4)], [1, 3], "an icon file with 16, 32 and 48 px");
  assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
  const svg = await (await get("/icon.svg")).text();
  assert.match(svg, /@media \(max-width: 40px\)/, "simplifies itself when small");

  const manifest = await (await get("/manifest.webmanifest")).json();
  assert.equal(manifest.name, "Procesador");
  assert.equal(manifest.display, "browser", "a shortcut, not an installed app");
  assert.deepEqual(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`), ["192x192 any", "512x512 any", "512x512 maskable"]);
  for (const icon of manifest.icons) {
    const res = await get(icon.src);
    assert.equal(res.status, 200, icon.src);
    const png = Buffer.from(await res.arrayBuffer());
    assert.equal(png.toString("latin1", 1, 4), "PNG", icon.src);
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});

test("the login page declares the icon, the Apple icon and the manifest", async () => {
  const html = await (await get("/login")).text();
  assert.match(html, /<link rel="icon" href="\/favicon\.ico\?[^"]+"/);
  assert.match(html, /<link rel="icon" href="\/icon\.svg\?[^"]+"[^>]* type="image\/svg\+xml"/, "versioned URL: a new drawing gets a new URL");
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-icon\.png\?[^"]+"/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
});

test("only those paths are open: pages and the API still need a session", async () => {
  for (const path of ["/", "/novela/00000000-0000-4000-8000-000000000000", "/icon.svg.bak", "/iconsx"]) {
    const res = await get(path);
    assert.equal(res.status, 307, path);
    assert.match(res.headers.get("location"), /\/login$/, path);
  }
  assert.equal((await get("/api/novels")).status, 401);
});
