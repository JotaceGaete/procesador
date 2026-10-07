import { NextResponse } from "next/server";
import { handler } from "@/lib/access";
import { db } from "@/lib/supabase";
import { readJson } from "@/lib/http";

/** Library: every novel with chapter and word counts. */
export const GET = handler(async () => {
  const { data, error } = await db().rpc("library");
  if (error) throw error;
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
});

/** New novel with an empty first chapter. */
export const POST = handler(async (request) => {
  const body = await readJson(request);
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 300) : "Novela sin título";
  const { data: novel, error } = await db().from("novels").insert({ title }).select("id").single();
  if (error) throw error;
  const { error: chapterError } = await db().from("chapters").insert({ novel_id: novel.id, title: "Capítulo 1", position: 1 });
  if (chapterError) throw chapterError;
  return NextResponse.json(novel, { status: 201 });
});
