import type { ObservationKind, ObservationStatus } from "../types";

/**
 * The Consejero's cards inside a conversation (docs/consejero.md, «Consejero creativo»,
 * phase 1). Pure functions, shared by the server and the panel, so both understand a
 * conversation the same way:
 *
 *   labels     every card gets a stable label in its conversation: A, B, C… in the order
 *              they were proposed, never reused. A card that develops another one is a
 *              version of it: B2, B3… (B itself is never touched).
 *   references "el segundo", "la B", "el último", "camino 2", or the "Seguir con esta"
 *              button resolve to one card, without AI. What can't be resolved is left to
 *              the model, who sees every card with its label.
 *   states     PROPUESTO, ELEGIDO PARA EXPLORAR, MODIFICADO, DESCARTADO: computed from
 *              what the author did, never from a summary. None of them is canon.
 *   focus      the proposal the conversation is developing, inherited by the next
 *              message unless it names another card, asks for something else, or the
 *              author lets it go.
 */

export interface CardRef {
  id: string;
  label: string;
  /** The label of the card this one is a version of (B2 → "B"). */
  from: string | null;
  kind: ObservationKind;
  title: string;
  body: string;
  status: ObservationStatus;
  /** Index of its message among the conversation's messages, and its place in it. */
  message: number;
  position: number;
}

export interface Anchor {
  id: string;
  label: string;
  title: string;
  /** How it was understood: a button, the words of the author, or inherited. */
  how: "boton" | "etiqueta" | "ordinal" | "ultimo" | "heredado" | "esa";
}

export interface ConversationMessage {
  role: "author" | "advisor";
  content: string;
  context: {
    anchor?: Anchor | null;
    cards?: { label: string; from: string | null }[];
    /** Author turn: the decisions and discards it carries (Conversar). */
    decisions?: string[];
    discarded?: string[];
  } | null;
  observations: { id: string; kind: ObservationKind; title: string; body: string; status: ObservationStatus; position?: number }[];
}

/** Kinds that are proposals (ideas), as opposed to findings about the text. */
export const PROPOSAL_KINDS: ObservationKind[] = ["alternative", "opportunity"];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A, …, Z, then AA, AB… */
function letter(n: number): string {
  return n < 26 ? LETTERS[n] : letter(Math.floor(n / 26) - 1) + LETTERS[n % 26];
}

const baseOf = (label: string) => label.replace(/\d+$/, "");

/**
 * Labels for the cards of a new answer. Versions (the alternatives of an answer about an
 * anchored card) take the anchor's letter and the next free number; the rest, the next
 * free letters.
 */
export function assignLabels(
  used: string[],
  kinds: ObservationKind[],
  anchor: { label: string } | null,
): { label: string; from: string | null }[] {
  const taken = new Set(used);
  let next = 0;
  for (const l of used) {
    const base = baseOf(l);
    if (/^[A-Z]+$/.test(base)) {
      let n = 0;
      for (const ch of base) n = n * 26 + (LETTERS.indexOf(ch) + 1);
      next = Math.max(next, n);
    }
  }
  const out: { label: string; from: string | null }[] = [];
  for (const kind of kinds) {
    if (anchor && kind === "alternative") {
      const base = baseOf(anchor.label);
      let v = 2;
      while (taken.has(`${base}${v}`)) v++;
      const label = `${base}${v}`;
      taken.add(label);
      out.push({ label, from: anchor.label });
    } else {
      let label = letter(next++);
      while (taken.has(label)) label = letter(next++);
      taken.add(label);
      out.push({ label, from: null });
    }
  }
  return out;
}

/** Every card of the conversation, labelled (older messages without stored labels get them now). */
export function conversationCards(messages: ConversationMessage[]): CardRef[] {
  const out: CardRef[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "advisor" || !m.observations.length) return;
    const obs = [...m.observations].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const stored = m.context?.cards;
    const labels =
      stored && stored.length === obs.length
        ? stored
        : assignLabels(
            out.map((c) => c.label),
            obs.map((o) => o.kind),
            null,
          );
    obs.forEach((o, k) =>
      out.push({ id: o.id, label: labels[k].label, from: labels[k].from, kind: o.kind, title: o.title, body: o.body, status: o.status, message: i, position: k }),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------
// References: "el segundo", "la B", "el último", "camino 2"
// ---------------------------------------------------------------------------

const ORDINALS: Record<string, number> = {
  primer: 1, primero: 1, primera: 1,
  segundo: 2, segunda: 2,
  tercer: 3, tercero: 3, tercera: 3,
  cuarto: 4, cuarta: 4,
  quinto: 5, quinta: 5,
  sexto: 6, sexta: 6,
};
/** Nouns that name a card: "el segundo camino". */
const CARD_NOUNS = /^(camino|caminos|opci[oó]n|opciones|propuesta|propuestas|alternativa|alternativas|idea|ideas|tarjeta|tarjetas|versi[oó]n|giro|giros|posibilidad|posibilidades|punto)$/i;
const PROPOSAL_NOUNS = /^(camino|opci[oó]n|propuesta|alternativa|idea|versi[oó]n|giro|posibilidad)/i;
/** Words that may follow "el segundo" when it names a card ("el segundo, pero…", "el segundo me gusta"). */
const AFTER = /^(me|te|le|nos|os|les|que|pero|y|e|o|u|con|sin|es|era|ser[ií]a|est[aá]|suena|parece|tiene|lo|la|los|las|de|del|mucho|m[aá]s|mejor|tambi[eé]n|por|para|aunque|porque|s[ií]|no|funciona|encaja|pues|entonces|ahora)$/i;

function nextWord(text: string, end: number): string | null {
  const m = text.slice(end).match(/^\s*([\p{L}]+)/u);
  if (!m) return null;
  // Punctuation before the next word ends the phrase: "el segundo, pero".
  return /^\s*[,.;:!?¿¡)»"]/.test(text.slice(end)) ? null : m[1];
}

/** The most recent answer with at least `n` cards (of the given kinds, if any). */
function recentWith(cards: CardRef[], n: number, kinds?: ObservationKind[]): CardRef[] | null {
  const byMessage = new Map<number, CardRef[]>();
  for (const c of cards) if (!kinds || kinds.includes(c.kind)) byMessage.set(c.message, [...(byMessage.get(c.message) ?? []), c]);
  const messages = [...byMessage.keys()].sort((a, b) => b - a);
  for (const m of messages) if (byMessage.get(m)!.length >= n) return byMessage.get(m)!;
  return null;
}

/**
 * The card the author's words point to, or null. Deterministic, without AI: explicit
 * labels ("la B", "camino B2", or just "B"), ordinals over the most recent answer that
 * has that many cards ("el segundo", "la tercera opción", "camino 2"), and "el último".
 */
export function resolveReference(text: string, cards: CardRef[]): { card: CardRef; how: Anchor["how"] } | null {
  if (!cards.length) return null;
  const labels = new Map(cards.map((c) => [c.label, c]));

  // Explicit labels: uppercase after an article ("la B", "lo de la C"), any case after a
  // noun ("camino b", "opción B2"), or the whole message ("B", "B2.").
  const bare = text.trim().match(/^([A-Za-z]{1,2}\d{0,2})[.!]?$/);
  if (bare && labels.has(bare[1].toUpperCase())) return { card: labels.get(bare[1].toUpperCase())!, how: "etiqueta" };
  for (const m of text.matchAll(/(?:^|[^\p{L}])(?:el|la|lo de la|lo del|de la|del)\s+([A-Z]{1,2}\d{0,2})(?![\p{L}\d])/gu)) {
    if (labels.has(m[1])) return { card: labels.get(m[1])!, how: "etiqueta" };
  }
  for (const m of text.matchAll(/(?:^|[^\p{L}])(?:camino|opci[oó]n|propuesta|alternativa|idea|tarjeta|versi[oó]n|giro)\s+([a-z]{1,2}\d{0,2})(?![\p{L}\d])/giu)) {
    const l = m[1].toUpperCase();
    if (labels.has(l)) return { card: labels.get(l)!, how: "etiqueta" };
  }

  // "camino 2", "opción 3": a position in the most recent answer.
  for (const m of text.matchAll(/(?:^|[^\p{L}])(camino|opci[oó]n|propuesta|alternativa|idea)\s+(?:n[uú]mero\s+)?(\d)(?!\d)/giu)) {
    const n = Number(m[2]);
    const list = recentWith(cards, n, ["alternative"]) ?? recentWith(cards, n);
    if (list && n >= 1) return { card: list[n - 1], how: "ordinal" };
  }

  // Ordinals and "el último", only when they name a card: followed by nothing, a card
  // noun, punctuation or a function word ("el segundo capítulo" is not a card).
  const re = /(?:^|[^\p{L}])(?:el|la|lo|del|de la|con el|con la|me quedo con el|me quedo con la)\s+(pen[uú]ltim[oa]|[uú]ltim[oa]|primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|quint[oa]|sext[oa])(?![\p{L}])/giu;
  for (const m of text.matchAll(re)) {
    const word = m[1].toLocaleLowerCase("es");
    const after = nextWord(text, m.index! + m[0].length);
    if (after && !CARD_NOUNS.test(after) && !AFTER.test(after)) continue;
    const kinds = after && PROPOSAL_NOUNS.test(after) ? (["alternative"] as ObservationKind[]) : undefined;
    if (/[uú]ltim/.test(word)) {
      const list = recentWith(cards, /pen/.test(word) ? 2 : 1, kinds) ?? recentWith(cards, 1);
      if (!list) continue;
      return { card: list[list.length - (/pen/.test(word) ? 2 : 1)], how: "ultimo" };
    }
    const n = ORDINALS[word];
    if (!n) continue;
    const list = recentWith(cards, n, kinds) ?? recentWith(cards, n);
    if (list) return { card: list[n - 1], how: "ordinal" };
  }
  return null;
}

/** "Descarta la C", "olvidemos el primero": the author discards a card by name (not "no descartes"). */
export function isDiscard(text: string): boolean {
  return /(?<!\bno\s)(?<!\bno\s(?:la|lo|las|los)\s)\b(descart[aeo]\p{L}*|olv[ií]d(a|ate|ese|emos|en)\p{L}*|no me (gusta|convence)n?)/iu.test(text);
}

/** "Otra cosa", "cambiemos de tema": the author leaves the proposal being developed. */
export function leavesFocus(text: string): boolean {
  return /otra cosa|cambi(o|emos|ar) de tema|empe(z|c)emos de nuevo|desde cero|nueva idea|algo distinto|olvida (eso|esto|todo)|dejemos (eso|esto)/i.test(text);
}

// ---------------------------------------------------------------------------
// States and focus
// ---------------------------------------------------------------------------

export type CardState = "PROPUESTO" | "ELEGIDO PARA EXPLORAR" | "MODIFICADO" | "DESCARTADO";

export interface CardWithState extends CardRef {
  state: CardState;
  /** Labels of its later versions (B → B2, B3). */
  versions: string[];
  /** The author chose it to explore (by name, by button, or inherited). */
  chosen: boolean;
}

/**
 * The state of each card, from what happened in the conversation: discarded by the
 * author (the card's status), developed into a version (MODIFICADO), chosen to explore
 * (an author message anchored to it), or only proposed. Saved cards stay ideas: saving
 * is not deciding, and none of these states is canon.
 */
export function cardStates(messages: ConversationMessage[]): CardWithState[] {
  const cards = conversationCards(messages);
  const chosen = new Set(messages.filter((m) => m.role === "author" && m.context?.anchor).map((m) => m.context!.anchor!.label));
  return cards.map((c) => {
    const versions = cards.filter((x) => x.from === c.label).map((x) => x.label);
    const state: CardState =
      c.status === "dismissed" ? "DESCARTADO" : versions.length ? "MODIFICADO" : chosen.has(c.label) ? "ELEGIDO PARA EXPLORAR" : "PROPUESTO";
    return { ...c, state, versions, chosen: chosen.has(c.label) };
  });
}

/**
 * The proposal the conversation is developing: the last anchor, followed through the
 * versions made of it (B → B2 → B3: the latest one). Null if the last author message had
 * no anchor, or the card ended up discarded.
 */
export function currentFocus(messages: ConversationMessage[]): CardRef | null {
  const lastAuthor = [...messages].reverse().find((m) => m.role === "author");
  const anchor = lastAuthor?.context?.anchor;
  if (!anchor) return null;
  const cards = conversationCards(messages);
  let card = cards.find((c) => c.label === anchor.label) ?? null;
  for (let guard = 0; card && guard < 50; guard++) {
    const next: CardRef | undefined = cards.filter((c) => c.from === card!.label && c.status !== "dismissed").at(-1);
    if (!next) break;
    card = next;
  }
  return card && card.status !== "dismissed" ? card : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The cards of the conversation for the model: label, state, title and body. Discarded
 * ones go with their title only, marked as not to be proposed again and not true. The
 * oldest ones are shortened so a long conversation stays within budget.
 */
export function cardsBlock(cards: CardWithState[], focus: CardRef | null, max = 40): string {
  if (!cards.length) return "";
  const kept = cards.slice(-max);
  const lines = kept.map((c, i) => {
    const recent = i >= kept.length - 12;
    const extra = c.state === "MODIFICADO" ? ` → ${c.versions.join(", ")}` : "";
    const chosen = c.chosen && c.state === "MODIFICADO" ? " (lo eligió el autor)" : "";
    const version = c.from ? ` · versión de ${c.from}` : "";
    const saved = c.status === "saved" ? " · guardada por el autor como idea" : "";
    if (c.state === "DESCARTADO")
      return `- ${c.label} · DESCARTADO por el autor — «${c.title}». No la propongas de nuevo salvo que el autor la recupere; no es verdad en la novela.`;
    return `- ${c.label}${version} · ${c.state}${extra}${chosen}${saved} — «${c.title}»${recent ? `: ${clip(c.body, 700)}` : ""}`;
  });
  return [
    `Propuestas y observaciones de esta conversación (${cards.length > max ? `las últimas ${max} de ${cards.length}` : cards.length}). Ninguna es un hecho de la novela: ni las propuestas, ni las elegidas, ni las modificadas. Sólo el manuscrito, la Memoria y los hechos aprobados dicen lo que ocurre.`,
    ...lines,
    focus ? `\nEn desarrollo ahora: ${focus.label} («${focus.title}»).` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
