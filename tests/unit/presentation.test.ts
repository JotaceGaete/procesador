import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterHeading, paragraphs, present } from "@/lib/presentation";

const shape = (content: string) =>
  present(content).map((b) =>
    b.kind === "para" ? `${b.first ? "¶0" : "¶"} ${b.spans.map((s) => (s.italic ? `<${s.text}>` : s.text)).join("")}` : b.kind,
  );

test("present: one paragraph per line with text; blank lines are only how it was typed", () => {
  const typedOnce = "Llegó tarde.\n—¿Dónde estabas? —preguntó Elena.\n—En el puerto.";
  const typedTwice = "Llegó tarde.\n\n—¿Dónde estabas? —preguntó Elena.\n\n\n—En el puerto.";
  const expected = ["¶0 Llegó tarde.", "¶ —¿Dónde estabas? —preguntó Elena.", "¶ —En el puerto."];
  assert.deepEqual(shape(typedOnce), expected, "dialogue lines are ordinary paragraphs");
  assert.deepEqual(shape(typedTwice), expected, "same result with blank lines between them");
  assert.deepEqual(shape("  \tSangría tecleada.\n   \nOtro."), ["¶0 Sangría tecleada.", "¶ Otro."], "typed indent and blank-looking lines dropped");
});

test("present: no indent at the start, after a scene break or an image; italics kept", () => {
  const id = "3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10";
  assert.deepEqual(shape(`Uno *dos*.\nTres.\n\n[[separador]]\n\nCuatro.\nCinco.\n\n[[imagen:${id}]]\nSeis.`), [
    "¶0 Uno <dos>.",
    "¶ Tres.",
    "break",
    "¶0 Cuatro.",
    "¶ Cinco.",
    "image",
    "¶0 Seis.",
  ]);
  assert.deepEqual(shape("Texto con [[separador]] dentro."), ["¶0 Texto con [[separador]] dentro."], "a marker inside a paragraph is text");
  assert.deepEqual(present(""), []);
});

test("paragraphs and chapterHeading", () => {
  assert.deepEqual(paragraphs("\n a \n\n b\n"), ["a", "b"]);
  assert.deepEqual(chapterHeading(2, "Capítulo 3"), { number: "Capítulo 3", title: "" });
  assert.deepEqual(chapterHeading(0, " La llegada "), { number: "Capítulo 1", title: "La llegada" });
});

test("present: lines with nothing visible (pasted invisible characters) are blank lines, never an empty paragraph", () => {
  const invisible = ["​", "⁠‌", "﻿", "­", "‎", "  \t", "ㅤ"];
  for (const line of invisible) {
    assert.deepEqual(shape(`—Siempre dices lo mismo —dije.\n${line}\nLorena me miró de costado.`), ["¶0 —Siempre dices lo mismo —dije.", "¶ Lorena me miró de costado."], JSON.stringify(line));
  }
  assert.deepEqual(shape("Uno.\r\n\r\nDos.\r\n"), ["¶0 Uno.", "¶ Dos."], "Windows line endings");
  assert.deepEqual(shape("​\n\n[[separador]]\n​\nTras."), ["break", "¶0 Tras."]);
  assert.deepEqual(shape("Con​unión."), ["¶0 Con​unión."], "inside a paragraph the text is left as it is");
});
