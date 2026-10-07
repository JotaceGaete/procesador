import { NextResponse } from "next/server";
import { byParam, novelHandler } from "@/lib/access";
import { db, getNovel } from "@/lib/supabase";
import { bucket, removeFiles } from "@/lib/assets-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Full copy (chapters, memory, files and their uses) in a single database
 * transaction, then the files in Storage: each file once, even if it has several
 * uses. The copy is independent (deleting one novel never touches the other's
 * files). If a file can't be copied, the copy is undone: never a half-copied novel.
 */
export const POST = novelHandler<Ctx>(byParam(), async (_request, { params }) => {
  const source = await getNovel((await params).id);
  const { data, error } = await db().rpc("duplicate_novel", { p_novel: source.id, p_title: `${source.title} (copia)` });
  if (error) throw error;
  const { id, copies } = data as { id: string; copies: [string, string][] };

  const copied: string[] = [];
  try {
    for (const [from, to] of copies) {
      const { error: copyError } = await bucket().copy(from, to);
      if (copyError) throw copyError;
      copied.push(to);
    }
  } catch (e) {
    await db().from("novels").delete().eq("id", id);
    await removeFiles(copied);
    throw e;
  }
  return NextResponse.json({ id }, { status: 201 });
});
