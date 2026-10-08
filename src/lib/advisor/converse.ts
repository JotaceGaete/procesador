import type { ObservationKind } from "../types";
import type { CardRef, ConversationMessage } from "./cards";

/**
 * The Consejero as a writing companion (docs/consejero.md, «Conversar»). Pure functions,
 * shared by the server and the panel, so both read the author's words the same way:
 *
 *   intents    «me gusta», «desarróllala», «envíala al Asistente», «guárdala», «dame
 *              opciones», or an explicit request for an analysis: recognised without AI.
 *   decisions  what the author decides in the conversation («quiero que Waldo haya sido
 *              novio de Pola»): kept in their own words as the PLAN, never as canon.
 *   discarded  what the author rules out («sin Nacho», «no quiero que…»).
 *   brief      the scene order the Consejero hands to the Asistente, validated.
 */

export type AdvisorMode = "conversar" | "analizar";

const norm = (t: string) => t.trim().toLocaleLowerCase("es");

/** An explicit request for an evaluation: that turn goes to Analizar. */
export function wantsAnalysis(text: string): boolean {
  return /\banaliz|\brevis(a|ar|emos)\b.{0,30}(coheren|ritmo|cap[ií]tulo|repetic|cabos|personajes)|\brepetic|\bcoheren|contradic|cabos? (pendientes|abiertos|sueltos)|\bauditor|\beval[uú]a/i.test(text);
}

/** The author asks for several possibilities (otherwise the Consejero proposes one). */
export function wantsOptions(text: string): boolean {
  return /\b(opciones|alternativas|posibilidades|varias (ideas|propuestas|formas)|otras ideas|(dos|tres|cuatro|2|3|4|varios|otros|distintos) caminos|dame (algunas|varias|m[aá]s) ideas)\b/i.test(text);
}

/** «Me gusta», «esa quiero», «desarróllala», «sigue con eso»: continue the proposal on the table. */
export function likesProposal(text: string): boolean {
  const t = norm(text);
  return (
    /^(s[ií][,.!]?\s*)?(me gusta|me encanta|me convence|esa|esta|eso|perfecto|genial|dale|vale|ok|de acuerdo|bien|me quedo con (esa|esta|eso))\b/.test(t) ||
    /\b(desarr[oó]ll(a|ala|alo|emos|ar)|sigue con (esa|esta|eso)|contin[uú]a (con )?(esa|esta|eso|la idea)|esa (me gusta|quiero)|esa idea|esa propuesta|me gusta (esa|esta|la idea|tu propuesta))\b/.test(t)
  );
}

/** «Envíala al Asistente», «mándala al asistente», «escríbela»: the brief, not another answer. */
export function wantsHandoff(text: string): boolean {
  return /\b(env[ií]a(la|lo|r)?|m[aá]nda(la|lo|r)?|p[aá]sa(la|lo|r)?|ll[eé]va(la|lo|r)?)\b.{0,20}\basistente\b|\bal asistente\b|^escr[ií]bela\b/i.test(text);
}

/** «Guárdala», «guarda esa idea». */
export function wantsSave(text: string): boolean {
  return /^\s*(gu[aá]rdala|gu[aá]rdalo|guarda (esa|esta|la) idea|gu[aá]rdame (esa|esta))\b/i.test(text);
}

const DECISION =
  /\b(quiero que|he decidido|decid[ií] que|decido que|va a ser|ser[aá] que|que sea|prefiero que|vamos a (hacer|decir|poner) que|lo vamos a hacer|en mi novela|lo haremos as[ií]|quiero hacerlo as[ií]|ser[aá] as[ií])\b/i;
// «sin Nacho» (a name: «sin embargo» is not a discard) or the words of ruling something out.
const WITHOUT_NAME = /(?:^|[^\p{L}])sin ([A-ZÁÉÍÓÚÑ]\p{L}+)/u;
const DISCARD = /\b(no quiero que|descart|olv[ií]da(te)? (de )?(eso|esa|esto|lo de)|nada de|que no (aparezca|est[eé]|salga|haya))/iu;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The author's decisions in a message, in their own words (one per sentence). */
export function decisionsIn(text: string): string[] {
  return sentences(text)
    .filter((s) => DECISION.test(s) && !/^no quiero que/i.test(s))
    .map((s) => s.slice(0, 400));
}

/** What the author rules out in a message («mejor sin Nacho», «no quiero que muera»). */
export function discardsIn(text: string): string[] {
  return sentences(text)
    .filter((s) => WITHOUT_NAME.test(s) || DISCARD.test(s))
    .map((s) => s.slice(0, 400));
}

/** The latest proposal on the table that the author hasn't discarded. */
export function lastProposal(cards: CardRef[], kinds: ObservationKind[] = ["alternative", "opportunity"]): CardRef | null {
  return [...cards].reverse().find((c) => kinds.includes(c.kind) && c.status !== "dismissed") ?? null;
}

export interface Plan {
  /** Each decision with the index of the message it came from (to edit or remove it). */
  decisions: { text: string; message: number }[];
  discarded: { text: string; message: number }[];
}

/** Names in a sentence (capitalised words not at its start). */
function names(s: string): string[] {
  return [...s.matchAll(/(?<=[^\p{L}.!?¿¡«"]\s?)([A-ZÁÉÍÓÚÑ]\p{L}{2,})/gu)].map((m) => m[1]);
}

/**
 * The decisions and discards of the whole conversation, from the author's messages. A later
 * discard that names someone («mejor sin Nacho») takes back the earlier decisions about them
 * («quiero que también aparezca Nacho»): the author changed their mind.
 */
export function conversationPlan(messages: ConversationMessage[]): Plan {
  const plan: Plan = { decisions: [], discarded: [] };
  messages.forEach((m, i) => {
    if (m.role !== "author") return;
    for (const d of m.context?.discarded ?? []) {
      const who = names(d);
      if (who.length) plan.decisions = plan.decisions.filter((x) => !who.some((n) => x.text.includes(n)));
      plan.discarded.push({ text: d, message: i });
    }
    for (const d of m.context?.decisions ?? []) plan.decisions.push({ text: d, message: i });
  });
  return plan;
}

/** The plan as the model reads it: decided by the author, not written yet, not canon. */
export function planBlock(plan: Plan): string {
  if (!plan.decisions.length && !plan.discarded.length) return "";
  return [
    plan.decisions.length &&
      `Decisiones del autor en esta conversación (PLAN: lo ha decidido él; trabaja con ellas, no las discutas; aún no están escritas en el manuscrito ni son canon):\n${plan.decisions.map((d) => `- ${d.text}`).join("\n")}`,
    plan.discarded.length && `Descartado por el autor (no lo propongas ni lo incluyas):\n${plan.discarded.map((d) => `- ${d.text}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// The scene order (encargo) the Consejero hands to the Asistente
// ---------------------------------------------------------------------------

export type BriefTarget = "end" | "cursor";

export interface SceneBrief {
  /** The chosen proposal, as the plan of the scene: what happens. */
  argument: string;
  decisions: string[];
  constraints: string[];
  discarded: string[];
  characterIds: string[];
  placeId: string | null;
  target: BriefTarget;
  /** Where it came from, for the panel: «Propuesta B». */
  source: string;
}

export const BRIEF_LIMITS = { argument: 6000, item: 500, items: 20 };

const list = (x: unknown) =>
  (Array.isArray(x) ? x : [])
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, BRIEF_LIMITS.item))
    .filter(Boolean)
    .slice(0, BRIEF_LIMITS.items);

/**
 * A brief as the Asistente accepts it (the author may have edited it): lists of short
 * strings, ids that exist in this novel's Memoria, a known target. Throws on what can't be
 * a brief; trims what is too long.
 */
export function parseBrief(raw: unknown, known: { characters: string[]; places: string[] }): SceneBrief {
  if (!raw || typeof raw !== "object") throw new Error("El encargo no es válido.");
  const r = raw as Record<string, unknown>;
  const argument = typeof r.argument === "string" ? r.argument.trim() : "";
  if (!argument) throw new Error("El encargo necesita un argumento.");
  if (argument.length > BRIEF_LIMITS.argument) throw new Error("El argumento del encargo es demasiado largo.");
  return {
    argument,
    decisions: list(r.decisions),
    constraints: list(r.constraints),
    discarded: list(r.discarded),
    characterIds: list(r.characterIds).filter((id) => known.characters.includes(id)),
    placeId: typeof r.placeId === "string" && known.places.includes(r.placeId) ? r.placeId : null,
    target: r.target === "cursor" ? "cursor" : "end",
    source: typeof r.source === "string" ? r.source.slice(0, 80) : "",
  };
}

/** The brief inside the scene request: decisions and limits with the argument's authority. */
export function briefBlock(b: Pick<SceneBrief, "decisions" | "constraints" | "discarded">): string {
  const parts = [
    b.decisions.length && `Decisiones del autor (cúmplelas como el argumento):\n${b.decisions.map((d) => `- ${d}`).join("\n")}`,
    b.constraints.length && `Restricciones (no las rompas):\n${b.constraints.map((d) => `- ${d}`).join("\n")}`,
    b.discarded.length && `Descartado por el autor (no debe ocurrir ni aparecer):\n${b.discarded.map((d) => `- ${d}`).join("\n")}`,
  ].filter(Boolean);
  return parts.join("\n\n");
}
