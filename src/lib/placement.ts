/**
 * Where a scene of the Asistente goes (docs/asistente-contexto.md §11).
 *
 *   - "end" (the default): the real end of the chapter at the moment of inserting, whatever
 *     the cursor. The scene becomes its own paragraph after the last content.
 *   - "cursor": a position fixed when the author chose it, anchored to the text around it
 *     (not to a number, which typing elsewhere would shift). Moving the cursor afterwards
 *     never changes it; if the text around it changed so that it can't be found, nothing is
 *     inserted.
 */

export type SceneTarget = "end" | "cursor";

/** A fixed position, remembered by the text right before and after it. */
export interface Anchor {
  at: number;
  before: string;
  after: string;
}

export type InsertTarget = { kind: "end" } | { kind: "at"; anchor: Anchor };

const ANCHOR_CHARS = 120;

export function anchorAt(content: string, at: number): Anchor {
  const p = Math.min(Math.max(0, at), content.length);
  return { at: p, before: content.slice(Math.max(0, p - ANCHOR_CHARS), p), after: content.slice(p, p + ANCHOR_CHARS) };
}

/**
 * The anchored position in the text as it is now: where it was if the text around it is
 * the same, else the occurrence of that text nearest to where it was; null if it is gone.
 */
export function resolveAnchor(content: string, a: Anchor): number | null {
  const fits = (p: number) =>
    p >= a.before.length &&
    p <= content.length &&
    content.slice(p - a.before.length, p) === a.before &&
    content.slice(p, p + a.after.length) === a.after;
  if (fits(a.at)) return a.at;
  // The chapter's very start or end, with the text on the other side unchanged.
  if (!a.before && content.startsWith(a.after)) return 0;
  if (!a.after && a.before && content.endsWith(a.before)) return content.length;
  const key = a.before + a.after;
  if (!key) return content.trim() ? null : 0;
  let best: number | null = null;
  for (let i = content.indexOf(key); i !== -1; i = content.indexOf(key, i + 1)) {
    const p = i + a.before.length;
    if (best === null || Math.abs(p - a.at) < Math.abs(best - a.at)) best = p;
  }
  return best;
}

/**
 * Inserting at the end: what to replace so the scene is its own paragraph after the last
 * content. Trailing blank space is replaced by exactly one blank line; a last paragraph, an
 * image or a separator is never touched, and the scene never sticks to the last character.
 */
export function placeAtEnd(content: string, scene: string): { start: number; end: number; text: string } {
  const last = content.replace(/\s+$/u, "").length;
  const body = scene.trim();
  return { start: last, end: content.length, text: last > 0 ? `\n\n${body}` : body };
}
