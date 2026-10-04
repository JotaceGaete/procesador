import { test } from "node:test";
import assert from "node:assert/strict";
import { mightBeRequest, newState, parseRequests, serve, type DeepLimits, type ToolContext } from "@/lib/advisor/deep";
import type { ChapterDigest, Memory } from "@/lib/types";

// A long novel: 30 chapters; what matters is in 3 and 27, far apart.
const chapters = Array.from({ length: 30 }, (_, i) => ({
  id: `c${i + 1}`,
  title: "",
  revision: 1,
  content: Array.from({ length: 6 }, (_, k) => `Capítulo ${i + 1}, párrafo ${k}: la casa seguía en silencio.`).join("\n\n"),
}));
chapters[2].content += "\n\nElena juró que nunca había visto el mar.";
chapters[26].content += "\n\nElena recordó los veranos en Cartagena, frente al mar.";
chapters[9].content += "\n\nMarta guardó la carta en el cajón.";

const memory: Memory = {
  characters: [
    { id: "e", name: "Elena", aliases: "la Rubia", description: "Nació en Santiago." } as never,
    { id: "m", name: "Marta", aliases: "" } as never,
  ],
  relationships: [{ id: "r", from_id: "e", to_id: "m", kind: "hermana de", note: "" } as never],
  places: [],
  facts: [
    { id: "f1", text: "Elena nunca salió de Santiago antes de los veinte.", chapter_id: "c3", status: "approved", character_ids: ["e"], story_time: "" } as never,
    { id: "f2", text: "Sugerencia sin aprobar.", chapter_id: null, status: "suggested", character_ids: ["e"], story_time: "" } as never,
  ],
};
const digest = (id: string, extra: Partial<ChapterDigest>): ChapterDigest =>
  ({ chapter_id: id, source_revision: 1, summary: `Resumen de ${id}.`, events: [], presence: [], revelations: [], threads: [], notes: "", author_edited: false, ...extra }) as ChapterDigest;
const digests = new Map([
  ["c3", digest("c3", { events: [{ text: "Elena jura no conocer el mar", characters: ["e"], quote: "nunca había visto el mar" }] })],
  ["c12", digest("c12", { summary: "Corrección del autor.", author_edited: true, revelations: [{ text: "Marta sabe de la carta", to: "m", quote: "" }] })],
  ["c10", digest("c10", { source_revision: 0, threads: [{ thread: "t", change: "opened", quote: "Marta guardó la carta en el cajón" }] })],
]);
const ctx: ToolContext = {
  chapters,
  digests,
  memory,
  threads: [{ id: "t", title: "La carta de Marta", status: "open", confirmed: true, description: "" } as never],
  current: 26,
  plain: (t) => t,
};
const limits: DeepLimits = { rounds: 3, perRound: 6, materialTokens: 40_000, chapters: 2, chapterTokens: 20_000, costUsd: 0.5 };

test("requests: parsed only when the text is a request; a partial tag is held back", () => {
  assert.deepEqual(parseRequests('<solicitar>\n[{"tipo":"ficha","capitulo":3}]\n</solicitar>'), [{ tipo: "ficha", capitulo: 3 }]);
  assert.deepEqual(parseRequests('<solicitar>{"tipo":"capitulo","capitulo":3}</solicitar>'), [{ tipo: "capitulo", capitulo: 3 }]);
  assert.deepEqual(parseRequests("<solicitar>roto</solicitar>"), []);
  assert.equal(parseRequests("Una respuesta normal."), null);
  assert.ok(mightBeRequest("  <soli"));
  assert.ok(mightBeRequest("<solicitar>[{"));
  assert.ok(!mightBeRequest("## Lectura"));
});

test("pasajes: connects chapter 3 with chapter 27 by words and character, in novel order", () => {
  const { text, items } = serve(ctx, newState(limits), [{ tipo: "pasajes", buscar: "mar", personaje: "Elena" }]);
  const i3 = text.indexOf("[Capítulo 3]\nElena juró que nunca había visto el mar.");
  const i27 = text.indexOf("[Capítulo 27]\nElena recordó los veranos en Cartagena");
  assert.ok(i3 !== -1 && i27 !== -1 && i3 < i27, text);
  assert.deepEqual(items[0].chapters, ["c3", "c27"]);
  assert.match(items[0].label, /pasajes «mar» · Elena \(2\)/);
  // By alias, limited to some chapters.
  const only = serve(ctx, newState(limits), [{ tipo: "pasajes", buscar: "mar", personaje: "la Rubia", capitulos: [3] }]);
  assert.deepEqual(only.items[0].chapters, ["c3"]);
});

test("ficha, revelaciones, personaje, hechos, relaciones, cabo: structured material, read-only", () => {
  const { text, items } = serve(ctx, newState(limits), [
    { tipo: "ficha", capitulo: 3 },
    { tipo: "ficha", capitulo: 12 },
    { tipo: "ficha", capitulo: 5 },
    { tipo: "revelaciones" },
    { tipo: "personaje", nombre: "Elena" },
    { tipo: "hechos", personaje: "Elena" },
  ]);
  assert.match(text, /### Ficha de Capítulo 3\nResumen de c3\.\n- Elena jura no conocer el mar \(Elena\) «nunca había visto el mar»/);
  assert.match(text, /### Ficha de Capítulo 12 \(corregida por el autor\)\nCorrección del autor\./, "the author's correction, as it is");
  assert.match(text, /\(Capítulo 5 aún no tiene ficha: pide pasajes o el capítulo\)/);
  assert.match(text, /- Capítulo 12: Marta sabe de la carta → Marta/);
  assert.match(text, /### Personaje: Elena[\s\S]*Nació en Santiago[\s\S]*Aparece en los capítulos \(menciones\): 3 \(1\), 27 \(1\)\./);
  assert.match(text, /- Capítulo 3: Elena jura no conocer el mar «nunca había visto el mar»/);
  assert.match(text, /Elena nunca salió de Santiago antes de los veinte\. \(Capítulo 3\)/);
  assert.doesNotMatch(text, /Sugerencia sin aprobar/, "suggested facts are not canon");
  assert.deepEqual(items.map((i) => i.label), ["ficha del cap. 3", "ficha del cap. 12", "revelaciones (1)", "personaje · Elena", "hechos (1)"]);

  const more = serve(ctx, newState(limits), [{ tipo: "relaciones", personaje: "Marta" }, { tipo: "cabo", titulo: "carta" }]);
  assert.match(more.text, /Elena → hermana de → Marta/);
  assert.match(more.text, /### Cabo «La carta de Marta» \(open\)[\s\S]*- Capítulo 10: se abre\n  Marta guardó la carta en el cajón\./);
});

test("ficha of a changed chapter says so", () => {
  const { text } = serve(ctx, newState(limits), [{ tipo: "ficha", capitulo: 10 }]);
  assert.match(text, /Ficha de Capítulo 10 \(de una versión anterior del capítulo\)/);
});

test("limits: full chapters per query, requests per round, repeats, material budget, unknown tools", () => {
  const state = newState(limits);
  const r = serve(ctx, state, [
    { tipo: "capitulo", capitulo: 3 },
    { tipo: "capitulo", capitulo: 10 },
    { tipo: "capitulo", capitulo: 20 },
    { tipo: "capitulo", capitulo: 27 },
    { tipo: "capitulo", capitulo: 3 },
    { tipo: "inventada" },
    { tipo: "ficha", capitulo: 3 },
  ]);
  assert.match(r.text, /<capitulo numero="3" titulo="">\nCapítulo 3, párrafo 0/);
  assert.match(r.text, /<capitulo numero="10"/);
  assert.match(r.text, /límite de 2 capítulos completos por consulta alcanzado/);
  assert.match(r.text, /Capítulo 27 es el capítulo abierto: ya lo tienes completo/);
  assert.match(r.text, /ya entregado antes: capitulo/);
  assert.match(r.text, /no existe la herramienta «inventada»/);
  assert.match(r.text, /se ignoraron 1 pedidos: como mucho 6 por ronda/);
  assert.deepEqual(r.items.map((i) => i.label), ["cap. 3 completo", "cap. 10 completo"]);

  // A tiny material budget: the text is cut and later requests are refused.
  const tight = newState({ ...limits, materialTokens: 30 });
  const t = serve(ctx, tight, [{ tipo: "capitulo", capitulo: 3 }, { tipo: "ficha", capitulo: 3 }]);
  assert.match(t.text, /recortado: límite de material de esta consulta/);
  assert.match(t.text, /límite de material de esta consulta alcanzado/);
  // A full chapter is capped in size.
  const small = serve(ctx, newState({ ...limits, chapterTokens: 10 }), [{ tipo: "capitulo", capitulo: 3 }]);
  assert.match(small.text, /recortado por el límite de tamaño/);
});

test("names that don't exist, chapters out of range", () => {
  const { text, items } = serve(ctx, newState(limits), [
    { tipo: "personaje", nombre: "Nadie" },
    { tipo: "ficha", capitulo: 99 },
    { tipo: "pasajes", buscar: "zzzz" },
  ]);
  assert.match(text, /no hay ningún personaje llamado «Nadie»/);
  assert.match(text, /no existe el capítulo 99/);
  assert.match(text, /sin pasajes para «zzzz»/);
  assert.equal(items.length, 0);
});
