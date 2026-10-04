// Desarrollar escena, phase 3 (docs/asistente-contexto.md §1.1, 1.5, 1.6): the current chapter
// from its start, who is in the scene (named anywhere in the text before the cursor, or on
// stage in the previous chapter when the scene opens a chapter), the relationships of those
// chosen, and the whole novel without the text around the cursor sent twice.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { STACK, aiLog, clearAiLog, client, login, resetDb } from "./helpers.mjs";

const KEY = process.env.E2E_SERVICE_KEY;
async function insert(table, row) {
  const res = await fetch(`${STACK}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
}

const para = (n, tag = "") => `Párrafo ${n}${tag}: la lluvia caía sobre el puerto y nadie decía nada en la cocina.`;
let call, novel, ch, people;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Fase tres" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: "Dos" })).data.id);
  const first = "Capítulo uno. Marta y Pilar discuten en el muelle. FINAL-DEL-UNO.";
  const r = await call(`/api/chapters/${ch[0]}`, "PATCH", { content: first, revision: 0 });
  people = {};
  for (const name of ["Pilar", "Héctor", "Anaís", "Marta", "Rosa"])
    people[name] = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name })).data;
  await call(`/api/novels/${novel}/memory/relationships`, "POST", { from_id: people["Héctor"].id, to_id: people["Rosa"].id, kind: "debe dinero a" });
  await insert("chapter_digests", {
    chapter_id: ch[0],
    novel_id: novel,
    source_revision: r.data.revision,
    summary: "Marta y Pilar discuten en el muelle.",
    presence: [{ character: people["Marta"].id, kind: "present" }, { character: people["Pilar"].id, kind: "present" }],
  });
});

const scene = (content, extra = {}) =>
  call("/api/assist", "POST", {
    novelId: novel,
    chapterId: ch[1],
    content,
    provider: "anthropic",
    mode: "scene",
    argument: "Pilar sale a la calle.",
    cursor: content.length,
    length: "breve",
    ...extra,
  });
const dry = async (content, extra) => (await scene(content, { ...extra, dryRun: true })).data;
const byId = (sections) => Object.fromEntries(sections.map((x) => [x.id, x]));
async function sent(content, extra) {
  await clearAiLog();
  await scene(content, extra);
  const body = (await aiLog())[0].body;
  return { system: body.system.map((b) => b.text).join("\n"), prompt: body.messages[0].content };
}

test("capítulo largo: va desde su inicio, no sólo las últimas ≈1.000 palabras", async () => {
  const text = ["INICIO-DEL-CAPITULO.", ...Array.from({ length: 120 }, (_, i) => para(i))].join("\n\n");
  const d = await dry(text);
  assert.deepEqual(byId(d.sections).chapter.items.map((i) => i.label).slice(0, 1), ["Desde el inicio del capítulo"]);
  const { prompt } = await sent(text);
  assert.match(prompt, /<capitulo_hasta_aqui>\nINICIO-DEL-CAPITULO\./);
  assert.ok(prompt.indexOf("</capitulo_hasta_aqui>") < prompt.indexOf("<antes>"));
  assert.doesNotMatch(prompt, /\[…\]/);
  assert.doesNotMatch(prompt, /<capitulo_anterior>/, "the chapter is long: not the end of the previous one");
});

test("capítulo muy largo: el comienzo y la parte final; lo intermedio se omite y se dice", async () => {
  const text = ["INICIO-DEL-CAPITULO.", ...Array.from({ length: 500 }, (_, i) => para(i, i === 300 ? " MEDIO-OMITIDO" : ""))].join("\n\n");
  const d = await dry(text);
  const item = byId(d.sections).chapter.items[0];
  assert.match(item.label, /^Desde el inicio: ≈/);
  assert.match(item.note, /^se omiten ≈[\d.]+ palabras intermedias$/);
  const { prompt } = await sent(text);
  assert.match(prompt, /<capitulo_hasta_aqui>\nINICIO-DEL-CAPITULO\./);
  assert.match(prompt, /\(se omite una parte intermedia de ≈\d+ palabras\)/);
  assert.match(prompt, /\n\[…\]\n<\/capitulo_hasta_aqui>/);
  assert.ok(!prompt.includes("MEDIO-OMITIDO"));
  assert.match(prompt, /Párrafo 499/, "the text right before the cursor");
});

test("personajes: nombrados en todo el texto anterior, no sólo en las últimas 250 palabras", async () => {
  const text = ["Anaís cerró la puerta.", ...Array.from({ length: 30 }, (_, i) => para(i))].join("\n\n");
  const d = await dry(text);
  const who = byId(d.sections).characters.items.map((i) => [i.label, i.reason]);
  assert.deepEqual(who.find(([n]) => n === "Anaís"), ["Anaís", "nombrado en el texto anterior"]);
});

test("al empezar un capítulo entran quienes estaban en escena en el anterior; más adelante, no", async () => {
  const early = "Amanecía.";
  const d = await dry(early);
  assert.deepEqual(
    byId(d.sections).characters.items.map((i) => [i.label, i.reason]),
    [["Pilar", "nombrado en el argumento"], ["Marta", "en escena en el capítulo anterior"]],
  );
  const { system } = await sent(early);
  assert.match(system, /### Marta/);

  const late = Array.from({ length: 150 }, (_, i) => para(i)).join("\n\n");
  const later = await dry(late);
  assert.deepEqual(byId(later.sections).characters.items.map((i) => i.label), ["Pilar"]);
});

test("relaciones de quien eliges en «En escena», con cualquiera (el otro sólo por su nombre)", async () => {
  const text = Array.from({ length: 150 }, (_, i) => para(i)).join("\n\n");
  const extra = { characterIds: [people["Héctor"].id] };
  const d = await dry(text, extra);
  assert.deepEqual(byId(d.sections).relationships.items.map((i) => i.label), ["Héctor → debe dinero a → Rosa"]);
  assert.ok(!byId(d.sections).characters.items.some((i) => i.label === "Rosa"));
  const { system } = await sent(text, extra);
  assert.match(system, /Héctor → debe dinero a → Rosa/);
  assert.doesNotMatch(system, /### Rosa/);
});

test("con la novela completa, el texto alrededor del cursor no va dos veces: el cursor va marcado en ella", async () => {
  const text = "ANTES-DEL-CURSOR. Pilar entra.\n\nDESPUES-DEL-CURSOR.";
  const cursor = text.indexOf("\n\nDESPUES");
  const d = await dry(text, { includeManuscript: true, cursor });
  const sec = byId(d.sections);
  assert.deepEqual(sec.chapter.items.map((i) => i.label), ["El lugar del cursor, marcado en la novela completa"]);
  assert.equal(sec.previous, undefined);
  const { system, prompt } = await sent(text, { includeManuscript: true, cursor });
  assert.match(system, /ANTES-DEL-CURSOR\. Pilar entra\.\n\n⟦AQUÍ VA LA ESCENA NUEVA⟧\n\n\n\nDESPUES-DEL-CURSOR/);
  assert.match(system, /FINAL-DEL-UNO/);
  for (const twice of ["ANTES-DEL-CURSOR", "DESPUES-DEL-CURSOR", "FINAL-DEL-UNO", "<antes>", "<despues>"])
    assert.ok(!prompt.includes(twice), twice);
  assert.match(prompt, /La escena va exactamente donde el manuscrito completo dice ⟦AQUÍ VA LA ESCENA NUEVA⟧/);
});
