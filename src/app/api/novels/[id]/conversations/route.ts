import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { getNovel } from "@/lib/supabase";
import { listConversations } from "@/lib/advisor/conversations";

type Ctx = { params: Promise<{ id: string }> };

/** The novel's conversations with the Consejero, most recent first. */
export const GET = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  return NextResponse.json(await listConversations(novel.id), { headers: { "Cache-Control": "no-store" } });
});
