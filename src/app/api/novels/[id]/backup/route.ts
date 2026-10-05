import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getMemory, getNovel } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Copia de seguridad (docs/versiones.md): everything the author wrote and decided for this
 * novel, as data. The browser adds the original files (each through its own short-lived
 * link: they can be larger than what a function may return) and builds the ZIP.
 */
export const GET = handler<Ctx>(async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  const of = (table: string, columns: string, order = "created_at") =>
    db().from(table).select(columns).eq("novel_id", novel.id).order(order);
  const [chapters, memory, threads, digests, global, manuscriptImages, characterImages, assets] = await Promise.all([
    db().from("chapters").select("id, title, position, content, revision, created_at, updated_at").eq("novel_id", novel.id).order("position").order("created_at"),
    getMemory(novel.id),
    of("story_threads", "*"),
    of("chapter_digests", "*"),
    db().from("novel_digests").select("summary, based_on, updated_at").eq("novel_id", novel.id).maybeSingle(),
    of("manuscript_images", "id, asset_id, chapter_id, alt, decorative, caption, credit, layout, align, width_pct"),
    of("character_images", "id, character_id, asset_id, caption, stage_label, is_primary, sort_order", "sort_order"),
    db()
      .from("assets")
      .select("id, version, file_name, original_type, original_bytes, width, height, orientation, sha256")
      .eq("novel_id", novel.id)
      .eq("status", "ready")
      .order("created_at"),
  ]);
  for (const r of [chapters, threads, digests, global, manuscriptImages, characterImages, assets]) if (r.error) throw r.error;
  return NextResponse.json(
    {
      format: "procesador-backup",
      version: 1,
      exported_at: new Date().toISOString(),
      novel: { id: novel.id, title: novel.title, synopsis: novel.synopsis, notes: novel.notes, guide: novel.guide, book: novel.book },
      chapters: chapters.data,
      memory,
      reading: { threads: threads.data, digests: digests.data, summary: global.data },
      images: { manuscript: manuscriptImages.data, characters: characterImages.data, files: assets.data },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
