import type { Character, EditAction, Fact, Memory, Place, Relationship, SceneLength } from "../types";
import { SCENE_LENGTHS } from "../types";
import { chapterLabel, type SelectedMemory } from "./context";

// ---------------------------------------------------------------------------
// Shared principles: what "good writing" means here, for both modes.
// ---------------------------------------------------------------------------

const LITERARY_PRINCIPLES = `- Es ficción para adultos. Los personajes pueden ser crueles, violentos, sexuales, mezquinos o contradictorios, y usar lenguaje vulgar o desagradable. Eso es caracterización: no lo suavices, no moralices, no añadas advertencias ni hagas a nadie más simpático o redimible de lo que es.
- Sigue la Guía Maestra de la novela: sus decisiones (narrador, persona, tiempo verbal, tono, estilo, lenguaje, regionalismos) mandan sobre tus preferencias.
- Nada de prosa genérica de IA: no añadas metáforas, adjetivos, explicaciones emocionales ni dramatismo para que el texto "parezca literario". Nada de tríadas decorativas, frases solemnes de cierre, "un escalofrío recorrió…", ni nombrar emociones que la escena ya muestra.
- Respeta los silencios, la ambigüedad, las frases secas, la crudeza, los regionalismos y la puntuación del autor (raya de diálogo) cuando son parte de la obra.
- Respeta la memoria narrativa (fichas, relaciones, lugares, hechos): no cambies lo establecido. Un personaje no sabe lo que su ficha dice que desconoce.`;

/** Mode A — editing the author's own text: conservative. */
export const EDIT_INSTRUCTIONS = `Eres el editor literario de un novelista y trabajas sobre su manuscrito, en español. El texto es suyo: tu trabajo es conservador.

Al editar, preserva siempre los hechos, la intención, el significado, la voz del autor, su estilo y sus regionalismos. Cambia lo mínimo necesario. Si algo ya funciona, dilo y no lo toques.

${LITERARY_PRINCIPLES}
- Sé concreto y breve: cita el fragmento exacto que comentas. Sin elogios de cortesía, sin preámbulos ni resúmenes finales.
- Si el contexto que recibes no alcanza para juzgar, dilo en una línea en vez de suponer.

Formato: Markdown sencillo, en español.`;

/** Mode B — writing from the author's argument: literary freedom inside fixed events. */
export const WRITE_INSTRUCTIONS = `Eres el escritor que pone en prosa las escenas de una novela ajena, en español. El autor imagina la historia y te da el argumento de cada escena; tú lo conviertes en literatura con la voz de esta novela.

El argumento del autor es la autoridad sobre lo que ocurre:
- Ocurre todo lo que el argumento dice, tal como lo dice. Si dice que alguien se va, se va. Si dice que alguien no revela algo, no lo revela, ni directa ni indirectamente.
- No añadas acontecimientos que cambien la historia: muertes, revelaciones, confesiones, reconciliaciones, decisiones o giros que el argumento no indique. No resuelvas tensiones que el argumento deja abiertas.
- Termina donde termina el argumento. No adelantes lo que vendrá ni cierres con una reflexión o moraleja.

Eres libre en todo lo demás: descripción, diálogos, acciones menores, gestos, ritmo, atmósfera, transiciones, detalles concretos coherentes con la memoria.

${LITERARY_PRINCIPLES}
- La escena debe continuar con naturalidad el texto anterior (mismo narrador, persona y tiempo verbal) y, si hay texto después, enlazar con él.
- Muestra antes que explicar. Un buen detalle concreto vale más que tres adjetivos.

Formato de respuesta: la escena completa dentro de <escena></escena>, solo prosa, sin títulos ni comentarios. Si el argumento contradice algo de la memoria narrativa (por ejemplo, un personaje que ya murió), escribe igualmente lo que pide el argumento y añade después de la escena una sola línea dentro de <aviso></aviso> señalando la contradicción. No añadas nada más.`;

// ---------------------------------------------------------------------------
// Memory formatting
// ---------------------------------------------------------------------------

const CHARACTER_LABELS: [keyof Character, string][] = [
  ["aliases", "También llamado"],
  ["age", "Edad"],
  ["role", "Rol"],
  ["description", "Descripción"],
  ["background", "Trasfondo"],
  ["personality", "Personalidad"],
  ["motivations", "Motivaciones"],
  ["fears", "Miedos"],
  ["contradictions", "Contradicciones"],
  ["values", "Valores"],
  ["voice", "Forma de hablar"],
  ["vocabulary", "Vocabulario y expresiones"],
  ["secrets", "Secretos"],
  ["knows", "Sabe"],
  ["unaware", "No sabe"],
  ["arc", "Arco narrativo"],
  ["notes", "Notas"],
];

export function formatCharacter(c: Character): string {
  const lines = CHARACTER_LABELS.filter(([key]) => c[key]?.trim()).map(([key, label]) => `${label}: ${c[key].trim()}`);
  return [`### ${c.name}`, ...lines].join("\n");
}

function formatRelationship(r: Relationship, names: Map<string, string>): string {
  return `- ${names.get(r.from_id) ?? "?"} → ${r.kind} → ${names.get(r.to_id) ?? "?"}${r.note.trim() ? ` (${r.note.trim()})` : ""}`;
}

function formatPlace(p: Place): string {
  const lines = [`### ${p.name}${p.aliases.trim() ? ` (también: ${p.aliases.trim()})` : ""}`];
  if (p.description.trim()) lines.push(p.description.trim());
  if (p.notes.trim()) lines.push(`Notas: ${p.notes.trim()}`);
  return lines.join("\n");
}

function formatFact(
  f: Fact,
  ctx: {
    names: Map<string, string>;
    places: Map<string, string>;
    chapters: { id: string; title: string }[];
    currentIndex: number;
  },
): string {
  const meta: string[] = [];
  const idx = f.chapter_id ? ctx.chapters.findIndex((c) => c.id === f.chapter_id) : -1;
  if (idx >= 0)
    meta.push(
      chapterLabel(idx, ctx.chapters[idx].title) +
        (ctx.currentIndex >= 0 && idx > ctx.currentIndex ? ", posterior al capítulo actual" : ""),
    );
  if (f.story_time.trim()) meta.push(f.story_time.trim());
  if (f.place_id && ctx.places.has(f.place_id)) meta.push(ctx.places.get(f.place_id)!);
  const who = f.character_ids.map((id) => ctx.names.get(id)).filter(Boolean);
  if (who.length) meta.push(who.join(", "));
  return `- ${f.text.trim()}${meta.length ? ` [${meta.join(" · ")}]` : ""}${f.note.trim() ? ` — ${f.note.trim()}` : ""}`;
}

/** The narrative memory relevant to this request, as one readable block. */
export function memoryBlock(
  selected: SelectedMemory,
  all: Memory,
  chapters: { id: string; title: string }[],
  currentChapterId: string | null,
): string {
  const names = new Map(all.characters.map((c) => [c.id, c.name]));
  const places = new Map(all.places.map((p) => [p.id, p.name]));
  const currentIndex = chapters.findIndex((c) => c.id === currentChapterId);
  const parts: string[] = [];

  if (selected.characters.length) {
    const others = all.characters.length - selected.characters.length;
    parts.push(
      `## Personajes\n\n${selected.characters.map(formatCharacter).join("\n\n")}` +
        (others > 0 ? `\n\n(La novela tiene ${others} personajes más que no intervienen aquí.)` : ""),
    );
  }
  if (selected.relationships.length) {
    parts.push(`## Relaciones\n${selected.relationships.map((r) => formatRelationship(r, names)).join("\n")}`);
  }
  if (selected.places.length) parts.push(`## Lugares\n\n${selected.places.map(formatPlace).join("\n\n")}`);
  if (selected.facts.length) {
    parts.push(
      `## Hechos de continuidad\n${selected.facts.map((f) => formatFact(f, { names, places, chapters, currentIndex })).join("\n")}` +
        (selected.facts.some(
          (f) => f.chapter_id && chapters.findIndex((c) => c.id === f.chapter_id) > currentIndex && currentIndex >= 0,
        )
          ? "\n(Los hechos marcados como posteriores al capítulo actual todavía no han ocurrido en este punto del relato: úsalos sólo para no contradecirlos.)"
          : ""),
    );
  }
  return parts.length ? `# Memoria narrativa\n\n${parts.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Mode A tasks
// ---------------------------------------------------------------------------

const REWRITE_RULES = `Si propones cambios, entrega al final la versión completa del fragmento dentro de <reescritura></reescritura>: solo el texto, conservando todo lo que no hace falta cambiar. Si el fragmento ya funciona, dilo y no incluyas <reescritura>.`;

const EDIT_TASKS: Record<EditAction, (c: Character | null) => string> = {
  redaccion:
    () => `Revisa la redacción de <seleccion>: claridad, ritmo, repeticiones, verbos débiles, adjetivación, puntuación, tiempos verbales y punto de vista, según la Guía Maestra.
Señala solo los problemas que de verdad importan (máximo 5), cada uno con la cita exacta, el problema y una propuesta breve.
${REWRITE_RULES}`,

  dialogo: (
    c,
  ) => `Mejora el diálogo de <seleccion>${c ? `, prestando especial atención a la voz de **${c.name}**` : ""}: que cada personaje suene como él mismo según su ficha, que haya subtexto en lugar de exposición, que sobren menos líneas y que las acotaciones sean precisas.
No suavices lo que dicen ni cómo lo dicen. Si no hay diálogo en la selección, dilo en una línea.
Explica brevemente los cambios principales.
${REWRITE_RULES}`,

  expandir:
    () => `Expande <seleccion>: desarrolla lo que ya está (gesto, percepción, ritmo, un detalle concreto, una línea de diálogo coherente) hasta aproximadamente el doble de extensión.
No añadas acontecimientos, revelaciones ni decisiones nuevas, y no cambies lo que ocurre ni su orden. Mantén la voz y la sequedad o densidad del original.
Explica en una o dos líneas qué desarrollaste.
${REWRITE_RULES}`,

  acortar:
    () => `Acorta <seleccion> a aproximadamente un 60 % de su extensión: elimina redundancias, explicaciones innecesarias y lo que el lector ya sabe.
Conserva todos los hechos, la intención y la voz; no cambies lo que ocurre.
Explica en una o dos líneas qué quitaste.
${REWRITE_RULES}`,

  consistencia:
    () => `Verifica la continuidad de <seleccion> contra la memoria narrativa (personajes, relaciones, lugares, hechos) y los pasajes anteriores incluidos: datos, fechas, lugares, quién sabe qué, relaciones, comportamientos.
Que alguien haga algo cruel, inmoral o contradictorio no es una inconsistencia si encaja con quien es.

Responde exactamente con esta estructura:
**Veredicto:** Consistente | Posible inconsistencia
**Explicación:** una a tres frases.
Si hay inconsistencias, para cada una:
- > cita exacta del fragmento
  **Contradice:** qué ficha, hecho, lugar o pasaje anterior, y por qué.
**Sugerencia:** solo si aporta algo (un ajuste mínimo, o actualizar la memoria si parece un cambio deliberado). Si no aporta, omítela.`,

  personaje: (
    c,
  ) => `Verifica si ${c ? `**${c.name}**` : "el personaje"} es coherente en <seleccion> con su ficha, sus relaciones, los hechos que le conciernen y lo que el manuscrito ya mostró. Considera voz y vocabulario, comportamiento, motivaciones, miedos, contradicciones, lo que sabe y lo que no sabe, arco y continuidad.
Que haga algo cruel, inmoral o contradictorio no es una inconsistencia si encaja con quien es.

Responde exactamente con esta estructura:
**Veredicto:** Consistente | Posible inconsistencia
**Explicación:** una a tres frases.
Si hay inconsistencias, para cada una:
- > cita exacta del fragmento
  **Tensiona:** qué parte de la ficha, relación, hecho o pasaje anterior contradice, y por qué.
**Sugerencia:** solo si aporta algo. Si no aporta, omítela.`,

  evolucion: (
    c,
  ) => `A partir de <seleccion> y de lo que sabes de ${c ? `**${c.name}**` : "el personaje"}, sugiere cómo podría evolucionar:
- Dónde está ahora en su arco y qué tensión interna se ve en este fragmento (dos o tres frases).
- Tres direcciones posibles (al menos una arriesgada), cada una con el detonante narrativo y qué cambiaría en su voz y comportamiento.
- Una o dos semillas concretas que se podrían plantar en este fragmento o cerca.
No lo hagas más simpático ni más redimible salvo que la historia lo pida. Son sugerencias para el autor, no decisiones.`,
};

export function editPrompt(opts: {
  action: EditAction;
  character: Character | null;
  selection: string;
  before: string;
  after: string;
  passages: string | null;
}): string {
  const parts: string[] = [];
  if (opts.passages) parts.push(`Pasajes anteriores relevantes:\n<pasajes>\n${opts.passages}\n</pasajes>`);
  parts.push(
    [
      "Fragmento seleccionado con su contexto inmediato (trabaja solo sobre <seleccion>):",
      opts.before ? `<antes>\n${opts.before}\n</antes>` : null,
      `<seleccion>\n${opts.selection}\n</seleccion>`,
      opts.after ? `<despues>\n${opts.after}\n</despues>` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  parts.push(`Tarea: ${EDIT_TASKS[opts.action](opts.character)}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Mode B task
// ---------------------------------------------------------------------------

export function scenePrompt(opts: {
  argument: string;
  length: SceneLength;
  chapter: string;
  previousChapterTail: string | null;
  before: string;
  after: string;
}): string {
  const parts: string[] = [];
  if (opts.previousChapterTail)
    parts.push(`Final del capítulo anterior:\n<capitulo_anterior>\n${opts.previousChapterTail}\n</capitulo_anterior>`);
  parts.push(`Estás escribiendo en: ${opts.chapter}.`);
  parts.push(
    opts.before.trim()
      ? `Texto inmediatamente anterior (la escena empieza justo después):\n<antes>\n${opts.before}\n</antes>`
      : "La escena va al principio del capítulo.",
  );
  if (opts.after.trim())
    parts.push(`Texto que viene después (la escena debe poder enlazar con él):\n<despues>\n${opts.after}\n</despues>`);

  const words = SCENE_LENGTHS.find((l) => l.id === opts.length)?.words;
  parts.push(`Argumento del autor (esto es lo que ocurre, y sólo esto):\n<argumento>\n${opts.argument.trim()}\n</argumento>`);
  parts.push(
    `Escribe la escena.${words ? ` Extensión aproximada: ${words} palabras.` : " La extensión que la escena necesite."}`,
  );
  return parts.join("\n\n");
}
