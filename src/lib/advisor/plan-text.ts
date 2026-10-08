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

export function paragraphs(text: string): PlanParagraph[] {
  return text
    .split(/\n\s*\n|\n(?=#)|\n(?=[-*•] )/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => ({ i, text: t, heading: /^#{1,6}\s/.test(t) || (t.length < 80 && /:$/.test(t)) }));
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
  const scored = ps
    .map((p) => {
      const lower = p.text.toLocaleLowerCase("es");
      const names = opts.matchers.filter((m) => m.test(p.text)).length;
      const words = opts.words.filter((w) => lower.includes(w)).length;
      return { p, score: names * 3 + words };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.i - b.p.i);
  const picked: PlanParagraph[] = [];
  let left = opts.budget;
  for (const { p } of scored) {
    const t = clip(p.text, Math.min(2500, opts.budget));
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

const STOP = /^(que|para|como|pero|porque|cuando|donde|esta|este|esto|todo|toda|sobre|entre|desde|hasta|tiene|tengo|puede|quiero|quiere|seguir|continuar|novela|escena|capitulo|capítulo|ahora|despues|después|propuesta)$/i;

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
