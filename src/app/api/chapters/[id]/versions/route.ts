import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db, getChapter } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import type { ChapterVersion, VersionReason } from "@/lib/types";
import { assertChapterUnlocked } from "@/lib/chapter-lock-server";

type Ctx = { params: Promise<{ id: string }> };

/** Reasons the app may ask for; 'auto' and 'delete' are the database's own. */
const ASKED: VersionReason[] = ["ai", "conflict", "manual", "restore"];
/** The copies kept right before the text changes: a locked chapter refuses them, and with them the change. */
const BEFORE_CHANGE: VersionReason[] = ["ai", "restore"];

/** The chapter's versions, newest first, without their text. */
export const GET = handler<Ctx>(async (_request, { params }) => {
  const chapter = await getChapter((await params).id);
  const { data, error } = await db()
    .from("chapter_versions")
    .select("id, reason, label, title, words, created_at")
    .eq("chapter_id", chapter.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw error;
  return NextResponse.json(data as ChapterVersion[], { headers: { "Cache-Control": "no-store" } });
});

/**
 * Keeps a version: the text sent (what the editor has, before applying the AI or restoring)
 * or, without it, the text saved on the server (the other device's, before «Conservar la mía»).
 * The same text as the last version is not repeated. Answers { id } (null for an empty text).
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const id = assertId((await params).id, "Capítulo");
  const body = await readJson(request);
  const reason = body.reason as VersionReason;
  if (!ASKED.includes(reason)) throw new HttpError(400, "Motivo de versión desconocido");
  if (body.content !== undefined && typeof body.content !== "string") throw new HttpError(400, "Texto inválido");
  if (BEFORE_CHANGE.includes(reason)) await assertChapterUnlocked(id);
  const { data, error } = await db().rpc("save_chapter_version", {
    p_chapter: id,
    p_reason: reason,
    p_label: typeof body.label === "string" ? body.label.slice(0, 200) : "",
    p_content: typeof body.content === "string" ? body.content : null,
  });
  if (error) throw error;
  return NextResponse.json({ id: data as string | null }, { status: 201 });
});
