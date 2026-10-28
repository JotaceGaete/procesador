/**
 * Traducción por bloques (docs/traduccion.md): el texto se parte en bloques de párrafos enteros,
 * cada bloque se traduce con su tabla (original, chilenismos marcados, traducción, nota) y la
 * tabla se lee de vuelta sin perder ningún párrafo.
 */

import type { GlossaryEntry } from "./glossary";

export interface Row {
  original: string;
  marked: string;
  translation: string;
  note: string;
}

/**
 * Parte el texto en bloques de párrafos enteros, de como mucho `maxChars` caracteres.
 * Un párrafo nunca se corta: si ya supera el máximo, va solo en su bloque.
 */
export function splitBlocks(text: string, maxChars = 3000): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > maxChars) {
      blocks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Lee la tabla Markdown que devuelve el modelo: cuatro columnas, una fila por párrafo. */
export function parseTable(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    // La cabecera y la línea de guiones no son filas.
    if (cells.every((c) => /^-+$/.test(c.replace(/:/g, "")))) continue;
    if (cells[0] === "Original") continue;
    if (cells.length !== 4) throw new Error(`La tabla debe tener 4 columnas y tiene ${cells.length}: ${line.slice(0, 80)}`);
    const [original, marked, translation, note] = cells;
    rows.push({ original, marked, translation, note });
  }
  return rows;
}

/** Une las filas en la traducción: los párrafos traducidos, separados por una línea en blanco. */
export function translatedText(rows: Row[]): string {
  return rows.map((r) => r.translation).join("\n\n");
}

/**
 * El pedido para traducir un bloque. Sólo pide la tabla: sin prólogo, sin notas fuera de ella,
 * sin añadir acontecimientos. El glosario manda sobre cualquier otra opción del modelo.
 */
export function blockPrompt(input: {
  block: string;
  glossary: GlossaryEntry[];
  /** La última traducción aprobada, para mantener la voz entre bloques. */
  previous?: string;
  /** Nombres de los personajes, que no se traducen. */
  names: string[];
}): string {
  const glossary = input.glossary.length
    ? input.glossary.map((e) => `- «${e.term}» = ${e.meaning} → en inglés: «${e.target}»${e.status === "pendiente" ? " (pendiente: márcalo en la nota)" : ""}`).join("\n")
    : "(sin entradas)";
  return [
    "Traduce al inglés el bloque de una novela chilena, párrafo por párrafo.",
    "Devuelve SÓLO una tabla Markdown con cuatro columnas: | Original | Chilenismos | Inglés | Nota |. Una fila por párrafo, en el mismo orden. Sin texto antes ni después.",
    "En «Chilenismos» copia las palabras del original que son chilenismos (o «—» si no hay ninguno).",
    "Traduce el sentido y el tono, no palabra por palabra. Conserva todos los hechos, el orden y quién habla. No añadas nada que no esté en el original.",
    "Los nombres propios no se traducen: " + (input.names.join(", ") || "ninguno") + ".",
    "Usa el glosario tal cual para cada término que aparezca. Si un modismo no está en el glosario y no estás seguro, márcalo en «Nota» con «¿?» y tradúcelo por el sentido.",
    "Glosario:\n" + glossary,
    input.previous ? "Último párrafo ya aprobado (para la voz, no lo repitas):\n" + input.previous : "",
    "Bloque a traducir:\n" + input.block,
  ].filter(Boolean).join("\n\n");
}
