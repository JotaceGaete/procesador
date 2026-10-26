/** Contexto compacto para interpretar a un personaje, una respuesta por turno. */
export type RoleTurn = { speaker: "autor" | "personaje"; text: string };
export function roleplayPrompt(input: {
  name: string; authorName: string; personality?: string; voice?: string; knows?: string; unaware?: string;
  objective?: string; history: RoleTurn[];
}): string {
  const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
  if (!input.name.trim()) throw new Error("Selecciona el personaje.");
  if (!input.history.length || input.history.at(-1)?.speaker !== "autor") throw new Error("Escribe tu intervención.");
  return [
    "Interpreta únicamente a " + clip(input.name, 100) + " en una conversación de novela.",
    "El autor interpreta a " + clip(input.authorName, 100) + ". No escribas sus respuestas ni avances la conversación por él.",
    "Contesta solamente al último mensaje, en primera persona, con naturalidad. Puedes incluir gestos muy breves.",
    "No expliques tu interpretación ni inventes hechos que contradigan la ficha. Mantén secretos que el personaje desconoce.",
    "No concluyas la escena ni decidas el desenlace por el autor. Responde normalmente en 1 a 4 frases.",
    "Carácter: " + clip(input.personality, 400),
    "Forma de hablar: " + clip(input.voice, 280),
    "Sabe: " + clip(input.knows, 240),
    "Desconoce: " + clip(input.unaware, 240),
    "Dirección del autor: " + clip(input.objective, 900),
    "Conversación reciente:",
    ...input.history.slice(-12).map((t) => (t.speaker === "autor" ? clip(input.authorName, 100) : clip(input.name, 100)) + ": " + clip(t.text, 500)),
    "Responde ahora solamente como " + clip(input.name, 100) + ":",
  ].join("\n");
}
