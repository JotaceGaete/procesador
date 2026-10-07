import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { checkSecret } from "@/lib/protection";
import { assertId, db, getMemory, getNovel, getOutline } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { cleanGuide } from "@/lib/guide";
import { cleanBook } from "@/lib/book";
import { availableProviders, defaultProvider } from "@/lib/ai/providers";
import { confirmTokens } from "@/lib/ai/models";
import { getManuscriptImages, getNovelImages, novelFiles, removeFiles } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string }> };

/** Everything needed to open a novel, except chapter texts (loaded one at a time). */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  let chapters = await getOutline(novel.id);
  if (!chapters.length) {
    // A novel always has at least one chapter.
    const { error } = await db().from("chapters").insert({ novel_id: novel.id, title: "Capítulo 1", position: 1 });
    if (error) throw error;
    chapters = await getOutline(novel.id);
  }
  // Images are kept apart from `memory`, which is what the assistant's context is built from.
  const [memory, images, manuscriptImages] = await Promise.all([
    getMemory(novel.id),
    getNovelImages(novel.id),
    getManuscriptImages(novel.id),
  ]);
  return NextResponse.json(
    {
      novel,
      chapters,
      memory,
      images,
      manuscriptImages,
      providers: availableProviders(),
      defaultProvider: defaultProvider(),
      confirmTokens: confirmTokens(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

/** Title, synopsis, notes, Guía Maestra, the Consejero's automatic reading switch and the book's data. */
export const PATCH = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const id = assertId((await params).id, "Novela");
  const body = await readJson(request);
  const update: Record<string, unknown> = {};
  if (typeof body.title === "string") {
    if (!body.title.trim()) throw new HttpError(400, "La novela necesita un título.");
    update.title = body.title.trim().slice(0, 300);
  }
  if (typeof body.synopsis === "string") update.synopsis = body.synopsis.slice(0, 20_000);
  if (typeof body.notes === "string") update.notes = body.notes.slice(0, 20_000);
  if ("guide" in body) update.guide = cleanGuide(body.guide);
  if (typeof body.auto_digest === "boolean") update.auto_digest = body.auto_digest;
  if ("book" in body) update.book = cleanBook(body.book);
  if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");

  const { data, error } = await db()
    .from("novels")
    .update(update)
    .eq("id", id)
    .select("id, title, synopsis, notes, guide, auto_digest, calendar, dismissed_warnings, book, updated_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Novela no encontrada");
  return NextResponse.json({ ...data, book: cleanBook(data.book) });
});

/**
 * Deletes the novel with its chapters, memory and files (cascade), then the files in Storage.
 * The UI asks for explicit confirmation; a protected novel, also for its PIN ({ secret }).
 */
export const DELETE = novelHandler<Ctx>(byParam(), async (request, { params }, access) => {
  const id = assertId((await params).id, "Novela");
  if (access.protected) await checkSecret(id, (await readJson(request).catch(() => ({}) as Record<string, unknown>)).secret);
  const files = await novelFiles(id);
  const { error } = await db().from("novels").delete().eq("id", id);
  if (error) throw error;
  await removeFiles(files);
  return new NextResponse(null, { status: 204 });
});
