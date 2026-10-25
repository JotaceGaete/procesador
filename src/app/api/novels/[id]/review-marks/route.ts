import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db, getChapter, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };
const columns = "id,novel_id,chapter_id,category,note,quote,start_offset,end_offset,status,origin,created_at,updated_at,resolved_at";
const categories = new Set(["incoherencia", "continuidad", "repeticion", "estilo", "ortografia", "otro"]);

export const GET = handler<Ctx>(async (_request, { params }) => {
  const novelId = assertId((await params).id, "Novela");
  await getNovel(novelId);
  const { data, error } = await db().from("review_marks").select(columns).eq("novel_id", novelId).order("created_at", { ascending: false });
  if (error) throw error;
  return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
});

export const POST = handler<Ctx>(async (request, { params }) => {
  const novelId = assertId((await params).id, "Novela");
  await getNovel(novelId);
  const body = await readJson(request);
  const chapterId = assertId(body.chapter_id, "Capítulo");
  const chapter = await getChapter(chapterId);
  if (chapter.novel_id !== novelId) throw new HttpError(400, "El capítulo no pertenece a esta novela");
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > 4000) throw new HttpError(400, "La observación debe tener entre 1 y 4000 caracteres");
  const category = typeof body.category === "string" ? body.category : "otro";
  if (!categories.has(category)) throw new HttpError(400, "Categoría inválida");
  const quote = typeof body.quote === "string" ? body.quote.slice(0, 3000) : "";
  const start = Number(body.start_offset);
  const end = Number(body.end_offset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > chapter.content.length) {
    throw new HttpError(400, "Posición del fragmento inválida");
  }
  // A stale selection may have moved since the author highlighted it.
  if (quote && chapter.content.slice(start, end) !== quote) {
    throw new HttpError(409, "El fragmento cambió. Vuelve a seleccionarlo antes de marcarlo.");
  }
  const { data, error } = await db().from("review_marks").insert({
    novel_id: novelId, chapter_id: chapterId, category, note, quote,
    start_offset: start, end_offset: end, origin: "manual",
  }).select(columns).single();
  if (error) throw error;
  return NextResponse.json(data, { status: 201 });
});
