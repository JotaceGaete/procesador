/**
 * The author's plan (the synopsis and notes now; the Argumento general later) for the
 * Consejero, without sending all of it every time and without an AI call to summarise it.
 * Two parts, both computed from the text:
 *
 *   overview  the global view, the same in every turn (so the provider can cache it): the
 *             whole plan if it is short; otherwise its first paragraph (the premise), its
 *             headings, the first sentence of every other paragraph and its last paragraph
 *             (usually the ending), within a budget.
 *   details   the complete paragraphs that matter for this turn: those that name the people
 *             and places involved, or share the question's words; never one already whole in
 *             the overview.
 */

export interface PlanParagraph {
  i: number;
  text: string;
  heading: boolean;
}

/** Longest unit of the plan: a longer paragraph is cut in pieces of whole sentences. */
const UNIT_CHARS = 1200;

/**
 * The plan's units: its lines (a line break is a paragraph, as most authors write in a text
 * box, whether or not they leave a blank line), and a very long one in pieces of whole sentences.
 * A text with no line breaks at all is still searchable throughout.
 */
export function paragraphs(text: string): PlanParagraph[] {
  const out: string[] = [];
  for (const line of text.split(/\n/).map((t) => t.trim()).filter(Boolean)) {
    if (line.length <= UNIT_CHARS) {
      out.push(line);
      continue;
    }
    let piece = "";
    for (const s of line.split(/(?<=[.!?…])\s+/)) {
      if (piece && piece.length + s.length + 1 > UNIT_CHARS) {
        out.push(piece);
        piece = "";
      }
      piece = piece ? `${piece} ${s}` : s;
    }
    if (piece) out.push(piece);
  }
  return out.map((t, i) => ({ i, text: t, heading: /^#{1,6}\s/.test(t) || (t.length < 80 && /:$/.test(t)) }));
}

const firstSentence = (t: string, max: number) => {
  const s = t.split(/(?<=[.!?…])\s/)[0];
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** The global view, stable across turns. `whole` says whether nothing was left out. */
export function planOverview(text: string, budget: number): { text: string; whole: boolean; full: Set<number> } {
  const t = text.trim();
  if (!t) return { text: "", whole: true, full: new Set() };
  const ps = paragraphs(t);
  if (t.length <= budget) return { text: t, whole: true, full: new Set(ps.map((p) => p.i)) };
  const first = ps[0];
  const last = ps.length > 1 ? ps[ps.length - 1] : null;
  const head = clip(first.text, Math.floor(budget * 0.3));
  const tail = last ? clip(last.text, Math.floor(budget * 0.2)) : "";
  const middle = ps.slice(1, last ? -1 : undefined);
  // Headings whole, other paragraphs by their first sentence; if it still doesn't fit, every
  // other one is dropped from the middle, keeping the order (and saying so).
  let lines = middle.map((p) => (p.heading ? p.text : `${firstSentence(p.text, 220)} […]`));
  const room = budget - head.length - tail.length - 40;
  let step = 1;
  while (lines.join("\n").length > room && step < 64) {
    step *= 2;
    lines = middle.filter((p, k) => p.heading || k % step === 0).map((p) => (p.heading ? p.text : `${firstSentence(p.text, 220)} […]`));
  }
  const full = new Set([first.i, ...(last && tail === last.text ? [last.i] : [])]);
  return { text: [head, ...lines, last ? `${tail}` : ""].filter(Boolean).join("\n\n"), whole: false, full };
}

/** The complete paragraphs that matter for this turn, best first, within a budget, in order. */
export function planDetails(
  text: string,
  opts: { matchers: RegExp[]; words: string[]; budget: number; skip: Set<number>; current?: number },
): string {
  const ps = paragraphs(text.trim()).filter((p) => !opts.skip.has(p.i) && !p.heading);
  const lowers = ps.map((p) => p.text.toLocaleLowerCase("es"));
  // A word that is everywhere tells nothing: only words in at most a fifth of the plan count.
  const words = opts.words.filter((w) => lowers.filter((l) => l.includes(w)).length <= Math.max(2, ps.length / 5));
  const scored = ps
    .map((p, k) => {
      const names = opts.matchers.filter((m) => m.test(p.text)).length;
      const hits = words.filter((w) => lowers[k].includes(w)).length;
      return { p, score: names * 3 + hits };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.i - b.p.i);
  const picked: PlanParagraph[] = [];
  let left = opts.budget;
  for (const { p } of scored) {
    const t = p.text.length > Math.min(2500, opts.budget) ? around(p.text, opts.matchers, words, Math.min(2500, opts.budget)) : p.text;
    if (t.length > left) continue;
    left -= t.length + 2;
    picked.push({ ...p, text: t });
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((p) => {
      const tag = opts.current ? chapterTag(p.text, opts.current) : "";
      return tag ? `${tag} ${p.text}` : p.text;
    })
    .join("\n\n");
}

/** In a long unit, the sentences that match (and the next one), not just its beginning. */
function around(text: string, matchers: RegExp[], words: string[], max: number): string {
  const ss = text.split(/(?<=[.!?…])\s+/);
  const hit = (s: string) => matchers.some((m) => m.test(s)) || words.some((w) => s.toLocaleLowerCase("es").includes(w));
  const keep = new Set<number>();
  ss.forEach((s, i) => {
    if (hit(s)) [i, i + 1].forEach((j) => j < ss.length && keep.add(j));
  });
  let out = "";
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const add = `${prev >= 0 && i !== prev + 1 ? " […] " : out ? " " : ""}${ss[i]}`;
    if (out.length + add.length > max) break;
    out += add;
    prev = i;
  }
  return out || clip(text, max);
}

const STOP = /^(quién|quien|quiénes|quienes|cuál|cuáles|cuándo|cuando|dónde|donde|cómo|cuánto|cuánta|porqué|sería|podría|debería|pasaría|explica|explícame|dime|cuéntame|sabes|que|para|como|pero|porque|cuando|donde|esta|este|esto|todo|toda|sobre|entre|desde|hasta|tiene|tengo|puede|quiero|quiere|seguir|continuar|novela|escena|capitulo|capítulo|ahora|despues|después|propuesta)$/i;

/** The content words of a question (five letters or more), for `planDetails`. */
export function questionWords(question: string): string[] {
  return [...new Set(question.toLocaleLowerCase("es").match(/[\p{L}]{5,}/gu) ?? [])].filter((w) => !STOP.test(w));
}

/**
 * Where a paragraph of the plan sits relative to the open chapter, when it says so («en el
 * capítulo 12», «cap. 3–5»): a tag before it, so the Consejero tells what is still to come
 * from what should already be written. Untagged when the paragraph names no chapter.
 */
export function chapterTag(text: string, current: number): string {
  const nums = [...text.matchAll(/\bcap(?:[íi]tulos?|s?\.)\s*(\d{1,4})(?:\s*(?:[-–]|a|al|y)\s*(\d{1,4}))?/giu)].flatMap((m) =>
    [m[1], m[2]].filter(Boolean).map(Number),
  );
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const where = min === max ? `el cap. ${min}` : `los caps. ${min}–${max}`;
  if (min > current) return `[Previsto para ${where} · aún no escrito: no ha ocurrido]`;
  if (max <= current) return `[Previsto para ${where} · ya escrito: manda el manuscrito; compruébalo]`;
  return `[Previsto para ${where} · el abierto es el ${current}: lo posterior no ha ocurrido]`;
}

/** Capitalised words that are not people: weekdays, months, forms of address, places of worship… */
const NOT_NAMES = new Set(
  [
    "dios", "señor", "señora", "don", "doña", "virgen", "navidad", "lunes", "martes", "miércoles", "jueves", "viernes",
    "sábado", "domingo", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
    "octubre", "noviembre", "diciembre", "capítulo", "parte", "acto", "libro", "prólogo", "epílogo", "desenlace",
    "premisa", "final", "primera", "segunda", "tercera", "cuarta", "quinta", "norte", "sur", "este", "oeste",
  ],
);
const lowerEs = (s: string) => s.toLocaleLowerCase("es");
/** Words that open sentences and are never names, even when the plan never writes them in lowercase. */
const OPENERS =
  /^(el|la|los|las|una|uno|unos|unas|cuando|después|luego|mientras|entonces|pero|aunque|sin|con|tras|ante|durante|ese|esa|esos|esas|este|esta|estos|estas|aquel|aquella|allí|ahí|así|nadie|todos|todas|todo|nada|algo|alguien|cada|más|menos|hasta|desde|por|para|ella|ellos|ellas|nunca|siempre|ahora|hoy|ayer|mañana|finalmente|también|tampoco|además|sus|del|qué|quién|cómo|dónde|cuándo|porque|pues|según|otro|otra|otros|otras|muchos|muchas|poco|pocos|años|años|tiempo|parte|tramo)$/i;

/** The names the author asks about («¿Quién es Gerardo?»), as matchers: capitalised words that are not sentence openers. */
export function questionNames(question: string): RegExp[] {
  const out = new Set<string>();
  for (const m of question.matchAll(/[\p{Lu}][\p{Ll}]{2,}/gu)) {
    const w = m[0];
    if (NOT_NAMES.has(lowerEs(w)) || STOP.test(w) || /^(qu[eé]|c[oó]mo|por|para|el|la|los|las|un|una|y|si|me|te|es|hay|dame|dime|necesito|quiero|vamos|ahora|entonces|bien|vale|perfecto|gracias|hola|también|pero|cuéntame|explícame|analiza|revisa)$/i.test(w))
      continue;
    out.add(w);
  }
  return [...out].map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "u"));
}

/**
 * The people the plan names that the Memoria does not have yet, each with the first sentence
 * that presents them: so a secondary character of the plan (one who has not appeared in the
 * manuscript) is never unknown to the Consejero. Deterministic and stable across turns.
 * A name is a capitalised word that never appears in lowercase in the plan (so «Cuando» or
 * «Pero» at the start of a sentence are not names) and is not a common opener.
 */
export function planCast(text: string, known: string[], budget: number, shown = ""): string {
  const knownSet = new Set(known.flatMap((n) => n.split(/\s+/)).map(lowerEs));
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const lowercase = new Set(text.match(/(?<![\p{L}])[\p{Ll}][\p{Ll}]{2,}/gu) ?? []);
  const names = new Map<string, number>();
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])[\p{Lu}][\p{Ll}]{2,}(?![\p{L}\p{N}])/gu)) {
    const w = m[0];
    const l = lowerEs(w);
    if (NOT_NAMES.has(l) || OPENERS.test(w) || knownSet.has(l) || lowercase.has(l)) continue;
    names.set(w, (names.get(w) ?? 0) + 1);
  }
  const lines: string[] = [];
  let left = budget;
  for (const [name] of [...names].sort((a, b) => b[1] - a[1])) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, "u");
    const all = sentences.filter((s) => re.test(s));
    if (!all.length) continue;
    // A sentence the overview does not already carry; if it carries them all, just the name.
    const first = all.find((s) => !shown.includes(s));
    const line = first ? `- ${name}: «${first.length > 220 ? `${first.slice(0, 220)}…` : first}»` : `- ${name} (en la visión general)`;
    if (line.length + 1 > left) break;
    left -= line.length + 1;
    lines.push(line);
  }
  return lines.join("\n");
}
