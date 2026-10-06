import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorAt, placeAtEnd, resolveAnchor } from "@/lib/placement";

const apply = (content: string, scene: string) => {
  const p = placeAtEnd(content, scene);
  return content.slice(0, p.start) + p.text + content.slice(p.end);
};

test("placeAtEnd: its own paragraph after the last content, whatever the chapter ends with", () => {
  assert.equal(apply("Uno.", "Escena."), "Uno.\n\nEscena.");
  assert.equal(apply("Uno.\n", "Escena."), "Uno.\n\nEscena.");
  assert.equal(apply("Uno.  \n\n\n", " Escena.\n"), "Uno.\n\nEscena.");
  assert.equal(apply("Uno.\n\n[[separador]]", "Escena."), "Uno.\n\n[[separador]]\n\nEscena.");
  const img = "[[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]]";
  assert.equal(apply(`Uno.\n\n${img}\n`, "Escena."), `Uno.\n\n${img}\n\nEscena.`);
  assert.equal(apply("", "Escena."), "Escena.");
  assert.equal(apply("  \n", "Escena."), "Escena.");
});

test("resolveAnchor: the fixed place survives typing before it, and is lost only if its surroundings are", () => {
  const text = "Primero.\n\nSegundo párrafo.\n\nTercero.";
  const at = text.indexOf("\n\nTercero");
  const a = anchorAt(text, at);
  assert.equal(resolveAnchor(text, a), at);
  // Typing earlier shifts the number, not the place.
  const typed = `Algo nuevo al principio. ${text}`;
  assert.equal(resolveAnchor(typed, a), at + "Algo nuevo al principio. ".length);
  // Typing after it doesn't matter either (the anchor's text is still around it).
  assert.equal(resolveAnchor(`${text} Fin.`, a), at);
  // The surroundings rewritten: no place, never a guess.
  assert.equal(resolveAnchor("Otro texto completamente distinto.", a), null);
  // Fixed before the first paragraph, or after the last one: it stays there when text is added around.
  assert.equal(resolveAnchor(`Antes. ${text}`, anchorAt(text, 0)), "Antes. ".length);
  assert.equal(resolveAnchor(`${text}\n\nMás.`, anchorAt(text, text.length)), text.length);
  assert.equal(resolveAnchor("", anchorAt("", 0)), 0);
});
