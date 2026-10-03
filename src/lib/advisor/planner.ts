import { nameMatcher } from "../ai/context";
import { ADVISOR_ACTIONS, type AdvisorAction } from "../types";

/**
 * Free questions, version 1 (docs/consejero.md §4): a deterministic planner. It
 * recognises characters and places (names and aliases), chapter numbers or titles,
 * threads by title and intent words, and picks the nearest recipe. No AI: the author
 * sees how the question was understood before reading the answer.
 */

const INTENTS: [AdvisorAction, RegExp][] = [
  ["seguir", /c[oó]mo (sigo|seguir|contin[uú]o|continuar)|qu[eé] (pasa|viene|hago) (despu[eé]s|ahora)|siguiente (escena|cap[ií]tulo)|continuaci[oó]n|hacia d[oó]nde/i],
  ["repeticiones", /repit|repeti|reiter|muletilla|redundan/i],
  ["coherencia", /coheren|contradic|incoheren|demasiado pronto|antes de tiempo|revel|continuidad|sab[ií]a|no deber[ií]a saber|error/i],
  ["cabos", /\bcabos?\b|pendiente|sin resolver|hilos?\b|olvid|abandon|cerrar|qued[oó] abierto/i],
  ["personajes", /personaje|desaprovech|evoluci|\barco\b|presencia|protagonista|secundari/i],
  ["analizar", /ritmo|estructura|funciona|analiz|tensi[oó]n|escena|cap[ií]tulo/i],
];

export interface Plan {
  action: AdvisorAction;
  characterIds: string[];
  placeIds: string[];
  /** Chapter indexes named in the question ("el capítulo 3", "el 7", or a title). */
  chapterIndexes: number[];
  threadIds: string[];
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

  let action: AdvisorAction = INTENTS.find(([, re]) => re.test(q))?.[0] ?? (characterIds.length ? "personajes" : "analizar");
  if (threadIds.length && action === "analizar") action = "cabos";
  return { action, characterIds, placeIds, chapterIndexes: [...chapterIndexes].sort((a, b) => a - b), threadIds };
}

export const actionLabel = (a: AdvisorAction) => ADVISOR_ACTIONS.find((x) => x.id === a)!.label;
