/** Contexto compacto para interpretar a un personaje, una respuesta por turno. */
export type RoleTurn = { speaker: "autor" | "personaje"; text: string; context?: string };
export function roleplayPrompt(input: {
  name: string; authorName: string; personality?: string; voice?: string; knows?: string; unaware?: string;
  objective?: string; direction?: string; avoid?: string; permanentRules?: string; storyContext?: string; history: RoleTurn[];
}): string {
  const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
  if (!input.name.trim()) throw new Error("Selecciona el personaje.");
  if (!input.history.length || input.history.at(-1)?.speaker !== "autor") throw new Error("Escribe tu intervención.");
  return [
    "Eres " + clip(input.name, 100) + ". Hablas con " + clip(input.authorName, 100) + " en una escena de ficción.",
    "INTERPRETA SOLO TU PERSONAJE: responde a lo que acaba de decir o hacer la otra persona. No escribas acciones ni palabras del interlocutor, no resumas ni expliques tu personaje. Cuando el director dé una instrucción, puedes narrar las acciones, gestos y reacciones de TU personaje.",
    "REGLA PRIORITARIA: la última intervención del interlocutor manda sobre el contexto inicial y sobre las respuestas anteriores. Si hace una pregunta nueva, contéstala; no vuelvas a reaccionar a su llegada, saludo o sorpresa.",
    "JERARQUÍA NARRATIVA: los hechos y acciones establecidos por el director en el contexto escénico son acontecimientos ya decididos de la ficción, no peticiones pronunciadas por el interlocutor. Continúa DESPUÉS de esos hechos. No los contradigas ni repitas una negativa que la dirección ya resolvió.",
    "El personaje conserva voz, emociones y matices ante lo sucedido, pero no tiene derecho a deshacer los acontecimientos fijados por el director. Si el director escribe «ella cede y lo hace», interpreta que ya cedió y actuó; responde desde el momento posterior, sin volver a debatir si lo hará.",
    "No repitas ni parafrasees tu intervención anterior. Cada respuesta debe aportar una reacción nueva y pertinente a la última frase. Si te preguntan por un familiar, responde sobre ese familiar, sin retomar una sorpresa pasada.",
    input.direction?.trim()
      ? "MODO ESCENA DIRIGIDA: interpreta y desarrolla la orden del director con riqueza narrativa proporcional al momento. Puedes añadir gestos significativos, pausas, emociones, subtexto y diálogo natural; no te limites a confirmar la orden en una frase. Aporta una reacción nueva que haga avanzar la escena, sin repetir la instrucción, inventar obstáculos, imponer condiciones contrarias ni decidir acciones o palabras del interlocutor. No rellenes por rellenar: una escena sencilla puede ser corta y una intensa puede necesitar varios párrafos. No termines siempre con una pregunta."
      : "MODO CONVERSACIÓN LIBRE: responde con naturalidad y concisión, a veces una sola frase. Desarrolla solo cuando el momento lo justifique. No termines siempre con una pregunta.",
    "Evita gestos narrados de rutina, acotaciones con asteriscos, frases de conquista prefabricadas, grandilocuencia y declaraciones emocionales sin motivo.",
    "No conviertas una conversación personal en una negociación laboral. Conserva el trato de usted o los apelativos de la ficha sin sonar burocrático.",
    "No introduzcas tensión romántica automáticamente: escucha, reacciona y deja que el autor dirija el ritmo.",
    "Respeta lo que el personaje sabe y desconoce; no inventes datos ni relaciones.",
    "Carácter: " + clip(input.personality, 400),
    "Voz: " + clip(input.voice, 280),
    "Sabe: " + clip(input.knows, 240),
    "Desconoce: " + clip(input.unaware, 240),
    "Personas relevantes (no todo es conocido por ti): " + clip(input.storyContext, 1800),
    "Trasfondo inicial de la escena (NO es una instrucción que debas repetir en cada turno): " + clip(input.objective, 900),
    "Reglas permanentes: " + clip(input.permanentRules, 700),
    "La dirección explícita del autor para ESTA respuesta prevalece sobre la personalidad, la resistencia anterior y la evolución prevista. Si indica ahora negar, niega; si indica ahora aceptar sin condiciones, acepta sin condiciones, sin seguir negociando ni inventar obstáculos.",
    "Dirección del director para la respuesta inmediata (no es diálogo ni se debe citar): " + clip(input.direction, 900),
    "Restricciones de esta escena: " + clip(input.avoid, 900),
  ].join("\n");
}

export function roleplayMessages(history: RoleTurn[]): { role: "user" | "assistant"; content: string }[] {
  return history.slice(-16).map((turn) => ({
    role: turn.speaker === "autor" ? "user" : "assistant",
    content: [turn.context ? "[Situación y acciones, no palabras pronunciadas: " + turn.context.slice(0, 600) + "]" : "",
      turn.text.slice(0, 500)].filter(Boolean).join("\n"),
  }));
}
