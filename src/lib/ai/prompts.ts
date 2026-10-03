import type { AnalysisAction, Character, Project } from "../types";

export const BASE_INSTRUCTIONS = `Eres el editor literario de un novelista. Trabajas sobre su manuscrito de ficción en español.

Principios:
- Es ficción para adultos. Los personajes pueden ser crueles, violentos, sexuales, mezquinos o contradictorios, y usar lenguaje desagradable. Eso es caracterización, no un error: no lo corrijas, no lo suavices, no moralices ni añadas advertencias. Juzgas si el texto funciona, no si los personajes son buenas personas.
- La voz es del autor. Respeta su estilo, su variedad del español (voseo, regionalismos), su puntuación (raya de diálogo), su tiempo verbal y su punto de vista. Cambia lo mínimo necesario.
- Evita la prosa genérica de IA: nada de metáforas decorativas, tríadas de adjetivos, frases solemnes de cierre, "un escalofrío recorrió…", ni explicar emociones que el texto ya muestra.
- Sé concreto y breve: cita el fragmento exacto que comentas. Sin elogios de cortesía, sin preámbulos ni resúmenes finales.
- Si algo ya funciona, dilo y no lo toques.
- Si el contexto que recibes no alcanza para juzgar (por ejemplo, falta información de capítulos anteriores), dilo en una línea en vez de suponer.
- Usa las fichas de personajes como referencia del autor sobre quién es cada uno.

Formato: Markdown sencillo, en español.`;

const FIELD_LABELS: [keyof Character, string][] = [
  ["aliases", "También llamado"],
  ["role", "Rol"],
  ["background", "Trasfondo"],
  ["traits", "Personalidad"],
  ["voice", "Voz"],
  ["motivations", "Motivaciones"],
  ["relationships", "Relaciones"],
  ["arc", "Arco narrativo"],
  ["notes", "Notas"],
];

export function formatCharacter(c: Character): string {
  const lines = FIELD_LABELS.filter(([key]) => c[key]?.trim()).map(([key, label]) => `${label}: ${c[key].trim()}`);
  return [`## ${c.name}`, ...lines].join("\n");
}

export function manuscriptBlock(manuscript: string): string {
  return `# Manuscrito completo\n<manuscrito>\n${manuscript}\n</manuscrito>`;
}

export function projectBlock(
  project: Pick<Project, "title" | "synopsis" | "style_notes">,
  characters: Character[],
  totalCharacters: number,
): string {
  const parts = [`# Proyecto: ${project.title}`];
  if (project.synopsis.trim()) parts.push(`## Sinopsis\n${project.synopsis.trim()}`);
  if (project.style_notes.trim()) parts.push(`## Notas de estilo del autor\n${project.style_notes.trim()}`);
  if (characters.length) {
    const others = totalCharacters - characters.length;
    parts.push(
      `# Fichas de personajes relevantes\n\n${characters.map(formatCharacter).join("\n\n")}` +
        (others > 0 ? `\n\n(El proyecto tiene ${others} personajes más que no aparecen en este fragmento.)` : ""),
    );
  }
  return parts.join("\n\n");
}

const REWRITE_RULES = `Si propones cambios, entrega al final la versión completa del fragmento dentro de <reescritura></reescritura>: solo el texto, conservando todo lo que no hace falta cambiar. Si el fragmento ya funciona, dilo y no incluyas <reescritura>.`;

const TASKS: Record<AnalysisAction, (c: Character | null) => string> = {
  redaccion:
    () => `Revisa la redacción de <seleccion>: claridad, ritmo, repeticiones, verbos débiles, adjetivación, puntuación, tiempos verbales y punto de vista.
Señala solo los problemas que de verdad importan (máximo 5), cada uno con la cita exacta, el problema y una propuesta breve.
${REWRITE_RULES}`,

  consistencia: (
    c,
  ) => `Verifica si ${c ? `**${c.name}**` : "el personaje"} es coherente en <seleccion> con su ficha y con lo que el manuscrito ya mostró (pasajes anteriores incluidos más abajo, si los hay). Considera voz, comportamiento, motivaciones, relaciones, arco y continuidad de datos.
Que haga algo cruel, inmoral o contradictorio no es una inconsistencia si encaja con quien es.

Responde exactamente con esta estructura:
**Veredicto:** Consistente | Posible inconsistencia
**Explicación:** una a tres frases.
Si hay inconsistencias, para cada una:
- > cita exacta del fragmento
  **Tensiona:** qué parte de la ficha o qué pasaje anterior contradice, y por qué.
**Sugerencia:** solo si aporta algo (por ejemplo, un ajuste mínimo, o actualizar la ficha si parece una evolución deliberada). Si no aporta, omítela.`,

  dialogo: (
    c,
  ) => `Mejora el diálogo de <seleccion>${c ? `, prestando especial atención a la voz de **${c.name}**` : ""}: que cada personaje suene como él mismo según su ficha, que haya subtexto en lugar de exposición, que sobren menos líneas y que las acotaciones sean precisas.
No suavices lo que dicen ni cómo lo dicen. Si no hay diálogo en la selección, dilo en una línea.
Explica brevemente los cambios principales.
${REWRITE_RULES}`,

  evolucion: (
    c,
  ) => `A partir de <seleccion> y de lo que sabes de ${c ? `**${c.name}**` : "el personaje"}, sugiere cómo podría evolucionar:
- Dónde está ahora en su arco y qué tensión interna se ve en este fragmento (dos o tres frases).
- Tres direcciones posibles (al menos una arriesgada), cada una con el detonante narrativo y qué cambiaría en su voz y comportamiento.
- Una o dos semillas concretas que se podrían plantar en este fragmento o cerca.
No lo hagas más simpático ni más redimible salvo que la historia lo pida.`,
};

export function taskPrompt(opts: {
  action: AnalysisAction;
  character: Character | null;
  selection: string;
  before: string;
  after: string;
  excerpts: string | null;
}): string {
  const { action, character, selection, before, after, excerpts } = opts;
  const parts: string[] = [];
  if (excerpts && character) {
    parts.push(`Pasajes anteriores donde aparece ${character.name}:\n<pasajes>\n${excerpts}\n</pasajes>`);
  }
  parts.push(
    [
      "Fragmento seleccionado con su contexto inmediato (trabaja solo sobre <seleccion>):",
      before ? `<antes>\n${before}\n</antes>` : null,
      `<seleccion>\n${selection}\n</seleccion>`,
      after ? `<despues>\n${after}\n</despues>` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  parts.push(`Tarea: ${TASKS[action](character)}`);
  return parts.join("\n\n");
}
