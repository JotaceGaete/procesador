/**
 * Glosario de traducción (docs/traduccion.md). Cada chilenismo de la novela tiene una entrada:
 * su sentido, cómo se resuelve en la lengua de destino y si el autor ya lo confirmó. Las
 * entradas pendientes no se exportan hasta que se confirmen.
 */

export interface GlossaryEntry {
  /** Forma tal como aparece en el texto (por ejemplo "pa'" o "ricura"). */
  term: string;
  /** Qué quiere decir en el contexto de la novela. */
  meaning: string;
  /** Cómo se traduce. */
  target: string;
  /** "confirmado": el autor lo aprobó. "pendiente": todavía no. */
  status: "confirmado" | "pendiente";
  note?: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Las entradas del glosario que aparecen en el texto, en el orden del glosario.
 * El borde de palabra no usa \b, porque no reconoce letras con tilde ni la apóstrofe de "pa'".
 */
export function termsIn(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter((entry) => {
    const pattern = new RegExp(`(?<![\\p{L}])${escape(entry.term)}(?![\\p{L}])`, "iu");
    return pattern.test(text);
  });
}

/** Las entradas que todavía no tienen el visto bueno del autor. */
export function pendingTerms(glossary: GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter((e) => e.status === "pendiente");
}
