import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deadCharacterWarnings,
  describeState,
  stateBefore,
  type CharacterState,
} from "@/lib/narrative-state";

const st = (over: Partial<CharacterState>): CharacterState => ({
  id: "s",
  character_id: "pola",
  chapter_order: 0,
  alive: true,
  location: "",
  knows: "",
  physical: "",
  objects: "",
  status: "approved",
  ...over,
});

const pola = { id: "pola", name: "Pola", aliases: "" };
const eduardo = { id: "eduardo", name: "Eduardo", aliases: "don Eduardo" };

test("stateBefore: el estado aprobado más reciente anterior al capítulo", () => {
  const states = [
    st({ id: "a", chapter_order: 0, location: "Temuco" }),
    st({ id: "b", chapter_order: 2, location: "Santiago" }),
    st({ id: "c", chapter_order: 1, location: "Villarrica" }),
  ];
  assert.equal(stateBefore(states, "pola", 3)?.location, "Santiago");
  assert.equal(stateBefore(states, "pola", 2)?.location, "Villarrica");
  assert.equal(stateBefore(states, "pola", 0), null);
});

test("stateBefore: nunca usa estados sugeridos ni del propio capítulo", () => {
  const states = [
    st({ id: "a", chapter_order: 0, location: "Temuco" }),
    st({ id: "b", chapter_order: 1, location: "Sugerido", status: "suggested" }),
    st({ id: "c", chapter_order: 2, location: "Del capítulo actual" }),
  ];
  assert.equal(stateBefore(states, "pola", 2)?.location, "Temuco");
});

test("stateBefore: separa personajes", () => {
  const states = [st({ character_id: "eduardo", location: "Almacén" })];
  assert.equal(stateBefore(states, "pola", 5), null);
});

test("describeState: solo lo que tiene contenido", () => {
  const s = st({ chapter_order: 2, location: "Santiago", objects: "una mochila" });
  assert.equal(describeState(s, "Pola"), "Pola (fin del capítulo 3): está en Santiago; lleva: una mochila.");
  assert.equal(describeState(st({}), "Pola"), "");
});

test("describeState: un personaje muerto se dice explícitamente", () => {
  const s = st({ alive: false, chapter_order: 4 });
  assert.match(describeState(s, "Eduardo"), /MUERTO\/A al terminar el capítulo 5/);
});

test("advertencia: personaje muerto que aparece en la propuesta", () => {
  const states = [st({ character_id: "eduardo", alive: false, chapter_order: 1 })];
  const w = deadCharacterWarnings({
    proposal: "Don Eduardo cruzó la plaza y saludó a Pola.",
    characters: [pola, eduardo],
    states,
    chapterOrder: 2,
  });
  assert.equal(w.length, 1);
  assert.match(w[0], /Eduardo murió al terminar el capítulo 2/);
});

test("sin advertencia si la mención es un recuerdo", () => {
  const states = [st({ character_id: "eduardo", alive: false, chapter_order: 1 })];
  const w = deadCharacterWarnings({
    proposal: "Pola recordó a don Eduardo, con su diario doblado en cuatro.",
    characters: [pola, eduardo],
    states,
    chapterOrder: 2,
  });
  assert.deepEqual(w, []);
});

test("sin advertencia antes de la muerte ni en capítulos anteriores a ella", () => {
  const states = [st({ character_id: "eduardo", alive: false, chapter_order: 3 })];
  const w = deadCharacterWarnings({
    proposal: "Don Eduardo llegó temprano.",
    characters: [eduardo],
    states,
    chapterOrder: 3,
  });
  assert.deepEqual(w, []);
});

// Integración con la revisión de continuidad de cada propuesta (lib/continuity.ts).
test("checkContinuity: sin estado narrativo no añade nada", async () => {
  const { checkContinuity } = await import("@/lib/continuity");
  const w = checkContinuity({
    proposal: "Don Eduardo cruzó la plaza.",
    before: "",
    characters: [eduardo],
    places: [],
  });
  assert.equal(w.filter((x) => x.kind === "estado").length, 0);
});

test("checkContinuity: un personaje muerto que aparece da una advertencia de estado", async () => {
  const { checkContinuity } = await import("@/lib/continuity");
  const w = checkContinuity({
    proposal: "Don Eduardo cruzó la plaza.",
    before: "",
    characters: [eduardo],
    places: [],
    narrative: {
      characters: [{ id: "eduardo", name: "Eduardo", aliases: "don Eduardo" }],
      states: [st({ character_id: "eduardo", alive: false, chapter_order: 1 })],
      chapterOrder: 2,
    },
  });
  const estado = w.filter((x) => x.kind === "estado");
  assert.equal(estado.length, 1);
  assert.match(estado[0].message, /Eduardo murió al terminar el capítulo 2/);
});

test("toCharacterStates: calcula la posición desde el orden de capítulos y descarta los de capítulos borrados", async () => {
  const { toCharacterStates } = await import("@/lib/narrative-state");
  const row = (over: Record<string, unknown>) => ({
    id: "r",
    character_id: "pola",
    chapter_id: "c2",
    alive: true,
    location: "",
    knows: "",
    physical: "",
    objects: "",
    status: "approved" as const,
    ...over,
  });
  const states = toCharacterStates(
    [row({ id: "a", chapter_id: "c2", location: "Santiago" }), row({ id: "b", chapter_id: "fantasma" })],
    ["c1", "c2", "c3"],
  );
  assert.equal(states.length, 1);
  assert.equal(states[0].chapter_order, 1);
  assert.equal(states[0].location, "Santiago");
});

test("toCharacterStates: sin filas o sin capítulos devuelve lista vacía", async () => {
  const { toCharacterStates } = await import("@/lib/narrative-state");
  assert.deepEqual(toCharacterStates([], ["c1"]), []);
  assert.deepEqual(
    toCharacterStates([{ id: "a", character_id: "p", chapter_id: "c1", alive: true, location: "", knows: "", physical: "", objects: "", status: "approved" }], []),
    [],
  );
});
