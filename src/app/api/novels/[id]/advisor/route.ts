import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapterTexts, getMemory, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { echoes, novelMap, phraseRepetitions, presence } from "@/lib/advisor/stats";
import { monthUsage } from "@/lib/ai/usage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The Consejero's overview (docs/consejero.md, phase 1): measured in the text, no AI.
 * The open chapter travels in the body, so the figures match what the author sees
 * even before it is saved.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const [saved, memory, usage] = await Promise.all([getChapterTexts(novel.id), getMemory(novel.id), monthUsage(novel.id)]);
  const index = saved.findIndex((c) => c.id === body.chapterId);
  if (index === -1) throw new HttpError(404, "Capítulo no encontrado");
  const chapters = saved.map((c, i) => (i === index && typeof body.content === "string" ? { ...c, content: body.content } : c));
  const current = chapters[index];

  const characters = presence(chapters, memory.characters, index);
  const places = presence(chapters, memory.places, index);
  const names = [...memory.characters, ...memory.places];
  // Across the novel, only phrases found in more than one chapter: the rest are listed under the chapter.
  const novelWide = phraseRepetitions(chapters, 200)
    .filter((r) => new Set(r.occurrences.map((o) => o.chapterId)).size > 1)
    .slice(0, 30);

  return NextResponse.json(
    {
      chapterId: current.id,
      chapters: novelMap(chapters, characters, places),
      characters,
      places,
      repetitions: {
        chapter: [...phraseRepetitions([current], 20), ...echoes(current, names, 20)],
        novel: novelWide,
      },
      usage,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
