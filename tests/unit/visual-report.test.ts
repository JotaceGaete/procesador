import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, report } from "@/lib/visual/report";
import { SAMPLE } from "../../scripts/visual-sample";

test("analyse: exact round trip, same as Lectura, and the pre-existing quirks counted", () => {
  const f = analyse("Uno.\r\n[[separador]]\r\n [[separador]]\nVer [[separador]] aquí.\n​\nDos.");
  assert.equal(f.identical, true);
  assert.equal(f.sameAsReading, true);
  assert.equal(f.markerLookingText.length, 2, "CRLF and no-break space: text, as in Lectura");
  assert.equal(f.markersInParagraphs, 1);
  assert.equal(f.invisibleLines, 1);
  assert.equal(f.crlfLines, 2);
  assert.deepEqual(analyse("Bien *cursiva*.").fragileParagraphs, []);
  assert.equal(analyse("x\\**cursiva tras un asterisco*").fragileParagraphs.length, 0, "untouched it reads as it is");
});

test("the built-in sample: every text round-trips and reads like Lectura", () => {
  const md = report(SAMPLE, "muestra");
  assert.match(md, /idéntico, byte a byte \| 48 de 48 \|/);
  assert.match(md, /lo mismo que Lectura y la exportación \| 48 de 48 \|/);
});
