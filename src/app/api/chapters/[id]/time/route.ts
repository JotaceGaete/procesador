import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { db, getChapter } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { parseWhen } from "@/lib/chronology";

type Ctx = { params: Promise<{ id: string }> };

const START = { at: "chapter_start" };

/** The story's time at the start of the chapter: a date, or how long after the previous one. */
export const PUT = novelHandler<Ctx>(byChild("chapters"), async (request, { params }) => {
  const chapter = await getChapter((await params).id);
  const body = await readJson(request);
  let when;
  try {
    when = parseWhen(body.when);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const row = {
    when,
    flashback: body.flashback === true,
    label: typeof body.label === "string" ? body.label.trim().slice(0, 200) : "",
  };
  const { data: existing, error } = await db()
    .from("time_marks")
    .select("id")
    .eq("chapter_id", chapter.id)
    .eq("anchor->>at", "chapter_start")
    .maybeSingle();
  if (error) throw error;
  const write = existing
    ? db().from("time_marks").update(row).eq("id", existing.id)
    : db().from("time_marks").insert({ ...row, anchor: START, chapter_id: chapter.id, novel_id: chapter.novel_id });
  const { error: writeError } = await write;
  if (writeError) throw writeError;
  return new NextResponse(null, { status: 204 });
});

/** No mark: the chapter takes the previous one's time (shown as estimated). */
export const DELETE = novelHandler<Ctx>(byChild("chapters"), async (_request, { params }) => {
  const chapter = await getChapter((await params).id);
  const { error } = await db().from("time_marks").delete().eq("chapter_id", chapter.id).eq("anchor->>at", "chapter_start");
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
