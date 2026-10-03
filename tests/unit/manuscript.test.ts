import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendImages,
  blocks,
  countWords,
  describeImages,
  imageAt,
  imageIds,
  marker,
  pixelsFor,
  printPpi,
  protectImages,
  restoreImages,
  strayMarkers,
} from "../../src/lib/manuscript";

const A = "3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10";
const B = "00000000-1111-4222-8333-444444444444";

test("blocks: an image is a marker alone on its line; text runs around it keep their offsets", () => {
  const text = `La casa al final del camino.\n\n${marker(A)}\n\nErika dejó el bolso.`;
  const out = blocks(text);
  assert.deepEqual(
    out.map((b) => b.kind),
    ["text", "image", "text"],
  );
  const img = out[1] as Extract<(typeof out)[number], { kind: "image" }>;
  assert.equal(img.id, A);
  assert.equal(text.slice(img.start, img.end), marker(A));
  assert.equal(text.slice(out[2].start, out[2].end), "\nErika dejó el bolso.");
});

test("blocks: start and end of the chapter, spaces around, repeats, uppercase ids", () => {
  const text = `  ${marker(A)}  \nTexto.\n${marker(B).toUpperCase().replace("IMAGEN", "imagen")}\n${marker(A)}`;
  assert.deepEqual(imageIds(text), [A, B, A]);
});

test("a marker inside a line is not an image (rule 2)", () => {
  const text = `Mira ${marker(A)} aquí.\n\n${marker(B)}`;
  assert.deepEqual(imageIds(text), [B]);
  assert.deepEqual(strayMarkers(text), [A]);
  assert.deepEqual(strayMarkers(`${marker(A)}\n${marker(A)}`), [], "a repeated image is not stray");
  assert.deepEqual(imageIds("[[imagen:no-es-un-id]]\n[[separador]]"), []);
});

test("word count ignores markers", () => {
  assert.equal(countWords(`Uno dos tres.\n\n${marker(A)}\n\nCuatro.`), 4);
  assert.equal(countWords(marker(A)), 0);
  assert.equal(countWords(""), 0);
});

test("imageAt: the image on the cursor's line", () => {
  const text = `Antes.\n${marker(A)}\nDespués.`;
  const start = text.indexOf("[[");
  assert.deepEqual(imageAt(text, start + 5), { id: A, start, end: start + marker(A).length });
  assert.deepEqual(imageAt(text, start), { id: A, start, end: start + marker(A).length });
  assert.equal(imageAt(text, 2), null);
});

test("assistant: context lines describe images; selections carry numbered placeholders", () => {
  const text = `Uno.\n\n${marker(A)}\n\nDos.\n\n${marker(B)}`;
  assert.equal(
    describeImages(text, (id) => (id === A ? "Mapa del puerto" : "")),
    "Uno.\n\n[Imagen: Mapa del puerto]\n\nDos.\n\n[Imagen: sin descripción]",
  );
  const p = protectImages(text);
  assert.equal(p.text, "Uno.\n\n[IMAGEN 1]\n\nDos.\n\n[IMAGEN 2]");
  assert.deepEqual(p.ids, [A, B]);
  assert.ok(!p.text.includes(A), "no ids reach the model");
});

test("assistant: a proposal gets its real markers back; dropped and invented ones are reported/removed", () => {
  const ids = [A, B];
  assert.deepEqual(restoreImages("Nuevo.\n\n[IMAGEN 2]\n\nOtro.\n\n[IMAGEN 1]", ids), {
    text: `Nuevo.\n\n${marker(B)}\n\nOtro.\n\n${marker(A)}`,
    missing: [],
  });
  const lost = restoreImages("Sólo texto.\n\n[IMAGEN 1]\n\n[IMAGEN 7]", ids);
  assert.equal(lost.text, `Sólo texto.\n\n${marker(A)}\n\n`);
  assert.deepEqual(lost.missing, [B]);
  assert.equal(appendImages("Texto.\n\n", [B]), `Texto.\n\n${marker(B)}`);
});

test("print resolution from the original's pixels", () => {
  // 12 cm text block: 100 % is 4.72 in.
  assert.equal(printPpi(1417, 100), 300);
  assert.equal(printPpi(800, 100), 169);
  assert.equal(printPpi(800, 50), 339);
  assert.equal(pixelsFor(100), 1418);
  assert.equal(pixelsFor(25), 355);
});
