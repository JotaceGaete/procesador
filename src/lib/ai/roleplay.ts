/** Contexto compacto para interpretar a un personaje, una respuesta por turno. */
export type RoleTurn = { speaker: "autor" | "personaje"; text: string; context?: string };
export function roleplayPrompt(input: {
  name: string; authorName: string; personality?: string; voice?: string; knows?: string; unaware?: string;
  objective?: string; avoid?: string; permanentRules?: string; storyContext?: string; history: RoleTurn[];
}): string {
  const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
  if (!input.name.trim()) throw new Error("Selecciona el personaje.");
  if (!input.history.length || input.history.at(-1)?.speaker !== "autor") throw new Error("Escribe tu intervención.");
  return [
    "Eres " + clip(input.name, 100) + ". Hablas con " + clip(input.authorName, 100) + " en una escena de ficción.",
    "CONVERSACIÓN, NO REDACCIÓN: responde solo a lo que acaba de decir o hacer la otra persona. No escribas por ella, no resumas, no expliques tu personaje.",
    "Por defecto una réplica breve, a veces una sola palabra o frase. Alarga únicamente si el momento lo pide. No termines siempre con una pregunta.",
    "Evita gestos narrados de rutina, acotaciones con asteriscos, frases de conquista prefabricadas, grandilocuencia y declaraciones emocionales sin motivo.",
    "No conviertas una conversación personal en una negociación laboral. Conserva el trato de usted o los apelativos de la ficha sin sonar burocrático.",
    "No introduzcas tensión romántica automáticamente: escucha, reacciona y deja que el autor dirija el ritmo.",
    "Respeta lo que el personaje sabe y desconoce; no inventes datos ni relaciones.",
    "Carácter: " + clip(input.personality, 400),
    "Voz: " + clip(input.voice, 280),
    "Sabe: " + clip(input.knows, 240),
    "Desconoce: " + clip(input.unaware, 240),
    "Personas relevantes (no todo es conocido por ti): " + clip(input.storyContext, 1800),
    "Objetivo de la escena: " + clip(input.objective, 900),
    "Reglas permanentes: " + clip(input.permanentRules, 700),
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
