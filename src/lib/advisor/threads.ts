import "server-only";
import { assertId, db } from "../supabase";
import { HttpError } from "../http";
import { THREAD_KINDS, THREAD_STATUS_LABELS, type StoryThread } from "../types";
import { recomputeThreads, rewriteThreadRefs } from "./reading";

/** The author's hand on the threads: confirm, rename, merge, close, delete, add. */

export async function getThread(id: string): Promise<StoryThread> {
  const { data, error } = await db().from("story_threads").select("*").eq("id", assertId(id, "Cabo")).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Cabo no encontrado");
  return data as StoryThread;
}

export function cleanThreadPatch(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") {
    if (!body.title.trim()) throw new HttpError(400, "El cabo necesita un título.");
    patch.title = body.title.trim().slice(0, 200);
  }
  if (typeof body.description === "string") patch.description = body.description.trim().slice(0, 2000);
  if (typeof body.kind === "string") {
    if (!THREAD_KINDS.some((k) => k.id === body.kind)) throw new HttpError(400, "Tipo de cabo desconocido.");
    patch.kind = body.kind;
  }
  if (typeof body.status === "string") {
    if (!(body.status in THREAD_STATUS_LABELS)) throw new HttpError(400, "Estado de cabo desconocido.");
    patch.status = body.status;
    // The author decided: re-reading chapters no longer changes it.
    patch.status_by = "author";
  }
  if (body.status === null) patch.status_by = "advisor"; // back to what the reading says
  if (typeof body.confirmed === "boolean") patch.confirmed = body.confirmed;
  return patch;
}

export async function updateThread(id: string, body: Record<string, unknown>) {
  const thread = await getThread(id);
  const patch = cleanThreadPatch(body);
  if (!Object.keys(patch).length) throw new HttpError(400, "Nada que guardar");
  // Renaming or editing a possible thread is confirming it.
  if (patch.title || patch.description || patch.kind) patch.confirmed = patch.confirmed ?? true;
  const { error } = await db().from("story_threads").update(patch).eq("id", thread.id);
  if (error) throw error;
  await recomputeThreads(thread.novel_id);
  return getThread(thread.id);
}

export async function deleteThread(id: string) {
  const thread = await getThread(id);
  await rewriteThreadRefs(thread.novel_id, thread.id, null);
  const { error } = await db().from("story_threads").delete().eq("id", thread.id);
  if (error) throw error;
}

/** `from` disappears into `into`: its references in the digests now point to `into`. */
export async function mergeThreads(from: string, into: string) {
  const a = await getThread(from);
  const b = await getThread(into);
  if (a.novel_id !== b.novel_id) throw new HttpError(404, "Cabo no encontrado");
  if (a.id === b.id) throw new HttpError(400, "Elige otro cabo.");
  await rewriteThreadRefs(a.novel_id, a.id, b.id);
  const { error } = await db().from("story_threads").delete().eq("id", a.id);
  if (error) throw error;
  if (!b.confirmed) {
    const { error: e } = await db().from("story_threads").update({ confirmed: true }).eq("id", b.id);
    if (e) throw e;
  }
  await recomputeThreads(a.novel_id);
  return getThread(b.id);
}
