import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEPARATOR,
  appendImages,
  blocks,
  countWords,
  describeImages,
  forModel,
  fromModel,
  imageAt,
  inlineSpans,
  markerLineAt,
  proseOnly,
  separatorsForModel,
  toggleItalic,
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

// ---------------------------------------------------------------------------
// Formato del texto (docs/formato-texto.md): cursivas y separadores.
// ---------------------------------------------------------------------------

test("separator: a block alone on its line, like an image; inside a line it is text", () => {
  const text = `Primera escena.\n\n  ${SEPARATOR} \n\nSegunda escena. ${SEPARATOR} no.`;
  const out = blocks(text);
  assert.deepEqual(
    out.map((b) => b.kind),
    ["text", "separator", "text"],
  );
  assert.equal(text.slice(out[1].start, out[1].end).trim(), SEPARATOR);
  assert.deepEqual(imageIds(text), []);
});

test("countWords: separators and the asterisks of italics are not words", () => {
  assert.equal(countWords(`Dijo *nunca* más.\n\n${SEPARATOR}\n\n* * *\n\nFin.`), 4);
});

test("proseOnly: markers become blanks of the same length", () => {
  const text = `A\n${SEPARATOR}\n${marker(A)}\nB`;
  const prose = proseOnly(text);
  assert.equal(prose.length, text.length);
  assert.equal(prose.trim().replace(/\s+/g, " "), "A B");
});

test("markerLineAt: the line of an image or a separator, nothing else", () => {
  const text = `Hola.\n${SEPARATOR}\n${marker(A)}\nAdiós.`;
  assert.deepEqual(markerLineAt(text, 8), { start: 6, end: 6 + SEPARATOR.length });
  assert.ok(markerLineAt(text, 6 + SEPARATOR.length + 2));
  assert.equal(markerLineAt(text, 2), null);
});

test("inlineSpans: italics between single asterisks, in one line", () => {
  assert.deepEqual(inlineSpans("Leyó *Rayuela* entera."), [
    { text: "Leyó ", italic: false },
    { text: "Rayuela", italic: true },
    { text: " entera.", italic: false },
  ]);
  // Inside a word, several in a line.
  assert.deepEqual(
    inlineSpans("in*cre*íble y *otra*").filter((s) => s.italic).map((s) => s.text),
    ["cre", "otra"],
  );
});

test("inlineSpans: what is not italics stays as written", () => {
  const plain = (t: string) => inlineSpans(t).every((s) => !s.italic);
  assert.ok(plain("2 * 3 = 6"), "spaces around");
  assert.ok(plain("*sin pareja"), "no closing asterisk");
  assert.ok(plain("***"), "a run of asterisks");
  assert.ok(plain("**negrita**"), "two asterisks are not part of the format");
  assert.ok(plain("*cruza\nlíneas*"), "never across lines");
  assert.ok(plain("* * *"));
  // An escaped asterisk is a literal one.
  assert.deepEqual(inlineSpans("\\*nota\\*"), [{ text: "*nota*", italic: false }]);
  // A failed opening doesn't swallow the next real pair.
  assert.deepEqual(
    inlineSpans("a * b *c*").filter((s) => s.italic).map((s) => s.text),
    ["c"],
  );
});

test("toggleItalic: wraps a selection, without its blank edges", () => {
  const text = "Leyó Rayuela entera.";
  const edit = toggleItalic(text, 4, 12); // " Rayuela"
  assert.equal(edit.text, " *Rayuela*");
  const after = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  assert.equal(after, "Leyó *Rayuela* entera.");
  assert.equal(after.slice(...edit.select), " *Rayuela*");
});

test("toggleItalic: unwraps the run (content selected, run selected, or cursor inside)", () => {
  const text = "Leyó *Rayuela* entera.";
  const apply = (e: ReturnType<typeof toggleItalic>) => text.slice(0, e.start) + e.text + text.slice(e.end);
  for (const [s, e] of [
    [6, 13],
    [5, 14],
    [9, 9],
  ])
    assert.equal(apply(toggleItalic(text, s, e)), "Leyó Rayuela entera.", `${s}-${e}`);
  // The cursor stays on the same letter.
  assert.deepEqual(toggleItalic(text, 9, 9).select, [8, 8]);
});

test("toggleItalic: each paragraph of a selection, never a marker line; a pair at the cursor", () => {
  const text = `Uno.\n\n${SEPARATOR}\n\nDos.`;
  const edit = toggleItalic(text, 0, text.length);
  assert.equal(edit.text, `*Uno.*\n\n${SEPARATOR}\n\n*Dos.*`);
  const open = toggleItalic("ab", 1, 1);
  assert.deepEqual([open.text, open.select], ["**", [2, 2]]);
});

test("forModel / fromModel: separators travel as * * * and come back; bold becomes italics", () => {
  const text = `Uno.\n\n${SEPARATOR}\n\n${marker(A)}\n\n*Dos*.`;
  const sent = forModel(text, () => "un mapa");
  assert.equal(sent, "Uno.\n\n* * *\n\n[Imagen: un mapa]\n\n*Dos*.");
  assert.equal(separatorsForModel(`a\n${SEPARATOR}\nb`), "a\n* * *\nb");
  assert.equal(fromModel("Uno.\n\n* * *\n\nDos.\n\n***\n\n⁂\n\nTres."), `Uno.\n\n${SEPARATOR}\n\nDos.\n\n${SEPARATOR}\n\n${SEPARATOR}\n\nTres.`);
  assert.equal(fromModel("Dijo **nunca** y *luego* 2 ** 3."), "Dijo *nunca* y *luego* 2 ** 3.");
  // Round trip of the author's text through a model that changes nothing.
  assert.equal(fromModel(separatorsForModel(`*Uno*.\n\n${SEPARATOR}\n\nDos.`)), `*Uno*.\n\n${SEPARATOR}\n\nDos.`);
});
