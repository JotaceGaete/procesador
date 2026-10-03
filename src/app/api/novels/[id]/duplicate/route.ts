import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getNovel } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

/** Full copy (chapters and memory) in a single database transaction. */
export const POST = handler<Ctx>(async (_request, { params }) => {
  const source = await getNovel((await params).id);
  const { data, error } = await db().rpc("duplicate_novel", { p_novel: source.id, p_title: `${source.title} (copia)` });
  if (error) throw error;
  return NextResponse.json({ id: data }, { status: 201 });
});
