import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db, getChapter } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { imageIds } from "@/lib/manuscript";

type Ctx = { params: Promise<{ id: string }> };

export const GET = novelHandler<Ctx>(byChild("chapters"), async (_request, { params }) => {
  return NextResponse.json(await getChapter((await params).id), { headers: { "Cache-Control": "no-store" } });
});

/**
 * Saves the text or the title. Text saves carry the revision the client last
 * saw: if the chapter changed elsewhere (another tab or device), nothing is
 * written and the response is 409, so newer text is never silently overwritten.
 * Each chapter has its own revision, so editing chapter 2 never conflicts with chapter 5.
 */
export const PATCH = novelHandler<Ctx>(byChild("chapters"), async (request, { params }) => {
  const id = assertId((await params).id, "Capítulo");
  const body = await readJson(request);

  const update: Record<string, string> = {};
  if (typeof body.title === "string") update.title = body.title.trim().slice(0, 300);
  if (typeof body.content === "string") update.content = body.content;
  if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");

  let query = db().from("chapters").update(update).eq("id", id);
  if ("content" in update) {
    if (typeof body.revision !== "number") throw new HttpError(400, "Falta la revisión");
    query = query.eq("revision", body.revision);
  }
  const { data, error } = await query.select("revision, updated_at").maybeSingle();
  if (error) throw error;
  if (!data) {
    await getChapter(id); // 404 if it was deleted
    return NextResponse.json({ error: "Este capítulo se modificó en otra pestaña o dispositivo." }, { status: 409 });
  }
  if ("content" in update) {
    // Images whose markers are in the text are now in this chapter; the ones that left it
    // stay "not placed" (never deleted). The text itself is the source of truth.
    const { error: syncError } = await db().rpc("sync_chapter_images", {
      p_chapter: id,
      p_ids: [...new Set(imageIds(update.content))],
    });
    if (syncError) throw syncError;
  }
  return NextResponse.json(data);
});

/** To the trash (docs/versiones.md): its text and history stay recoverable for 30 days. */
export const DELETE = novelHandler<Ctx>(byChild("chapters"), async (_request, { params }) => {
  const chapter = await getChapter((await params).id);
  const { error } = await db().rpc("trash_chapter", { p_chapter: chapter.id });
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
