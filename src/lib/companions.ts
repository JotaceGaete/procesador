/**
 * Compañeros de lectura (docs/companeros.md). Cada uno es una ficha de estilo que escribe el autor.
 * Antes de opinar, el compañero lee el argumento y el capítulo; el contexto que recibe es el
 * mínimo necesario, no el manuscrito completo.
 */

import { compileGuide } from "./guide";

export interface Companion {
  id: string;
  name: string;
  /** Estilo literario y forma de acompañar, en las palabras del autor. */
  style: string;
  /** Tipo de novela para el que se elige por defecto (valor del campo género de la Guía). */
  audiences: string[];
}

/**
 * Presets iniciales. Las descripciones de estilo las reemplaza el autor con las suyas.
 * Mientras no lo haga, el compañero no inventa un estilo: sólo lee y pregunta.
 */
export const COMPANIONS: Companion[] = [
  {
    id: "kiki",
    name: "Kiki",
    style: "PENDIENTE: descripción de estilo del autor.",
    audiences: ["infantil", "juvenil"],
  },
  {
    id: "bruno",
    name: "Bruno",
    style: "PENDIENTE: descripción de estilo del autor.",
    audiences: ["adulta", "adulto", "policial", "novela negra"],
  },
];

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Elige el compañero por el género de la Guía. Si no hay coincidencia, usa el que el autor
 * eligió para la novela (o el primero), para que nunca falte uno.
 */
export function pickCompanion(genre: string | undefined, chosenId?: string): Companion {
  if (chosenId) {
    const chosen = COMPANIONS.find((c) => c.id === chosenId);
    if (chosen) return chosen;
  }
  const g = norm(genre ?? "");
  const match = g && COMPANIONS.find((c) => c.audiences.some((a) => g.includes(a)));
  return match || COMPANIONS[0];
}

export interface CompanionInput {
  companion: Companion;
  novel: { title: string; guide: Record<string, unknown> };
  /** Sinopsis o argumento general de la novela. */
  synopsis: string;
  /** Texto del capítulo que el autor tiene abierto. */
  chapter: string;
  /** Final del capítulo anterior, para la continuidad inmediata. */
  previousTail?: string;
  /** Lo que el autor pide ahora (por ejemplo «Leamos juntos»). */
  request: string;
}

/**
 * Pedido al compañero. Obliga a leer antes de opinar y a limitarse al material entregado.
 * Sólo recibe lo necesario para la tarea: no le damos el manuscrito entero.
 */
export function companionPrompt(input: CompanionInput): string {
  const guide = compileGuide(input.novel as never);
  return [
    `Eres ${input.companion.name}, compañero de lectura del autor de esta novela.`,
    input.companion.style.startsWith("PENDIENTE")
      ? "Todavía no tienes un estilo definido: limítate a leer, preguntar y describir lo que ves, sin dar juicios de estilo."
      : `Tu estilo y forma de acompañar: ${input.companion.style}`,
    "ANTES de opinar debes leer el argumento y el capítulo. Si el capítulo no está, dilo y no opines.",
    "Lo que sabes de la novela es sólo lo que aparece abajo. No inventes personajes, hechos ni fechas que no estén allí.",
    "Si algo que escribe el autor contradice la Guía o la sinopsis, señálalo en una línea en vez de corregirlo.",
    "Guía Maestra:\n" + guide,
    "Argumento:\n" + (input.synopsis.trim() || "(sin argumento)"),
    input.previousTail ? "Final del capítulo anterior:\n" + input.previousTail : "",
    "Capítulo abierto:\n" + input.chapter,
    "Pedido del autor: " + input.request,
  ].filter(Boolean).join("\n\n");
}
