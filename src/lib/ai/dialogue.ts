/** Director de diálogos: instrucciones compactas, sin enviar la novela completa. */
export type DialogueParticipant = {
  name: string;
  role: "habla" | "escucha";
  /** Resumen obtenido de la ficha existente; vacío para un personaje ocasional. */
  personality?: string;
  voice?: string;
  knows?: string;
  unaware?: string;
  occasional?: boolean;
};

export type DialogueBrief = {
  argument: string;
  participants: DialogueParticipant[];
  context?: string;
  length?: "breve" | "media" | "larga";
};

const limits = { breve: 180, media: 350, larga: 600 } as const;
const clip = (value: string | undefined, max: number) => (value ?? "").trim().slice(0, max);

/**
 * Construye una petición pequeña y determinista. El servidor debe obtener las fichas
 * por ID desde la memoria autorizada; nunca confiar en fichas enviadas por el cliente.
 */
export function dialoguePrompt(brief: DialogueBrief): string {
  const argument = clip(brief.argument, 3000);
  if (!argument) throw new Error("Falta el argumento del diálogo.");
  if (brief.participants.length < 2 || brief.participants.length > 8)
    throw new Error("Selecciona entre dos y ocho personajes.");
  const names = new Set<string>();
  const people = brief.participants.map((p) => {
    const name = clip(p.name, 90);
    if (!name || names.has(name.toLocaleLowerCase("es")))
      throw new Error("Los participantes deben tener nombres distintos.");
    names.add(name.toLocaleLowerCase("es"));
    return [
      name + (p.occasional ? " (ocasional)" : "") + " — " + (p.role === "escucha" ? "presente, escucha" : "interviene"),
      !p.occasional && clip(p.personality, 350) ? "Carácter: " + clip(p.personality, 350) : "",
      !p.occasional && clip(p.voice, 250) ? "Voz: " + clip(p.voice, 250) : "",
      !p.occasional && clip(p.knows, 220) ? "Sabe: " + clip(p.knows, 220) : "",
      !p.occasional && clip(p.unaware, 220) ? "Ignora: " + clip(p.unaware, 220) : "",
    ].filter(Boolean).join("\n");
  });
  const maxWords = limits[brief.length ?? "media"];
  return [
    "Escribe una escena dialogada en español, con raya de diálogo, sin prólogo ni explicación.",
    "El argumento del autor determina la intención y el desenlace. No los cambies.",
    "Respeta la voz y el conocimiento de cada personaje. No reveles secretos desconocidos.",
    "Quien escucha puede reaccionar sin hablar; no obligues a todos a intervenir.",
    "No inventes biografías de personajes ocasionales. Evita frases expositivas y prosa artificial.",
    "Usa gestos breves solo cuando aporten significado.",
    "Extensión máxima aproximada: " + maxWords + " palabras.",
    "Participantes:\n" + people.join("\n\n"),
    clip(brief.context, 900) ? "Contexto inmediato:\n" + clip(brief.context, 900) : "",
    "Argumento y destino de la conversación:\n" + argument,
  ].filter(Boolean).join("\n\n");
}
