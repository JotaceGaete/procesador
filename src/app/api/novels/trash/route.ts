import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db } from "@/lib/supabase";
import { purgeExpiredNovels } from "@/lib/novel-trash-server";
import type { NovelTrashEntry } from "@/lib/types";

/** The novels in the trash. Those deleted more than 30 days ago are erased first. */
export const GET = handler(async () => {
  await purgeExpiredNovels();
  const { data, error } = await db().rpc("novel_trash");
  if (error) throw error;
  return NextResponse.json(data as NovelTrashEntry[], { headers: { "Cache-Control": "no-store" } });
});
