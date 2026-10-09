import { nameMatcher } from "../ai/context";
import { ADVISOR_ACTIONS, type AdvisorAction } from "../types";

/**
 * Free questions, version 1 (docs/consejero.md §4): a deterministic planner. It
 * recognises characters and places (names and aliases), chapter numbers or titles,
 * threads by title and intent words, and picks the nearest recipe. No AI: the author
 * sees how the question was understood before reading the answer.
 */

const INTENTS: [AdvisorAction, RegExp][] = [
  // Creative (phase 1 of the creative Consejero). First: they are the most specific.
  ["consecuencias", /qu[eé] (pasa|pasar[ií]a|ocurre|ocurrir[ií]a|sucede|suceder[ií]a|implica|implicar[ií]a|provoca|provocar[ií]a|cambia|cambiar[ií]a) si\b|(^|[¿,.;]\s*)y si\b|consecuencias?|repercusi|qu[eé] efecto tendr/i],
  ["giro", /\bgiros?\b|vuelta de tuerca|sorprend|sorpresa|inesperad|golpe de efecto|sacudir/i],
  // «Mejora esta escena», «hazla más atractiva»: a review of what is written, not new plot.
  ["revisar", /\bmej[oó]r(o|a|as|ar|arla|arlo|ala|alo|ar[ií]a|emos)\b|m[aá]s (atractiv|interesante|viv[ao]|intens|lograd|eficaz)|\bp[uú]l(e|ela|elo|ir|irla|irlo)\b|qu[eé] le falta|revis(a|ar|emos) (la|esta|mi) escena|(c[oó]mo|qu[eé]) (te parece|ves) (la|esta|mi) escena|esta escena funciona/i],
  ["tension", /(subir|aumentar|elevar|m[aá]s|falta|poca|sin|baja)\s+(la\s+)?tensi[oó]n|tensi[oó]n\s+(baja|cae|decae|se pierde)|m[aá]s tens[oa]|suspense|suspenso|aburrid|se hace lent/i],
  ["caminos", /\b(tres|3|varios|otros|distintos|diferentes|algunos)\s+caminos|caminos posibles|qu[eé] opciones tengo|opciones (para|de) (seguir|continuar)|alternativas para|ideas para (seguir|continuar)/i],
  ["oportunidades", /oportunidad|(?<!des)aprovech|potencial|qu[eé] (puedo|podr[ií]a) (usar|explotar)|explotar/i],
  ["seguir", /c[oó]mo (puedo |podr[ií]a |deber[ií]a |debo |lo |la )?(sigo|seguir|contin[uú]o|continuar|contin[uú]a)|por d[oó]nde (sigo|seguir|contin[uú]o|continuar)|no s[eé] (por d[oó]nde |c[oó]mo )?(seguir|continuar|sigo|contin[uú]o)|bloquead|atascad|y ahora qu[eé]|qu[eé] (pasa|viene|hago) (despu[eé]s|ahora)|siguiente (escena|cap[ií]tulo)|continuaci[oó]n|hacia d[oó]nde/i],
  // Analytic.
  ["repeticiones", /repit|repeti|reiter|muletilla|redundan/i],
  ["coherencia", /coheren|contradic|incoheren|demasiado pronto|antes de tiempo|revel|continuidad|sab[ií]a|no deber[ií]a saber|error/i],
  ["cabos", /\bcabos?\b|pendiente|sin resolver|hilos?\b|olvid|abandon|cerrar|qued[oó] abierto/i],
  ["personajes", /personaje|desaprovech|evoluci|\barco\b|presencia|protagonista|secundari/i],
  ["analizar", /ritmo|estructura|funciona|analiz|tensi[oó]n|escena|cap[ií]tulo/i],
];

/**
 * Intents that start something new: with them, a message doesn't keep developing the
 * proposal in course (the others — or none — do: "pero que aparezca Nacho").
 */
export const NEW_TOPIC: AdvisorAction[] = ["seguir", "caminos", "oportunidades", "repeticiones", "coherencia", "cabos", "revisar"];

export interface Plan {
  action: AdvisorAction;
  characterIds: string[];
  placeIds: string[];
  /** Chapter indexes named in the question ("el capítulo 3", "el 7", or a title). */
  chapterIndexes: number[];
  threadIds: string[];
  /** The intent the words matched (null: none; the action is then a fallback). */
  explicit: AdvisorAction | null;
}

interface Named {
  id: string;
  name: string;
  aliases: string;
}

export function planQuestion(
  question: string,
  ctx: { characters: Named[]; places: Named[]; chapters: { title: string }[]; threads: { id: string; title: string }[] },
): Plan {
  const q = question.trim();
  const characterIds = ctx.characters.filter((c) => nameMatcher(c)?.test(q)).map((c) => c.id);
  const placeIds = ctx.places.filter((p) => nameMatcher(p)?.test(q)).map((p) => p.id);
  const lower = q.toLocaleLowerCase("es");

  const chapterIndexes = new Set<number>();
  for (const m of q.matchAll(/cap(?:[ií]tulos?|\.)\s*(\d+)(?:\s*(?:y|,|al|a)\s*(?:el\s*)?(\d+))?/gi)) {
    for (const n of [m[1], m[2]]) if (n && +n >= 1 && +n <= ctx.chapters.length) chapterIndexes.add(+n - 1);
  }
  ctx.chapters.forEach((c, i) => {
    const t = c.title.trim().toLocaleLowerCase("es");
    if (t.length >= 4 && lower.includes(t)) chapterIndexes.add(i);
  });
  const threadIds = ctx.threads.filter((t) => t.title.length >= 4 && lower.includes(t.title.toLocaleLowerCase("es"))).map((t) => t.id);

  const explicit = INTENTS.find(([, re]) => re.test(q))?.[0] ?? null;
  let action: AdvisorAction = explicit ?? (characterIds.length ? "personajes" : "analizar");
  if (threadIds.length && action === "analizar") action = "cabos";
  return { action, characterIds, placeIds, chapterIndexes: [...chapterIndexes].sort((a, b) => a - b), threadIds, explicit };
}

export const actionLabel = (a: AdvisorAction) => ADVISOR_ACTIONS.find((x) => x.id === a)!.label;
