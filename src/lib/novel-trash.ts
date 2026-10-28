/** Días que una novela eliminada espera en la papelera antes de borrarse de verdad (docs/papelera-novelas.md). */
export const NOVEL_TRASH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Las novelas eliminadas antes de este instante ya cumplieron el plazo y se borran. */
export function trashCutoff(now: number = Date.now()): string {
  return new Date(now - NOVEL_TRASH_DAYS * DAY_MS).toISOString();
}

/** El día en que se borra una novela eliminada en `deletedAt`. */
export function purgeDate(deletedAt: string): Date {
  return new Date(new Date(deletedAt).getTime() + NOVEL_TRASH_DAYS * DAY_MS);
}
