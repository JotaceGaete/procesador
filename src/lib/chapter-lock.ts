/**
 * Bloqueo de capítulos (docs/bloqueo-capitulos.md), the part shared by the browser and the server:
 * the messages, and the check that runs right before anything of the Asistente reaches the
 * manuscript. A proposal belongs to the chapter it was written for; it never lands in another one.
 */

export const LOCKED_MESSAGE = "Este capítulo está bloqueado. Desbloquéalo para modificarlo.";

export type ApplyAction = "insert" | "replace";

export type TargetCheck =
  | { ok: true }
  | { ok: false; reason: "other-chapter" | "locked" | "no-editor"; message: string };

const STOPPED: Record<ApplyAction, string> = {
  insert: "La inserción se ha detenido para evitar modificar el capítulo equivocado.",
  replace: "El reemplazo se ha detenido para evitar modificar el capítulo equivocado.",
};

/** «Esta propuesta fue preparada para «Capítulo 8», pero ahora estás en «Capítulo 9»…» */
export function wrongChapterMessage(from: string | null, current: string, action: ApplyAction) {
  const origin = from ? `«${from}»` : "un capítulo que ya no existe";
  return `Esta propuesta fue preparada para ${origin}, pero ahora estás en «${current}». ${STOPPED[action]}`;
}

export function lockedChapterMessage(label: string, action: ApplyAction) {
  return `«${label}» está bloqueado (revisado). Desbloquéalo si quieres ${action === "insert" ? "insertar" : "reemplazar"} en él.`;
}

/**
 * Whether a proposal may be applied now. Compares identifiers, not what the screen shows: the
 * chapter the proposal was written for, the chapter open now, and the chapter of the editor that
 * would receive the text (the three must be the same), and the lock of that chapter.
 */
export function checkTarget(args: {
  proposalChapterId: string;
  openChapterId: string | null;
  editorChapterId: string | null;
  locked: boolean;
  action: ApplyAction;
  /** The chapter's name as the author sees it, or null if it no longer exists. */
  label(id: string): string | null;
}): TargetCheck {
  const { proposalChapterId, openChapterId, editorChapterId, locked, action, label } = args;
  if (!openChapterId || !editorChapterId)
    return { ok: false, reason: "no-editor", message: "El capítulo todavía no está abierto. No se ha aplicado nada." };
  if (proposalChapterId !== openChapterId || editorChapterId !== openChapterId) {
    return {
      ok: false,
      reason: "other-chapter",
      message: wrongChapterMessage(label(proposalChapterId), label(openChapterId) ?? "otro capítulo", action),
    };
  }
  if (locked) return { ok: false, reason: "locked", message: lockedChapterMessage(label(openChapterId) ?? "Este capítulo", action) };
  return { ok: true };
}
