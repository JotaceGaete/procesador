import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { db, getNovel, getOutline } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/** New chapter at the end. */
export const POST = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const outline = await getOutline(novel.id);
  const position = Math.max(0, ...outline.map((c) => c.position)) + 1;
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 300) : `Capítulo ${outline.length + 1}`;
  const { data, error } = await db().from("chapters").insert({ novel_id: novel.id, title, position }).select("id").single();
  if (error) throw error;
  return NextResponse.json({ id: data.id, chapters: await getOutline(novel.id) }, { status: 201 });
});

/** New order: the complete list of chapter ids. Positions change, revisions don't. */
export const PUT = novelHandler<Ctx>(byParam(), async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const { ids } = await readJson(request);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "Orden inválido");
  const { error } = await db().rpc("reorder_chapters", { p_novel: novel.id, p_ids: ids });
  if (error) throw error;
  return NextResponse.json(await getOutline(novel.id));
});
