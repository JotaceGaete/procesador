import { test } from "node:test";
import assert from "node:assert/strict";
import { schema, toDoc, toContent, posToOffset, offsetToPos, layout, canonicalLine } from "@/lib/visual/document";
import { present } from "@/lib/presentation";
import type { Node as PMNode } from "prosemirror-model";

const ID = "3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10";
const ID2 = "00000000-1111-4222-8333-444444444444";

/** Texts as real chapters are typed and pasted. */
export const TRICKY: Record<string, string> = {
  vacío: "",
  "sólo blancos": " \n\t\n",
  simple: "Hola.",
  "un Enter": "Uno.\nDos.\n—Diálogo —dijo.",
  "líneas en blanco": "Uno.\n\nDos.\n\n\n\nTres.\n",
  CRLF: "Uno.\r\n\r\nDos.\r\n",
  "CRLF con marcadores": `Uno.\r\n[[separador]]\r\n[[imagen:${ID}]]\r\nDos.`,
  invisibles: "Uno.\n​\nDos.\n﻿­\n\nTres.",
  "blanco al principio y al final": "\n\n  Uno.  \n\n\tDos.\t\n\n\n",
  cursivas: "Leyó *Rayuela* y *El túnel* de un *tirón*.",
  "cursiva pegada": "pala*bra*s y *x* y fin*al*",
  "asteriscos sueltos": "5 * 3 = 15, un * suelto y **negrita** y *** y \\*escapado\\* y * espacio *",
  "barra invertida": "a\\\\*b* c\\d \\",
  separadores: "Uno.\n\n[[separador]]\n\nDos.\n  [[SEPARADOR]]  \nTres.",
  imágenes: `Uno.\n\n[[imagen:${ID}]]\n\n  [[imagen:${ID2.toUpperCase()}]]\t\nDos.`,
  "marcadores dentro de un párrafo": `Ver [[imagen:${ID}]] aquí y [[separador]] allá.`,
  "marcador roto": "[[imagen:no-es-un-id]]\n[[separador]] x",
  "sólo un bloque": "[[separador]]",
  "bloques seguidos": `[[imagen:${ID}]]\n[[separador]]\n[[imagen:${ID}]]`,
  emoji: "Llovía 🌧️ sobre 👩‍👩‍👧 la ciudad.\n\n«Comillas» y —rayas—.",
};

/** What a reader sees (Lectura, the exports): present() of the text. */
const seen = (content: string) =>
  present(content).map((b) => (b.kind === "para" ? `¶${b.spans.map((s) => (s.italic ? `<${s.text}>` : s.text)).join("")}` : b.kind === "image" ? `img:${b.id}` : "break"));

/** What the document shows. */
const shown = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((n) => {
    if (n.type === schema.nodes.paragraph) {
      if (!n.textContent) return; // an empty paragraph shows nothing
      let s = "¶";
      n.forEach((c) => (s += c.marks.length ? `<${c.text}>` : c.text));
      out.push(s.replace(/></g, ""));
    } else out.push(n.type === schema.nodes.image ? `img:${n.attrs.id}` : "break");
  });
  return out;
};
const norm = (xs: string[]) => xs.map((x) => x.replace(/></g, ""));

test("toDoc → toContent: exactly the same text, byte for byte", () => {
  for (const [name, content] of Object.entries(TRICKY)) assert.equal(toContent(toDoc(content)), content, name);
});

test("the document shows what Lectura and the exports show (present)", () => {
  for (const [name, content] of Object.entries(TRICKY)) assert.deepEqual(shown(toDoc(content)), norm(seen(content)), name);
});

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const PIECES = ["a", "b", "Hola", " ", "  ", "\t", "*", "**", "\\", "\\*", "—", "​", " ", "\r", "é", "[[separador]]", `[[imagen:${ID}]]`, "[[", "]]"];
function randomText(r: () => number) {
  const lines: string[] = [];
  const n = Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    let line = "";
    const m = Math.floor(r() * 7);
    for (let j = 0; j < m; j++) line += PIECES[Math.floor(r() * PIECES.length)];
    lines.push(line);
  }
  return lines.join("\n");
}

test("fuzz: 5.000 random texts round-trip and read like present()", () => {
  const r = rand(42);
  for (let i = 0; i < 5000; i++) {
    const c = randomText(r);
    const doc = toDoc(c);
    assert.equal(toContent(doc), c, JSON.stringify(c));
    assert.deepEqual(shown(doc), norm(seen(c)), JSON.stringify(c));
  }
});

/** Replaces block k's content (as the editor does when the author types in it). */
function editParagraph(doc: PMNode, k: number, runs: [string, boolean][]) {
  const children: PMNode[] = [];
  doc.forEach((n, _p, i) => {
    if (i !== k) return children.push(n);
    const text = runs.filter(([t]) => t).map(([t, it]) => schema.text(t, it ? [schema.marks.italic.create()] : []));
    children.push(schema.nodes.paragraph.create(n.attrs, text));
  });
  return schema.nodes.doc.create(doc.attrs, children);
}

test("editing a paragraph rewrites that line only; the rest stays byte for byte", () => {
  const content = "Uno  *con cursiva* \\* raro.\r\n\n​\n[[separador]]\n\nDos.\n\n\n[[imagen:" + ID + "]]\t\nTres *final*.\n\n";
  const doc = toDoc(content);
  const edited = editParagraph(doc, 2, [["Dos ", false], ["cambiado", true], [".", false]]);
  const out = toContent(edited);
  assert.equal(out, content.replace("Dos.", "Dos *cambiado*."));
});

test("a paragraph typed in the editor comes back the same (canonical form)", () => {
  const r = rand(7);
  const alphabet = ["a", "b", " ", "*", "\\", "é", "—", ".", "x y"];
  let unrepresentable = 0;
  for (let i = 0; i < 3000; i++) {
    const runs: [string, boolean][] = [];
    const n = 1 + Math.floor(r() * 4);
    for (let j = 0; j < n; j++) {
      let t = "";
      const m = 1 + Math.floor(r() * 5);
      for (let k = 0; k < m; k++) t += alphabet[Math.floor(r() * alphabet.length)];
      runs.push([t, r() < 0.5]);
    }
    // A paragraph's blank edges are not content (Lectura and the exports trim them too).
    runs[0][0] = runs[0][0].trimStart();
    runs[runs.length - 1][0] = runs[runs.length - 1][0].trimEnd();
    if (!runs.some(([t]) => t.trim())) continue;
    const doc = editParagraph(toDoc("x"), 0, runs);
    const back = toDoc(toContent(doc));
    // Same letters, same italics; whether a space is italic doesn't show (and the format keeps
    // the asterisks next to letters, so spaces at the edge of an italic move out of it).
    const letters = (d: PMNode) => {
      let out = "";
      d.forEach((n) => n.forEach((c) => (out += [...(c.text ?? "")].map((ch) => (/\s/.test(ch) ? " " : c.marks.length ? `<${ch}>` : ch)).join(""))));
      return out.trim();
    };
    if (letters(doc) === letters(back)) continue;
    // The only texts the format can't hold (nor could the plain-text editor): an asterisk or a
    // backslash right next to the asterisk of an italic. Counted, and required to be rare.
    const merged: [string, boolean][] = [];
    for (const [t, it] of runs) if (t) merged.at(-1)?.[1] === it ? (merged.at(-1)![0] += t) : merged.push([t, it]);
    const touching = merged.some(([t, it], k) => {
      if (!it || !t.trim()) return false;
      const body = t.trim();
      const prev = k > 0 && t.trimStart() === t ? merged[k - 1][0] : "";
      return /[*\\]$/.test(body) || /[*\\]$/.test(prev);
    });
    assert.ok(touching, `representable but changed: ${JSON.stringify(runs)} → ${canonicalLine(doc.firstChild!)}`);
    unrepresentable++;
  }
  // Every failure above is that edge case (the alphabet is full of asterisks on purpose).
  assert.ok(unrepresentable > 0 && unrepresentable < 3000);
});

test("prose typed in the editor (letters, punctuation, dashes, quotes, italics) always comes back identical", () => {
  const r = rand(11);
  const alphabet = ["Llovía", " ", "sobre", "la ciudad", ",", ".", "—", "¿qué?", "«así»", "é", "ñ", "…", "\u00a0".replace("\\u00a0", "\u00a0")];
  for (let i = 0; i < 3000; i++) {
    const runs: [string, boolean][] = [];
    const n = 1 + Math.floor(r() * 5);
    for (let j = 0; j < n; j++) {
      let t = "";
      const m = 1 + Math.floor(r() * 6);
      for (let k = 0; k < m; k++) t += alphabet[Math.floor(r() * alphabet.length)];
      runs.push([t, r() < 0.4]);
    }
    const doc = editParagraph(toDoc("x"), 0, runs);
    const once = toContent(doc);
    // Written once, read and written again: the same line (stable), and the same letters and italics.
    assert.equal(toContent(toDoc(once)), once);
    const lettersOf = (d: PMNode) => {
      let out = "";
      d.forEach((nd) => nd.forEach((c) => (out += [...(c.text ?? "")].map((ch) => (/\s/.test(ch) ? " " : c.marks.length ? `<${ch}>` : ch)).join(""))));
      return out.trim();
    };
    assert.equal(lettersOf(toDoc(once)), lettersOf(doc), JSON.stringify(runs));
  }
});

test("positions ↔ offsets: every place in every paragraph maps back to itself", () => {
  for (const [name, content] of Object.entries(TRICKY)) {
    const doc = toDoc(content);
    for (const b of layout(doc).blocks) {
      if (!b.node.isTextblock) continue;
      for (let p = b.pos + 1; p <= b.pos + b.size - 1; p++) {
        const o = posToOffset(doc, p);
        assert.equal(offsetToPos(doc, o), p, `${name} @${p} → ${o}`);
      }
    }
  }
});

test("selection offsets keep italics whole, and an image's line is its marker", () => {
  const content = `Leyó *Rayuela* entera.\n\n[[imagen:${ID}]]\n\nFin.`;
  const doc = toDoc(content);
  const [p, img] = layout(doc).blocks;
  // «Rayuela» selected: from its first letter to its last.
  const from = p.pos + 1 + "Leyó ".length;
  const to = from + "Rayuela".length;
  assert.equal(content.slice(posToOffset(doc, from, "start"), posToOffset(doc, to, "end")), "*Rayuela*");
  // The caret right before it is before the opening asterisk (typing there is not italic).
  assert.equal(content.slice(0, posToOffset(doc, from)), "Leyó ");
  assert.equal(content.slice(posToOffset(doc, img.pos, "start"), posToOffset(doc, img.pos + 1, "end")), `[[imagen:${ID}]]`);
  // End of a paragraph that ends in italics: after the closing asterisk.
  const d2 = toDoc("Al *final*");
  assert.equal(posToOffset(d2, d2.firstChild!.nodeSize - 1), "Al *final*".length);
});

test("new paragraphs follow the chapter's habit (one newline or a blank line)", () => {
  for (const [content, gap] of [["a\nb\nc", "\n"], ["a\n\nb\n\nc", "\n\n"], ["a", "\n\n"]] as const) {
    const doc = toDoc(content);
    const fresh = schema.nodes.doc.create(doc.attrs, [...Array.from({ length: doc.childCount }, (_, i) => doc.child(i)), schema.nodes.paragraph.create(null, schema.text("nuevo"))]);
    assert.equal(toContent(fresh), `${content}${gap}nuevo`);
  }
});
