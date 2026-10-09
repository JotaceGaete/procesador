import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getChapter, getOutline } from "@/lib/supabase";
import { groupPosition, readJson } from "@/lib/http";
import { recomputeThreads } from "@/lib/advisor/reading";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Moves a chapter (docs/capitulos-reserva.md): inside its group (the arrows, drag and drop)
 * or to the other one (to the reserve, into the manuscript at a position). One transaction
 * with the novel locked: text, images, notes and versions stay as they are. Changing group
 * invalidates the Consejero's reading that came from it, so a chapter sent to the reserve
 * stops reaching the AI at once. Answers with the new outline.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const chapter = await getChapter((await params).id);
  const body = await readJson(request);
  const reserved = typeof body.reserved === "boolean" ? body.reserved : chapter.reserved;
  const { error } = await db().rpc("move_chapter", { p_chapter: chapter.id, p_reserved: reserved, p_at: groupPosition(body.at) });
  if (error) throw error;
  // Where each thread opens and closes, over the manuscript as it is now.
  if (reserved !== chapter.reserved) await recomputeThreads(chapter.novel_id);
  return NextResponse.json(await getOutline(chapter.novel_id));
});
