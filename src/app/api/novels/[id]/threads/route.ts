import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { db, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { cleanThreadPatch } from "@/lib/advisor/threads";
import { threadRows } from "@/lib/advisor/reading";

type Ctx = { params: Promise<{ id: string }> };

/** A thread the author adds by hand: confirmed from the start. */
export const POST = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const patch = cleanThreadPatch(await readJson(request));
  if (!patch.title) throw new HttpError(400, "El cabo necesita un título.");
  const { data, error } = await db()
    .from("story_threads")
    .insert({ ...patch, novel_id: novel.id, origin: "author", confirmed: true })
    .select("*")
    .single();
  if (error) throw error;
  return NextResponse.json(data, { status: 201 });
});

/** The novel's threads (for the observations' thread actions). */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  return NextResponse.json(await threadRows(novel.id), { headers: { "Cache-Control": "no-store" } });
});
