/**
 * Relaciones personalizadas (docs/relaciones.md): the kind of a relationship is free text in
 * `relationships.kind`. The app offers the common ones, the ones already used in the novel, and
 * lets the author create any other. Pure, shared by the form and the API.
 *
 * Two forms that differ only in case, spacing or accents («desconfia de», «Desconfía  de») are
 * the same kind: the one already used in the novel is reused, so the novel never ends up with
 * trivial duplicates. The comparison key is never shown or stored; the text the author sees is
 * always a form somebody wrote.
 */

/** The common kinds, offered first. Any other is the author's own. */
export const COMMON_RELATIONS = [
  "hermano de",
  "hermana de",
  "padre de",
  "madre de",
  "hijo de",
  "hija de",
  "pareja de",
  "amante de",
  "ex pareja de",
  "amigo de",
  "enemigo de",
  "desconfía de",
  "le debe a",
  "trabaja para",
  "le teme a",
  "está enamorado de",
] as const;

/**
 * How a kind is written down: no spaces at the ends, one space between words. Nothing else is
 * touched (case, accents and words stay as the author typed them).
 */
export const tidyRelation = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The comparison key: case, spacing and accents do not count. «ñ» is a letter, not an accent,
 * so «año» and «ano» stay different.
 */
export function relationKey(s: string): string {
  return tidyRelation(s)
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/(?<![nN])̃|[̀-̂̄-ͯ]/g, "")
    .normalize("NFC");
}

/**
 * The kinds the novel already uses that are not common ones, once each (the first form used
 * wins), in alphabetical order. `except`: a relationship being edited, which does not count.
 */
export function usedRelations(relationships: { id?: string; kind: string }[], except?: string | null): string[] {
  const common = new Set(COMMON_RELATIONS.map(relationKey));
  const seen = new Map<string, string>();
  for (const r of relationships) {
    if (except && r.id === except) continue;
    const kind = tidyRelation(r.kind);
    const key = relationKey(kind);
    if (!kind || common.has(key) || seen.has(key)) continue;
    seen.set(key, kind);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

/**
 * The kind to store for what the author typed: the form already used in the novel if there is
 * one, else the common one, else what was typed (tidied). `reused` is set when that form differs
 * from what was typed, so the form can say so.
 */
export function resolveRelation(
  typed: string,
  relationships: { id?: string; kind: string }[],
  except?: string | null,
): { kind: string; reused: string | null } {
  const kind = tidyRelation(typed);
  const key = relationKey(kind);
  if (!key) return { kind, reused: null };
  const inNovel = relationships.find((r) => (!except || r.id !== except) && relationKey(r.kind) === key);
  const existing = inNovel ? tidyRelation(inNovel.kind) : COMMON_RELATIONS.find((c) => relationKey(c) === key);
  if (!existing) return { kind, reused: null };
  return { kind: existing, reused: existing === kind ? null : existing };
}
