import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { assertId, db, getNovel, getOutline } from "@/lib/supabase";
import { readJson } from "@/lib/http";
import { imageIds } from "@/lib/manuscript";
import type { TrashEntry } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** The deleted chapters of the novel (what was deleted more than 30 days ago is emptied first). */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  const { data, error } = await db().rpc("chapter_trash", { p_novel: novel.id });
  if (error) throw error;
  return NextResponse.json(data as TrashEntry[], { headers: { "Cache-Control": "no-store" } });
});

/** Brings a deleted chapter back, at the end, with its history and its images. */
export const POST = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const { data: id, error } = await db().rpc("restore_chapter", {
    p_novel: novel.id,
    p_source: assertId(String(body.sourceId ?? ""), "Capítulo"),
  });
  if (error) throw error;
  // Its images that are still in the novel (not placed since it was deleted) go back to it.
  const { data: chapter, error: readError } = await db().from("chapters").select("content").eq("id", id).single();
  if (readError) throw readError;
  const { error: syncError } = await db().rpc("sync_chapter_images", {
    p_chapter: id,
    p_ids: [...new Set(imageIds(chapter.content))],
  });
  if (syncError) throw syncError;
  return NextResponse.json({ id, chapters: await getOutline(novel.id) }, { status: 201 });
});
