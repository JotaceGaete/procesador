import { nameMatcher } from "./ai/context";

/**
 * Estado narrativo de un personaje al terminar un capítulo (docs/estado-narrativo.md).
 * Es memoria de continuidad: dónde está, qué sabe, en qué estado físico está y qué lleva.
 * Sólo los estados aprobados por el autor cuentan; los sugeridos por la lectura de un
 * capítulo no se usan hasta que él los acepta, igual que los hechos.
 */
export interface CharacterState {
  id: string;
  character_id: string;
  /** Posición del capítulo en la novela (0 para el primero). Ordena sin depender de ids. */
  chapter_order: number;
  /** Vive al terminar el capítulo. Un personaje que no vive no puede actuar en capítulos posteriores. */
  alive: boolean;
  location: string;
  knows: string;
  physical: string;
  objects: string;
  status: "approved" | "suggested";
}

/**
 * El estado vigente de un personaje antes de un capítulo: el aprobado más reciente cuyo
 * capítulo es anterior. Los estados del propio capítulo no cuentan: se escriben al cerrarlo.
 */
export function stateBefore(states: CharacterState[], characterId: string, chapterOrder: number): CharacterState | null {
  let best: CharacterState | null = null;
  for (const s of states) {
    if (s.character_id !== characterId || s.status !== "approved" || s.chapter_order >= chapterOrder) continue;
    if (!best || s.chapter_order > best.chapter_order) best = s;
  }
  return best;
}

/** Una línea por dato conocido, para el contexto de la IA. Vacío si no hay nada que decir. */
export function describeState(s: CharacterState, name: string): string {
  if (!s.alive) return `${name}: MUERTO/A al terminar el capítulo ${s.chapter_order + 1}. No puede actuar ni hablar después, salvo en recuerdos.`;
  const parts = [
    s.location && `está en ${s.location}`,
    s.knows && `sabe: ${s.knows}`,
    s.physical && `estado físico: ${s.physical}`,
    s.objects && `lleva: ${s.objects}`,
  ].filter(Boolean);
  return parts.length ? `${name} (fin del capítulo ${s.chapter_order + 1}): ${parts.join("; ")}.` : "";
}

/**
 * Advertencias de continuidad sobre una propuesta: un personaje que ya murió y que la
 * propuesta hace actuar. Cautelosa como continuity.ts: una advertencia es un «revisa», no un
 * veredicto, porque la propuesta puede recordarlo. Por eso sólo mira las menciones con verbo
 * de acción cercano; si la mención es evocación, el autor lo juzga.
 */
export function deadCharacterWarnings(opts: {
  proposal: string;
  characters: { id: string; name: string; aliases: string }[];
  states: CharacterState[];
  chapterOrder: number;
}): string[] {
  const warnings: string[] = [];
  for (const c of opts.characters) {
    const s = stateBefore(opts.states, c.id, opts.chapterOrder);
    if (!s || s.alive) continue;
    const matcher = nameMatcher(c);
    if (!matcher) continue;
    const mention = opts.proposal.match(matcher);
    if (!mention || mention.index === undefined) continue;
    // Los verbos de memoria pueden ir antes o después del nombre («recordó a don Eduardo», «Eduardo, que había muerto»).
    const near = opts.proposal.slice(Math.max(0, mention.index - 60), mention.index + mention[0].length + 60);
    if (/\b(recuerd|record|pens|evoc|imagin|soñ|en la memoria|como cuando)/iu.test(near)) continue;
    warnings.push(
      `${c.name} murió al terminar el capítulo ${s.chapter_order + 1} y aparece en la propuesta. Revisa si es un recuerdo.`,
    );
  }
  return warnings;
}

/** Una fila de la tabla character_states, tal como la devuelve la base. */
export interface StateRow {
  id: string;
  character_id: string;
  chapter_id: string;
  alive: boolean;
  location: string;
  knows: string;
  physical: string;
  objects: string;
  status: "approved" | "suggested";
}

/**
 * Pasa las filas a estados con su posición en la novela. `chapterIds` va en el orden de los
 * capítulos. Las filas de capítulos que ya no existen se descartan, sin error.
 */
export function toCharacterStates(rows: StateRow[], chapterIds: string[]): CharacterState[] {
  const order = new Map(chapterIds.map((id, i) => [id, i]));
  const out: CharacterState[] = [];
  for (const r of rows) {
    const chapter_order = order.get(r.chapter_id);
    if (chapter_order === undefined) continue;
    out.push({
      id: r.id,
      character_id: r.character_id,
      chapter_order,
      alive: r.alive,
      location: r.location,
      knows: r.knows,
      physical: r.physical,
      objects: r.objects,
      status: r.status,
    });
  }
  return out;
}
