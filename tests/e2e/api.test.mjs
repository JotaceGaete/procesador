// API end to end against Postgres + PostgREST and mock AI providers.
// Tests run in order and share state (two novels built step by step).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

let call;
const s = {}; // shared state: ids created along the way

before(async () => {
  await resetDb();
  call = client(await login());
});

const created = async (novel, kind, json) => {
  const r = await call(`/api/novels/${novel}/memory/${kind}`, "POST", json);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const chapterText = async (id) => (await call(`/api/chapters/${id}`)).data.content;

// ---------------------------------------------------------------- library

test("library: two novels, each created with a first chapter", async () => {
  s.A = (await call("/api/novels", "POST", { title: "La casa de lejía" })).data.id;
  s.B = (await call("/api/novels", "POST", { title: "Otra novela" })).data.id;
  const lib = (await call("/api/novels")).data;
  assert.equal(lib.length, 2);
  assert.ok(lib.every((n) => n.chapters === 1 && n.words === 0));
});

test("library: rename", async () => {
  const r = await call(`/api/novels/${s.B}`, "PATCH", { title: "Otra novela (borrador)" });
  assert.equal(r.data.title, "Otra novela (borrador)");
  assert.equal((await call(`/api/novels/${s.B}`, "PATCH", { title: "  " })).status, 400);
});

// ---------------------------------------------------------------- chapters & revisions

test("chapters: a text save carries its revision and bumps it", async () => {
  const a = (await call(`/api/novels/${s.A}`)).data;
  s.ch1 = a.chapters[0].id;
  const r = await call(`/api/chapters/${s.ch1}`, "PATCH", {
    content: "Juan llegó de madrugada.\n\nElena no dormía.",
    revision: 0,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.revision, 1);
});

test("revisions: a save based on an old revision is rejected and changes nothing", async () => {
  const r = await call(`/api/chapters/${s.ch1}`, "PATCH", { content: "versión vieja", revision: 0 });
  assert.equal(r.status, 409);
  assert.ok((await chapterText(s.ch1)).startsWith("Juan llegó"));
  assert.equal((await call(`/api/chapters/${s.ch1}`, "PATCH", { content: "x" })).status, 400, "text saves require a revision");
});

test("revisions: renaming a chapter doesn't change its revision", async () => {
  const r = await call(`/api/chapters/${s.ch1}`, "PATCH", { title: "La llegada" });
  assert.equal(r.data.revision, 1);
});

test("chapters: each one keeps its own revision line", async () => {
  s.ch2 = (await call(`/api/novels/${s.A}/chapters`, "POST", {})).data.id;
  const r3 = await call(`/api/novels/${s.A}/chapters`, "POST", { title: "El incendio" });
  s.ch3 = r3.data.id;
  assert.deepEqual(
    r3.data.chapters.map((c) => c.title),
    ["La llegada", "Capítulo 2", "El incendio"],
  );
  await call(`/api/chapters/${s.ch2}`, "PATCH", {
    content: "Marta habló con Elena en la cocina. Elena le dijo que Juan mentía.",
    revision: 0,
  });
  await call(`/api/chapters/${s.ch3}`, "PATCH", { content: "Ardió la bodega del puerto.", revision: 0 });
  const r = await call(`/api/chapters/${s.ch2}`, "PATCH", {
    content: "Marta habló con Elena en la cocina. Elena le dijo que Juan mentía. Juan escuchaba detrás de la puerta.",
    revision: 1,
  });
  assert.equal(r.status, 200, "chapter 2 is at revision 1 regardless of chapter 1");
});

test("chapters: reorder (positions change, revisions don't)", async () => {
  const r = await call(`/api/novels/${s.A}/chapters`, "PUT", { ids: [s.ch1, s.ch3, s.ch2] });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.map((c) => c.id),
    [s.ch1, s.ch3, s.ch2],
  );
  assert.equal((await call(`/api/chapters/${s.ch2}`)).data.revision, 2);
  assert.equal(
    (await call(`/api/novels/${s.A}/chapters`, "PUT", { ids: [s.ch1, s.ch2] })).status,
    400,
    "incomplete list rejected",
  );
});

test("chapters: a novel can't lose its only chapter", async () => {
  s.bCh = (await call(`/api/novels/${s.B}`)).data.chapters[0].id;
  assert.equal((await call(`/api/chapters/${s.bCh}`, "DELETE")).status, 400);
});

test("library: word and chapter counts", async () => {
  const a = (await call("/api/novels")).data.find((n) => n.id === s.A);
  assert.equal(a.chapters, 3);
  assert.ok(a.words > 20);
});

// ---------------------------------------------------------------- narrative memory

test("memory: characters, relationship, place and fact", async () => {
  s.juan = await created(s.A, "characters", {
    name: "Juan Ortega",
    aliases: "el Flaco",
    voice: "Seco, frases cortas",
    secrets: "Estuvo con Marta",
  });
  s.elena = await created(s.A, "characters", { name: "Elena", knows: "Que Juan estuvo con Marta" });
  s.marta = await created(s.A, "characters", { name: "Marta" });
  s.rosa = await created(s.A, "characters", { name: "Rosa", role: "vecina" });
  s.pedroB = await created(s.B, "characters", { name: "Pedro" });
  const rel = await created(s.A, "relationships", {
    from_id: s.elena.id,
    to_id: s.juan.id,
    kind: "desconfía de",
    note: "desde el verano",
  });
  assert.equal(rel.kind, "desconfía de");
  s.casa = await created(s.A, "places", {
    name: "Casa de Elena",
    aliases: "la casa",
    description: "Casa antigua de dos pisos en Valparaíso. Cocina pequeña.",
  });
  s.fact = await created(s.A, "facts", {
    text: "Juan todavía no sabe que Marta habló con Elena.",
    character_ids: [s.juan.id, s.marta.id],
    chapter_id: s.ch2,
    place_id: s.casa.id,
    story_time: "agosto de 1972",
  });
  assert.equal(s.fact.character_ids.length, 2);
  await created(s.A, "facts", { text: "La bodega del puerto ardió el 14 de agosto de 1972.", chapter_id: s.ch3 });
});

test("memory: required fields", async () => {
  assert.equal((await call(`/api/novels/${s.A}/memory/characters`, "POST", { name: " " })).status, 400);
  assert.equal((await call(`/api/novels/${s.A}/memory/facts`, "POST", { text: "" })).status, 400);
  assert.equal((await call(`/api/novels/${s.A}/memory/unknown`, "POST", {})).status, 404);
});

test("memory: update a character and re-link a fact", async () => {
  const r = await call(`/api/memory/characters/${s.rosa.id}`, "PATCH", { fears: "Quedarse sola" });
  assert.equal(r.data.fears, "Quedarse sola");
  const f = await call(`/api/memory/facts/${s.fact.id}`, "PATCH", { character_ids: [s.juan.id] });
  assert.deepEqual(f.data.character_ids, [s.juan.id]);
  await call(`/api/memory/facts/${s.fact.id}`, "PATCH", { character_ids: [s.juan.id, s.marta.id] });
});

// ---------------------------------------------------------------- isolation between novels

test("isolation: relationship with another novel's character → 400", async () => {
  const r = await call(`/api/novels/${s.A}/memory/relationships`, "POST", {
    from_id: s.juan.id,
    to_id: s.pedroB.id,
    kind: "amigo de",
  });
  assert.equal(r.status, 400);
});

test("isolation: fact pointing to another novel's chapter or character → 400, nothing left behind", async () => {
  assert.equal((await call(`/api/novels/${s.A}/memory/facts`, "POST", { text: "x", chapter_id: s.bCh })).status, 400);
  assert.equal((await call(`/api/novels/${s.A}/memory/facts`, "POST", { text: "x", character_ids: [s.pedroB.id] })).status, 400);
  assert.ok(!(await call(`/api/novels/${s.A}`)).data.memory.facts.some((f) => f.text === "x"));
  assert.equal((await call(`/api/memory/facts/${s.fact.id}`, "PATCH", { character_ids: [s.pedroB.id] })).status, 400);
});

test("isolation: novel_id can't be changed from the client", async () => {
  const r = await call(`/api/memory/characters/${s.juan.id}`, "PATCH", { novel_id: s.B, name: "Juan Ortega" });
  assert.equal(r.status, 200);
  assert.equal(r.data.novel_id, s.A);
});

test("isolation: each novel sees only its own memory and chapters", async () => {
  const b = (await call(`/api/novels/${s.B}`)).data;
  assert.deepEqual(
    b.memory.characters.map((c) => c.name),
    ["Pedro"],
  );
  assert.equal(b.memory.facts.length + b.memory.places.length + b.memory.relationships.length, 0);
  assert.equal(b.chapters.length, 1);
  const a = (await call(`/api/novels/${s.A}`)).data;
  assert.equal(a.memory.characters.length, 4);
  assert.ok(!a.memory.characters.some((c) => c.name === "Pedro"));
});

test("isolation: the assistant rejects a chapter from another novel", async () => {
  const r = await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.bCh,
    content: "x",
    dryRun: true,
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: 1,
  });
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------- Guía Maestra

test("Guía Maestra: saved; unknown and empty fields dropped", async () => {
  const r = await call(`/api/novels/${s.A}`, "PATCH", {
    guide: { person: "Tercera persona", tense: "Pasado", language: "Español de Chile", junk: "ignored", tone: "" },
  });
  assert.deepEqual(r.data.guide, { person: "Tercera persona", tense: "Pasado", language: "Español de Chile" });
});

// ---------------------------------------------------------------- duplicate

test("duplicate: full copy with its own ids, independent from the original", async () => {
  s.copy = (await call(`/api/novels/${s.A}/duplicate`, "POST")).data.id;
  const c = (await call(`/api/novels/${s.copy}`)).data;
  assert.equal(c.novel.title, "La casa de lejía (copia)");
  assert.equal(c.chapters.length, 3);
  assert.equal(c.memory.characters.length, 4);
  assert.equal(c.memory.relationships.length, 1);
  assert.equal(c.memory.facts.length, 2);
  assert.deepEqual(c.novel.guide, { person: "Tercera persona", tense: "Pasado", language: "Español de Chile" });
  assert.ok(!c.chapters.some((x) => [s.ch1, s.ch2, s.ch3].includes(x.id)));
  assert.ok(!c.memory.characters.some((x) => x.id === s.juan.id));
  const f = c.memory.facts.find((x) => x.text.startsWith("Juan"));
  assert.ok(f.character_ids.every((id) => c.memory.characters.some((x) => x.id === id)));
  assert.ok(c.chapters.some((x) => x.id === f.chapter_id));
  await call(`/api/chapters/${c.chapters[0].id}`, "PATCH", { content: "Cambiado en la copia", revision: 0 });
  assert.ok((await chapterText(s.ch1)).startsWith("Juan llegó"));
});

// ---------------------------------------------------------------- context building

test("context size (dry run): light edit < novel included; scene measured", async () => {
  s.content1 = await chapterText(s.ch1);
  const base = { novelId: s.A, chapterId: s.ch1, content: s.content1, dryRun: true };
  const light = (
    await call("/api/assist", "POST", { ...base, mode: "edit", action: "redaccion", selectionStart: 0, selectionEnd: 24 })
  ).data;
  const full = (
    await call("/api/assist", "POST", {
      ...base,
      mode: "edit",
      action: "redaccion",
      selectionStart: 0,
      selectionEnd: 24,
      includeManuscript: true,
    })
  ).data;
  const scene = (
    await call("/api/assist", "POST", { ...base, mode: "scene", argument: "Juan llega.", cursor: s.content1.length })
  ).data;
  assert.ok(light.total > 0 && light.manuscript === 0);
  assert.ok(full.total > light.total && full.manuscript > 0);
  assert.ok(scene.total > 0);
  assert.equal((await aiLog()).length, 0, "dry runs never call a provider");
});

test("assist: input validation", async () => {
  const base = { novelId: s.A, chapterId: s.ch1, content: s.content1, provider: "anthropic" };
  assert.equal((await call("/api/assist", "POST", { ...base, mode: "scene", argument: " " })).status, 400);
  assert.equal(
    (await call("/api/assist", "POST", { ...base, mode: "edit", action: "redaccion", selectionStart: 3, selectionEnd: 3 }))
      .status,
    400,
  );
  assert.equal(
    (await call("/api/assist", "POST", { ...base, mode: "edit", action: "personaje", selectionStart: 0, selectionEnd: 5 }))
      .status,
    400,
    "character required",
  );
  assert.equal(
    (
      await call("/api/assist", "POST", {
        ...base,
        provider: "nope",
        mode: "edit",
        action: "redaccion",
        selectionStart: 0,
        selectionEnd: 5,
      })
    ).status,
    400,
  );
});

// ---------------------------------------------------------------- Desarrollar escena (Claude)

test("Desarrollar escena (Claude): WRITE instructions, guide, relevant memory, argument and preceding text", async () => {
  await clearAiLog();
  const r = await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.ch1,
    content: s.content1,
    provider: "anthropic",
    mode: "scene",
    argument:
      "Juan llega de madrugada. Elena sabe que estuvo con Marta, pero no quiere demostrarlo. Conversan mientras Juan prepara café en la casa.",
    cursor: s.content1.length,
    length: "breve",
  });
  assert.ok(events(r.data).some((e) => e.type === "text" && e.text.includes("<escena>")));
  const sent = (await aiLog())[0].body;
  const system = sent.system.map((b) => b.text).join("\n");
  assert.match(system, /El argumento es el plan de la escena y la autoridad sobre lo que ocurre/);
  assert.doesNotMatch(system, /tu trabajo es conservador/);
  assert.match(system, /Persona narrativa: Tercera persona/);
  assert.match(system, /Español de Chile/);
  assert.match(system, /### Juan Ortega/);
  assert.match(system, /### Elena/);
  assert.match(system, /### Marta/);
  assert.doesNotMatch(system, /### Rosa/, "unrelated character left out");
  assert.ok(system.includes("Elena → desconfía de → Juan Ortega"));
  assert.ok(system.includes("Casa antigua de dos pisos"), "place named by alias");
  // Temporal ignorance (docs/asistente-contexto.md §8): writing chapter 1, the fact of chapter 2
  // is not sent at all, not even marked as later.
  assert.ok(!system.includes("Juan todavía no sabe"));
  assert.doesNotMatch(system, /posterior al capítulo actual/);
  assert.ok(!system.includes("Ardió la bodega"), "other chapters' text not sent by default");
  const prompt = sent.messages[0].content;
  assert.ok(prompt.includes("<argumento>") && prompt.includes("Elena no dormía."));
  assert.match(prompt, /alrededor de 300–500 palabras/);
});

// ---------------------------------------------------------------- editing with the other providers

test("light edit (GPT): EDIT instructions with characters only", async () => {
  await clearAiLog();
  const r = await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.ch1,
    content: s.content1,
    provider: "openai",
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: 24,
  });
  assert.ok(events(r.data).some((e) => e.type === "text" && e.text.includes("<reescritura>")));
  const sent = (await aiLog())[0];
  assert.equal(sent.provider, "openai");
  assert.match(sent.body.instructions, /tu trabajo es conservador/);
  assert.match(sent.body.instructions, /### Juan Ortega/);
  assert.doesNotMatch(sent.body.instructions, /Hechos de continuidad/);
  assert.match(sent.body.input, /<seleccion>\nJuan llegó de madrugada\.\n<\/seleccion>/);
});

test("character check (Grok): passages from other chapters and the character's facts", async () => {
  await clearAiLog();
  const content2 = await chapterText(s.ch2);
  await call("/api/assist", "POST", {
    novelId: s.A,
    chapterId: s.ch2,
    content: content2,
    provider: "xai",
    mode: "edit",
    action: "personaje",
    characterIds: [s.juan.id],
    selectionStart: 0,
    selectionEnd: content2.length,
  });
  const sent = (await aiLog())[0];
  assert.equal(sent.provider, "xai");
  assert.ok(sent.body.messages[1].content.includes("<pasajes>"));
  assert.ok(sent.body.messages[1].content.includes("Juan llegó de madrugada"));
  assert.match(sent.body.messages[0].content, /Hechos de continuidad/);
});

test("refusals arrive as an event, for every provider", async () => {
  await call(`/api/novels/${s.A}`, "PATCH", { guide: { instructions: "REFUSE-ME" } });
  for (const provider of ["anthropic", "openai", "xai"]) {
    const r = await call("/api/assist", "POST", {
      novelId: s.A,
      chapterId: s.ch1,
      content: s.content1,
      provider,
      mode: "edit",
      action: "redaccion",
      selectionStart: 0,
      selectionEnd: 24,
    });
    assert.equal(events(r.data).at(-1).type, "refusal", provider);
  }
  await call(`/api/novels/${s.A}`, "PATCH", {
    guide: { person: "Tercera persona", tense: "Pasado", language: "Español de Chile" },
  });
});

// ---------------------------------------------------------------- deletes

test("delete chapter: its facts stay, unlinked", async () => {
  assert.equal((await call(`/api/chapters/${s.ch3}`, "DELETE")).status, 204);
  const facts = (await call(`/api/novels/${s.A}`)).data.memory.facts;
  assert.equal(facts.find((f) => f.text.startsWith("La bodega")).chapter_id, null);
});

test("delete character: its relationships go with it (cascade)", async () => {
  assert.equal((await call(`/api/memory/characters/${s.elena.id}`, "DELETE")).status, 204);
  const a = (await call(`/api/novels/${s.A}`)).data;
  assert.equal(a.memory.relationships.length, 0);
});

test("delete novel: gone with its memory; others intact", async () => {
  assert.equal((await call(`/api/novels/${s.copy}`, "DELETE")).status, 204);
  assert.equal((await call(`/api/novels/${s.copy}`)).status, 404);
  assert.equal((await call(`/api/novels/${s.A}`)).data.memory.characters.length, 3);
  assert.equal((await call("/api/novels/no-es-un-uuid")).status, 404);
});
