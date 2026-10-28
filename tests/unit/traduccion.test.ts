import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingTerms, termsIn, type GlossaryEntry } from "../../src/lib/translation/glossary";
import { blockPrompt, parseTable, splitBlocks, translatedText } from "../../src/lib/translation/blocks";

const glossary: GlossaryEntry[] = [
  { term: "ampolleta", meaning: "bombilla", target: "light bulb", status: "confirmado" },
  { term: "pa'", meaning: "para", target: "for", status: "confirmado" },
  { term: "ricura", meaning: "cariño, término afectuoso", target: "sweetheart", status: "pendiente" },
];

test("glosario: encuentra términos como palabra completa, incluido pa' y tildes", () => {
  assert.deepEqual(termsIn("Prende la ampolleta.", glossary).map((e) => e.term), ["ampolleta"]);
  assert.deepEqual(termsIn("Vamos pa' la pieza.", glossary).map((e) => e.term), ["pa'"]);
  // No dentro de otra palabra.
  assert.deepEqual(termsIn("Una ampolletas nuevas", glossary), []);
  assert.deepEqual(termsIn("nada aquí", glossary), []);
});

test("glosario: los términos pendientes se separan para revisarlos", () => {
  assert.deepEqual(pendingTerms(glossary).map((e) => e.term), ["ricura"]);
});

test("bloques: parte por párrafos enteros y nunca corta uno", () => {
  const text = ["Uno.", "Dos dos.", "Tres.", "Cuatro muy largo"].join("\n\n");
  assert.deepEqual(splitBlocks(text, 20),["Uno.\n\nDos dos.", "Tres.", "Cuatro muy largo"]);
  const huge = "a".repeat(50);
  assert.deepEqual(splitBlocks(`${huge}\n\nb`, 10), [huge, "b"]);
  assert.deepEqual(splitBlocks("", 10), []);
});

test("tabla: lee cuatro columnas, ignora cabecera y guiones", () => {
  const md = [
    "| Original | Chilenismos | Inglés | Nota |",
    "|---|---|---|---|",
    "| Prende la ampolleta. | ampolleta | Turn on the light bulb. | — |",
    "| Vamos pa' la pieza. | pa', pieza | Let's go to the bedroom. | ¿? |",
  ].join("\n");
  const rows = parseTable(md);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].marked, "pa', pieza");
  assert.equal(translatedText(rows), "Turn on the light bulb.\n\nLet's go to the bedroom.");
});

test("tabla: rechaza filas con otro número de columnas", () => {
  assert.throws(() => parseTable("| a | b | c |"), /4 columnas/);
});

test("prompt del bloque: pide sólo la tabla y lleva el glosario y los nombres", () => {
  const p = blockPrompt({ block: "Vamos pa' la pieza.", glossary, names: ["Sonia", "Brian"] });
  assert.match(p, /SÓLO una tabla Markdown con cuatro columnas/);
  assert.match(p, /«pa'» = para → en inglés: «for»/);
  assert.match(p, /«ricura».*pendiente/);
  assert.match(p, /Sonia, Brian/);
  assert.match(p, /No añadas nada que no esté en el original/);
  assert.doesNotMatch(p, /Último párrafo ya aprobado/);
  const withPrev = blockPrompt({ block: "x", glossary: [], names: [], previous: "Anterior." });
  assert.match(withPrev, /Último párrafo ya aprobado[\s\S]*Anterior\./);
  assert.match(withPrev, /\(sin entradas\)/);
});
