import type { AnalysisAction, Character, Project } from "../types";

export const BASE_INSTRUCTIONS = `Eres el editor literario y asistente de escritura de un novelista. Trabajas sobre su manuscrito de ficción, en español.

Cómo trabajas:
- Esto es ficción para adultos. Los personajes pueden ser crueles, violentos, sexuales, inmorales o desagradables, y la narración puede tratar cualquier tema oscuro. Tu trabajo es que el texto funcione literariamente, no suavizarlo: no moralices, no añadas advertencias, no edulcores a los personajes ni cambies el tono para hacerlo más amable. Si una escena es brutal y debe serlo, ayúdala a ser mejor siendo brutal.
- Respeta la voz del autor y su estilo. Propón, no impongas; explica brevemente el porqué de cada cambio relevante.
- Sé concreto: cita fragmentos exactos del texto cuando señales algo. Nada de elogios genéricos ni relleno.
- Usa la ficha de cada personaje (voz, trasfondo, características, arco) como canon. Si el texto contradice la ficha, dilo; si la ficha parece desactualizada respecto del texto, dilo también.
- Responde en español, en Markdown sencillo (títulos cortos, listas). Sin preámbulos.`;

export function formatCharacter(c: Character): string {
  const field = (label: string, value: string) => (value.trim() ? `${label}: ${value.trim()}` : null);
  return [
    `## ${c.name}`,
    field("Rol", c.role),
    field("Trasfondo", c.background),
    field("Voz", c.voice),
    field("Características", c.traits),
    field("Arco narrativo", c.arc),
    field("Notas", c.notes),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Contexto del proyecto: va al system prompt, después de las instrucciones fijas. */
export function projectContext(
  project: Pick<Project, "title" | "synopsis" | "style_notes">,
  characters: Character[],
  manuscript: string | null,
): string {
  const parts = [`# Proyecto: ${project.title}`];
  if (project.synopsis.trim()) parts.push(`## Sinopsis\n${project.synopsis.trim()}`);
  if (project.style_notes.trim()) parts.push(`## Notas de estilo del autor\n${project.style_notes.trim()}`);
  parts.push(
    characters.length
      ? `# Fichas de personajes\n\n${characters.map(formatCharacter).join("\n\n")}`
      : "# Fichas de personajes\n(Aún no hay personajes definidos.)",
  );
  if (manuscript !== null) {
    parts.push(`# Manuscrito completo\n<manuscrito>\n${manuscript}\n</manuscrito>`);
  }
  return parts.join("\n\n");
}

const REWRITE_FORMAT = `Al final, entrega la versión reescrita completa del fragmento dentro de <reescritura></reescritura>, solo el texto, sin comentarios dentro de las etiquetas.`;

const TASKS: Record<AnalysisAction, (character: Character | null) => string> = {
  redaccion:
    () => `Revisa la redacción del fragmento seleccionado: ritmo, claridad, repeticiones, muletillas, verbos débiles, adjetivación, puntuación, coherencia de tiempos verbales y punto de vista, y "mostrar vs. contar". Señala los problemas más importantes (no más de 8) con la cita exacta y una propuesta.
${REWRITE_FORMAT}`,

  consistencia: (
    c,
  ) => `Verifica si ${c ? `**${c.name}**` : "el personaje"} es consistente en el fragmento seleccionado respecto de su ficha y de lo que el manuscrito ya estableció. Revisa:
1. **Voz**: ¿habla como habla? (registro, vocabulario, ritmo, muletillas)
2. **Comportamiento**: ¿sus acciones y reacciones encajan con su personalidad, deseos y miedos?
3. **Arco**: ¿lo que hace aquí encaja con el punto del arco en que debería estar?
4. **Continuidad**: datos, relaciones o hechos que contradigan lo establecido.
Para cada inconsistencia: cita, por qué choca, y cómo arreglarla (o si podría justificarse como evolución deliberada). Termina con un veredicto de una línea: Consistente / Con matices / Inconsistente.`,

  dialogo: (
    c,
  ) => `Mejora el diálogo del fragmento seleccionado${c ? `, con atención especial a la voz de **${c.name}**` : ""}. Que cada personaje suene distinto y fiel a su ficha, que haya subtexto en vez de exposición, que se corten las líneas que sobran y que las acotaciones sean precisas (evita los verbos de dicción rebuscados). Explica brevemente los cambios principales.
${REWRITE_FORMAT}`,

  evolucion: (
    c,
  ) => `A partir del fragmento seleccionado y de todo lo que sabes de ${c ? `**${c.name}**` : "el personaje"}, sugiere cómo podría evolucionar. Incluye:
- Dónde está ahora en su arco y qué tensiones internas se ven en este fragmento.
- 3 a 5 posibles direcciones de desarrollo (algunas previsibles y alguna arriesgada), cada una con el detonante narrativo que la provocaría y qué cambiaría en su voz y comportamiento.
- Semillas concretas que se podrían plantar ya en este fragmento o cerca de él.
- Si conviene actualizar su ficha, propón el texto nuevo para el campo "Arco narrativo".`,
};

export function taskPrompt(opts: {
  action: AnalysisAction;
  character: Character | null;
  selection: string;
  before: string;
  after: string;
}): string {
  const { action, character, selection, before, after } = opts;
  const context = [
    before ? `<antes>\n…${before}\n</antes>` : null,
    `<seleccion>\n${selection}\n</seleccion>`,
    after ? `<despues>\n${after}…\n</despues>` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `Fragmento seleccionado por el autor (con un poco de contexto alrededor; trabaja solo sobre <seleccion>):

${context}

Tarea: ${TASKS[action](character)}`;
}
