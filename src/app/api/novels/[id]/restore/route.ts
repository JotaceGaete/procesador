import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { assertId, db } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

/** Brings a novel back from the trash, as it was: with its chapters, versions and memory. */
export const POST = handler<Ctx>(async (_request, { params }) => {
  const id = assertId((await params).id, "Novela");
  const { error } = await db().rpc("restore_novel", { p_novel: id });
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
