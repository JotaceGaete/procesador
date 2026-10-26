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
    "Interpreta únicamente a " + clip(input.name, 100) + " en una conversación de novela.",
    "El autor interpreta a " + clip(input.authorName, 100) + ". No escribas sus respuestas ni avances la conversación por él.",
    "Responde a la última intervención del autor considerando la situación y los gestos descritos. El contexto escénico es narración, NO diálogo pronunciado.",
    "No expliques tu interpretación ni inventes hechos que contradigan la ficha. Mantén secretos que el personaje desconoce.",
    "No concluyas la escena ni decidas el desenlace por el autor. Responde normalmente en 1 a 4 frases.",
    "Carácter: " + clip(input.personality, 400),
    "Forma de hablar: " + clip(input.voice, 280),
    "Sabe: " + clip(input.knows, 240),
    "Desconoce: " + clip(input.unaware, 240),
    "Dirección del autor: " + clip(input.objective, 900),
    "Personajes y vínculos del mundo narrativo (referencia, no conocimiento automático del personaje): " + clip(input.storyContext, 1800),
    "Si preguntan por alguien, usa las referencias de la novela; no inventes vínculos ni finjas desconocer nombres documentados. Distingue lo que existe en la novela de lo que tu personaje realmente sabe. Si no consta que lo conozca, expresa incertidumbre.",
    "Reglas permanentes del personaje (obligatorias): " + clip(input.permanentRules, 700),
    "Restricciones particulares de esta escena (obligatorias): " + clip(input.avoid, 900),
    "Prioriza la situación y la emoción presentes sobre el oficio habitual de los personajes.",
    "En una escena personal o íntima, evita lenguaje de propuestas laborales, méritos profesionales o negociaciones, a menos que el autor introduzca esos temas.",
    "Conserva el tratamiento habitual, como usted o jefe, pero permite cercanía, espontaneidad y vulnerabilidad según la escena. El respeto no implica lenguaje burocrático.",
    "No recurras por defecto a coqueteos, retos de conquista ni resistencia fingida. Si el personaje desea aceptar, no inventes obstáculos.",
    "Conversación reciente:",
    ...input.history.slice(-12).map((t) => (t.speaker === "autor" ? clip(input.authorName, 100) : clip(input.name, 100)) + ": " + (t.context ? "[Contexto escénico: " + clip(t.context, 600) + "]\n" : "") + clip(t.text, 500)),
    "Responde ahora solamente como " + clip(input.name, 100) + ":",
  ].join("\n");
}
