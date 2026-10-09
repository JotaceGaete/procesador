import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getNovel, getOutline } from "@/lib/supabase";
import { HttpError, readJson, groupPosition as position } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * New chapter, in the manuscript or in the reserve (docs/capitulos-reserva.md), at position
 * `at` of its group (1 = first; none = at the end). Its title is the author's only: the
 * number is its place in the manuscript and is never stored.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 300) : "";
  const { data: id, error } = await db().rpc("create_chapter", {
    p_novel: novel.id,
    p_title: title,
    p_reserved: body.reserved === true,
    p_at: position(body.at),
  });
  if (error) throw error;
  return NextResponse.json({ id, chapters: await getOutline(novel.id) }, { status: 201 });
});

/** New order of the manuscript: the complete list of its chapter ids. Positions change, revisions don't. */
export const PUT = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const { ids } = await readJson(request);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "Orden inválido");
  const { error } = await db().rpc("reorder_chapters", { p_novel: novel.id, p_ids: ids });
  if (error) throw error;
  return NextResponse.json(await getOutline(novel.id));
});
