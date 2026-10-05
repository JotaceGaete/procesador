import type { Character, EditAction, Fact, Memory, Place, Relationship, SceneLength } from "../types";
import { SCENE_LENGTHS, type ProviderId } from "../types";
import { countWords } from "../manuscript";
import { chapterLabel, type SelectedMemory } from "./context";

// ---------------------------------------------------------------------------
// Shared principles: what "good writing" means here, for both modes.
// ---------------------------------------------------------------------------

const LITERARY_PRINCIPLES = `- Es ficción para adultos. Los personajes pueden ser crueles, violentos, sexuales, mezquinos o contradictorios, y usar lenguaje vulgar o desagradable. Eso es caracterización: no lo suavices, no moralices, no añadas advertencias ni hagas a nadie más simpático o redimible de lo que es.
- Sigue la Guía Maestra de la novela: sus decisiones (narrador, persona, tiempo verbal, tono, estilo, lenguaje, regionalismos) mandan sobre tus preferencias.
- Nada de prosa genérica de IA: no añadas metáforas, adjetivos, explicaciones emocionales ni dramatismo para que el texto "parezca literario". Nada de tríadas decorativas, frases solemnes de cierre, "un escalofrío recorrió…", ni nombrar emociones que la escena ya muestra.
- Respeta los silencios, la ambigüedad, las frases secas, la crudeza, los regionalismos y la puntuación del autor (raya de diálogo) cuando son parte de la obra.
- Respeta la memoria narrativa (fichas, relaciones, lugares, hechos): no cambies lo establecido. Un personaje no sabe lo que su ficha dice que desconoce.`;

/** The manuscript's format (docs/formato-texto.md), as the model reads and must write it. */
const TEXT_FORMAT = `Formato del manuscrito:
- Las cursivas se marcan con un asterisco a cada lado, dentro de un mismo párrafo: *así*. Conserva exactamente las cursivas del texto que reescribas; en prosa nueva, úsalas sólo donde la novela las usaría (títulos de obras, palabras extranjeras, énfasis o pensamientos, si el texto ya lo hace así).
- Un salto de escena es una línea que contiene sólo * * *. Consérvalo donde esté; no añadas otros salvo que el argumento indique un corte de escena o de tiempo.
- No uses negritas, títulos, listas ni ningún otro formato en la prosa.`;

/** Mode A — editing the author's own text: conservative. */
export const EDIT_INSTRUCTIONS = `Eres el editor literario de un novelista y trabajas sobre su manuscrito, en español. El texto es suyo: tu trabajo es conservador.

Al editar, preserva siempre los hechos, la intención, el significado, la voz del autor, su estilo y sus regionalismos. Cambia lo mínimo necesario. Si algo ya funciona, dilo y no lo toques.

${LITERARY_PRINCIPLES}
- Sé concreto y breve: cita el fragmento exacto que comentas. Sin elogios de cortesía, sin preámbulos ni resúmenes finales.
- Si el contexto que recibes no alcanza para juzgar, dilo en una línea en vez de suponer.

${TEXT_FORMAT}

Formato de tus comentarios: Markdown sencillo, en español.`;

/** Mode B — writing from the author's argument: literary freedom inside fixed events. */
export const WRITE_INSTRUCTIONS = `Eres el escritor que pone en prosa las escenas de una novela ajena, en español. El autor imagina la historia y te da el argumento de cada escena; tú lo conviertes en literatura con la voz de esta novela.

Desarrollar una escena es dramatizarla, no resumirla:
- El argumento dice qué ocurre y hasta dónde; tu trabajo es que el lector lo viva. Convierte cada paso del argumento en momentos contados en tiempo de escena: acciones y reacciones, el ambiente concreto, gestos y lenguaje corporal, y la percepción o el pensamiento del personaje cuando el punto de vista lo permite.
- Si en el argumento los personajes conversan, discuten o se dicen algo, esa conversación ocurre en escena, con sus palabras, sus pausas y lo que callan; no la resuelvas con «hablaron de…» o «le explicó que…». Si nadie interactúa, no fuerces el diálogo.
- No cuentes el argumento desde lejos ni lo despaches en unas líneas: entre un hecho y el siguiente están las reacciones, los gestos y las pequeñas decisiones que hacen creíble la escena.

El argumento es el plan de la escena y la autoridad sobre lo que ocurre. Fidelidad al argumento es fidelidad a sus acontecimientos, a su intención y a sus límites; no a su redacción:
- Ocurre todo lo que el argumento dice. Si dice que alguien se va, se va. Si dice que alguien no revela algo, no lo revela, ni directa ni indirectamente.
- La narración del argumento es un plan, no un borrador: no la copies ni la corrijas por encima. Escribe la escena de nuevo con la voz del manuscrito y de la Guía Maestra, no con la forma telegráfica o resumida con que el autor anotó el argumento.
- Las réplicas de diálogo que el autor escribe explícitamente en el argumento (con raya o entre comillas) son decisiones suyas: consérvalas tal cual, sin embellecerlas ni cambiar lo que dicen. Intégralas con acciones, pausas, silencios y reacciones.
- Cuando el argumento nombra un estado interior («quería seguir», «estaba nerviosa»), no lo repitas sin más: si es literariamente apropiado, hazlo visible en lo que el personaje hace, mira o dice, o en cómo reaccionan los demás.
- No añadas acontecimientos que cambien la historia: muertes, revelaciones, confesiones, reconciliaciones, decisiones o giros que el argumento no indique. No resuelvas tensiones que el argumento deja abiertas.
- Termina donde termina el argumento. No adelantes lo que vendrá ni cierres con una reflexión o moraleja.

Eres libre en todo lo demás: descripción, diálogos, acciones menores, gestos, ritmo, atmósfera, transiciones, detalles concretos coherentes con la memoria.

Contención no es brevedad: las reglas de estilo de abajo (nada de relleno, de adjetivación decorativa, de metáforas gratuitas, de explicaciones emocionales redundantes ni de acontecimientos inventados) piden precisión, no comprimir la escena. La extensión sale de desarrollar los momentos que el argumento ya contiene.

${LITERARY_PRINCIPLES}
- La escena debe continuar con naturalidad el texto anterior (mismo narrador, persona y tiempo verbal) y, si hay texto después, enlazar con él.
- Si recibes la historia hasta aquí (fichas de lectura de los capítulos anteriores), lo que saben los personajes o los cabos abiertos, úsalos para la continuidad: nadie sabe lo que todavía no se le ha revelado, y los cabos abiertos siguen abiertos salvo que el argumento diga otra cosa. Son resúmenes derivados del texto: si contradicen la memoria narrativa o el manuscrito, mandan éstos. Una ficha marcada como versión anterior describe un texto que el autor cambió después.
- Muestra antes que explicar. Un buen detalle concreto vale más que tres adjetivos.

${TEXT_FORMAT}

Formato de respuesta: la escena completa dentro de <escena></escena>, solo prosa, sin títulos ni comentarios. Si el argumento contradice algo de la memoria narrativa (por ejemplo, un personaje que ya murió), escribe igualmente lo que pide el argumento y añade después de la escena una sola línea dentro de <aviso></aviso> señalando la contradicción. No añadas nada más.`;

// ---------------------------------------------------------------------------
// Memory formatting
// ---------------------------------------------------------------------------

export const CHARACTER_LABELS: [keyof Character, string][] = [
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

export interface MemorySections {
  characters: string;
  relationships: string;
  places: string;
  facts: string;
}

/** Each kind of memory as its own block ("" when nothing of it goes), so its size can be told apart. */
export function memorySections(
  selected: SelectedMemory,
  all: Memory,
  chapters: { id: string; title: string }[],
  currentChapterId: string | null,
): MemorySections {
  const names = new Map(all.characters.map((c) => [c.id, c.name]));
  const places = new Map(all.places.map((p) => [p.id, p.name]));
  const currentIndex = chapters.findIndex((c) => c.id === currentChapterId);
  const others = all.characters.length - selected.characters.length;
  return {
    characters: selected.characters.length
      ? `## Personajes\n\n${selected.characters.map(formatCharacter).join("\n\n")}` +
        (others > 0 ? `\n\n(La novela tiene ${others} personajes más que no intervienen aquí.)` : "")
      : "",
    relationships: selected.relationships.length
      ? `## Relaciones\n${selected.relationships.map((r) => formatRelationship(r, names)).join("\n")}`
      : "",
    places: selected.places.length ? `## Lugares\n\n${selected.places.map(formatPlace).join("\n\n")}` : "",
    facts: selected.facts.length
      ? `## Hechos de continuidad\n${selected.facts.map((f) => formatFact(f, { names, places, chapters, currentIndex })).join("\n")}` +
        (selected.facts.some(
          (f) => f.chapter_id && chapters.findIndex((c) => c.id === f.chapter_id) > currentIndex && currentIndex >= 0,
        )
          ? "\n(Los hechos marcados como posteriores al capítulo actual todavía no han ocurrido en este punto del relato: úsalos sólo para no contradecirlos.)"
          : "")
      : "",
  };
}

/** The narrative memory relevant to this request, as one readable block. */
export function memoryBlock(
  selected: SelectedMemory,
  all: Memory,
  chapters: { id: string; title: string }[],
  currentChapterId: string | null,
): string {
  const m = memorySections(selected, all, chapters, currentChapterId);
  const parts = [m.characters, m.relationships, m.places, m.facts].filter(Boolean);
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
  /** How many [IMAGEN n] placeholders the selection carries. */
  images?: number;
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
  if (opts.images) {
    parts.push(
      `La selección contiene ${opts.images === 1 ? "una imagen del libro, marcada como [IMAGEN 1]" : `${opts.images} imágenes del libro, marcadas como [IMAGEN 1] a [IMAGEN ${opts.images}]`}. Si reescribes, conserva cada marcador exactamente igual, solo en su propio párrafo y en el lugar que le corresponda; no los modifiques, no los elimines y no inventes otros.`,
    );
  }
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
  /** The current chapter from its start up to `before` (and how many words of it were left out). */
  earlier?: string | null;
  earlierOmitted?: number;
  /** With the whole novel: the mark that says, inside it, where the scene goes. */
  mark?: string | null;
  /** "La historia hasta aquí" (lib/ai/story.ts): previous chapters, knowledge, open threads. */
  story?: string | null;
  knowledge?: string | null;
  threads?: string | null;
  /** A short reminder for one provider (SCENE_PROVIDER_NOTES), on top of the common instructions. */
  providerNote?: string | null;
  /** "Ampliar": the scene already written for this argument, to develop (not to rewrite). */
  draft?: string | null;
}): string {
  const extent = sceneExtent(opts.length);
  const parts: string[] = [];
  if (opts.story)
    parts.push(`La historia hasta aquí, según las fichas de lectura de los capítulos anteriores:\n<historia_hasta_aqui>\n${opts.story}\n</historia_hasta_aqui>`);
  if (opts.knowledge)
    parts.push(`Lo que ya saben los personajes de la escena, por lo ocurrido hasta aquí:\n<lo_que_saben>\n${opts.knowledge}\n</lo_que_saben>`);
  if (opts.threads)
    parts.push(
      `Cabos abiertos en este punto de la novela (no los resuelvas ni abras otros si el argumento no lo indica):\n<hilos_abiertos>\n${opts.threads}\n</hilos_abiertos>`,
    );
  if (opts.previousChapterTail)
    parts.push(`Final del capítulo anterior:\n<capitulo_anterior>\n${opts.previousChapterTail}\n</capitulo_anterior>`);
  parts.push(`Estás escribiendo en: ${opts.chapter}.`);
  if (opts.mark) {
    parts.push(
      `La escena va exactamente donde la historia hasta aquí termina con ${opts.mark}: continúa con naturalidad el texto que hay antes de esa marca. Es todo lo que ha ocurrido hasta este punto; lo que viene después no lo conoces y no debes anticiparlo. No repitas ese texto ni incluyas la marca.`,
    );
  } else {
    if (opts.earlier?.trim())
      parts.push(
        `El capítulo actual desde su comienzo${opts.earlierOmitted ? ` (se omite una parte intermedia de ≈${opts.earlierOmitted} palabras)` : ""}:\n<capitulo_hasta_aqui>\n${opts.earlier}${opts.earlierOmitted ? "\n[…]" : ""}\n</capitulo_hasta_aqui>`,
      );
    parts.push(
      opts.before.trim()
        ? `Texto inmediatamente anterior (la escena empieza justo después):\n<antes>\n${opts.before}\n</antes>`
        : "La escena va al principio del capítulo.",
    );
    if (opts.after.trim())
      parts.push(`Texto que viene después (la escena debe poder enlazar con él):\n<despues>\n${opts.after}\n</despues>`);
  }

  parts.push(`Argumento del autor: los hechos de la escena (su plan, no su texto):\n<argumento>\n${opts.argument.trim()}\n</argumento>`);
  parts.push(`Extensión: ${extent.target}.`);
  if (opts.draft) {
    const written = countWords(opts.draft);
    parts.push(
      `Esta es la escena que ya escribiste para este argumento (≈${written} palabras):\n<borrador>\n${opts.draft.trim()}\n</borrador>`,
    );
    parts.push(
      `Desarróllala hasta ${extent.short}. Conserva todo lo que ocurre, en el mismo orden, la continuidad, la voz y el texto que ya funciona; dramatiza los momentos que quedaron comprimidos o contados desde lejos (acciones, reacciones, ambiente, gestos, diálogo donde los personajes interactúan). No añadas acontecimientos nuevos para ganar extensión ni rellenes. Entrega la escena completa, ampliada, dentro de <escena></escena>.`,
    );
  } else {
    if (opts.providerNote) parts.push(opts.providerNote.replace("{extension}", extent.short));
    parts.push(`Escribe la escena completa, desarrollada: ${extent.closing}`);
  }
  return parts.join("\n\n");
}

/**
 * One provider's adaptation, on top of the common base (never instead of it). Grok tended to
 * transcribe the argument in short sentences that tell what happens: its block teaches, by
 * contrast, what staging a scene means, and a one-line reminder closes the task.
 */
/** Appended to WRITE_INSTRUCTIONS (system) for that provider. */
export const SCENE_PROVIDER_CRAFT: Partial<Record<ProviderId, string>> = {
  xai: `Escenificar, no resumir:
Tiendes a reescribir el argumento en frases breves que cuentan lo que pasa. Aquí eso no sirve: cada frase del argumento debe convertirse en un momento visible, sin añadir acontecimientos. Para cada acontecimiento: qué hace el cuerpo (una microacción), qué se ve u oye en ese instante, cómo reacciona el otro, y la pausa o la réplica si la hay. Sin acumular adjetivos ni metáforas, y sin introspección inventada.

Ejemplo de la diferencia (enseña el procedimiento, no un estilo: no lo imites ni lo reutilices):
Argumento: «Marta estaba nerviosa. Le pidió a Juan que se fuera.»
Resumen (no): «Marta estaba nerviosa y le pidió a Juan que se fuera.»
Escena (sí): «Marta dobló la servilleta en dos, después en cuatro. Juan seguía con el abrigo puesto, sin sentarse. —Mejor vete —dijo ella, sin levantar la vista.»`,
};

/** The common writing instructions, plus the provider's own block if it has one. */
export function writeInstructions(provider: ProviderId | null | undefined): string {
  const craft = provider ? SCENE_PROVIDER_CRAFT[provider] : undefined;
  return craft ? `${WRITE_INSTRUCTIONS}\n\n${craft}` : WRITE_INSTRUCTIONS;
}

/** A one-line reminder at the end of the task for that provider; "{extension}" is the length asked. */
export const SCENE_PROVIDER_NOTES: Partial<Record<ProviderId, string>> = {
  xai: "Recuerda: no copies las frases del argumento; escenifícalas momento a momento, hasta {extension}.",
};

/** How the asked length is said to the model: a range to aim at, never a quota. */
export function sceneExtent(length: SceneLength): { target: string; short: string; closing: string } {
  const l = SCENE_LENGTHS.find((x) => x.id === length);
  if (!l?.range)
    return {
      target: "la extensión natural que la escena necesite, sin resumir",
      short: "la extensión natural que la escena necesite",
      closing: "la extensión natural que necesite, sin resumir ni rellenar.",
    };
  // "1.000", not "1000" (toLocaleString("es") doesn't group four digits).
  const [min, max] = l.range.map((n) => String(n).replace(/\B(?=(\d{3})+$)/g, "."));
  return {
    target: `alrededor de ${min}–${max} palabras (${l.label.toLowerCase()})`,
    short: `alrededor de ${min}–${max} palabras`,
    closing: `alrededor de ${min}–${max} palabras. Es una orientación, no una cuota: no rellenes para llegar; si la escena queda plenamente desarrollada algo por debajo, está bien.`,
  };
}
