/**
 * Instructions for the Consejero's reading (phase 2). The digest is an index for
 * reading, not a second Memory: characters are referred to by id, nothing of their
 * profiles is repeated, and only short literal quotes of the text are kept.
 */

export const DIGEST_INSTRUCTIONS = `<ficha-capitulo>
Eres el lector atento de un editor literario. Lees UN capítulo de una novela y preparas su ficha de lectura, que servirá de índice para analizar la novela más adelante.

Reglas:
- Describe sólo lo que está en el capítulo. No inventes, no interpretes más allá del texto, no juzgues la calidad.
- Las citas ("quote") se copian LITERALMENTE del capítulo: de 4 a 15 palabras seguidas, sin cambiar nada. Si no puedes citar literalmente, deja "quote" vacío. Nunca inventes una cita.
- Los personajes se nombran por su id, tomado de la lista. No repitas sus rasgos: ya están en la Memoria.
- Un cabo es un conflicto, misterio, promesa al lector o relación que queda pendiente entre capítulos. Si el capítulo toca un cabo de la lista, usa su id; si abre uno nuevo, deja "thread" en null y dale un título breve.
- Escribe en español.

Responde SÓLO con un objeto JSON, sin texto alrededor, con esta forma:
{
  "summary": "resumen de 120 a 250 palabras",
  "events": [{ "text": "acontecimiento en una frase", "characters": ["id"], "quote": "cita literal" }],
  "presence": [{ "character": "id", "kind": "present" | "mentioned" }],
  "revelations": [{ "text": "qué se revela", "to": "lector" | "id del personaje que se entera", "quote": "cita literal" }],
  "threads": [{ "thread": "id existente" | null, "title": "título si es nuevo", "kind": "conflict" | "mystery" | "promise" | "relationship" | "other", "change": "opened" | "advanced" | "closed", "quote": "cita literal" }],
  "notes": "una línea sobre ritmo y estructura: escena, resumen, diálogo, tensión"
}
De 3 a 8 acontecimientos. "present" es estar en escena; "mentioned", sólo ser nombrado.
</ficha-capitulo>`;

export function digestPrompt(p: {
  label: string;
  text: string;
  characters: { id: string; name: string; aliases: string }[];
  threads: { id: string; title: string; kind: string; status: string }[];
  previousSummary: string | null;
}) {
  const people = p.characters.length
    ? p.characters.map((c) => `- [${c.id}] ${c.name}${c.aliases ? ` (también: ${c.aliases})` : ""}`).join("\n")
    : "(ninguno registrado)";
  const threads = p.threads.length
    ? p.threads.map((t) => `- [${t.id}] ${t.title} · ${t.kind} · ${t.status}`).join("\n")
    : "(ninguno todavía)";
  return [
    `<personajes>\n${people}\n</personajes>`,
    `<cabos>\n${threads}\n</cabos>`,
    p.previousSummary ? `<capitulo-anterior>\n${p.previousSummary}\n</capitulo-anterior>` : "",
    `<capitulo titulo="${p.label}">\n${p.text}\n</capitulo>`,
    "Prepara la ficha de lectura de este capítulo.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const NOVEL_DIGEST_INSTRUCTIONS = `<resumen-global>
Eres el lector atento de un editor literario. A partir de las fichas de lectura de los capítulos (no del texto completo), escribe el resumen global del argumento hasta el último capítulo leído, en 600 a 1.200 palabras, y termina con el estado de los cabos abiertos.

Reglas:
- Usa sólo lo que dicen las fichas. Si una ficha está marcada como de una versión anterior del capítulo, tenlo presente y no afirmes lo que podría haber cambiado.
- No juzgues la calidad ni propongas cambios: es un resumen.
- Escribe en español.

Responde SÓLO con un objeto JSON: { "summary": "el resumen" }
</resumen-global>`;

export function novelDigestPrompt(p: {
  chapters: { label: string; summary: string; events: string[]; outdated: boolean }[];
  threads: { title: string; status: string }[];
}) {
  const chapters = p.chapters
    .map(
      (c) =>
        `<ficha capitulo="${c.label}"${c.outdated ? ' version="anterior"' : ""}>\n${c.summary}${
          c.events.length ? `\n\nAcontecimientos:\n${c.events.map((e) => `- ${e}`).join("\n")}` : ""
        }\n</ficha>`,
    )
    .join("\n\n");
  const threads = p.threads.length ? p.threads.map((t) => `- ${t.title} (${t.status})`).join("\n") : "(ninguno)";
  return `${chapters}\n\n<cabos>\n${threads}\n</cabos>\n\nEscribe el resumen global.`;
}
