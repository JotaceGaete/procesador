import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { assertId, db } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import type { ChapterVersion } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** One version with its text, to compare it or restore it. */
export const GET = novelHandler<Ctx>(byChild("chapter_versions"), async (_request, { params }) => {
  const { data, error } = await db()
    .from("chapter_versions")
    .select("id, reason, label, title, words, created_at, content")
    .eq("id", assertId((await params).id, "Versión"))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Versión no encontrada");
  return NextResponse.json(data as ChapterVersion, { headers: { "Cache-Control": "no-store" } });
});
