import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { novelChronology } from "@/lib/chronology-server";
import { formatAge, formatPoint } from "@/lib/chronology";
import type { ChronologyView } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Cronología (docs/cronologia-edades.md): each chapter's time, each character's age in each
 * chapter, and the warnings. Computed now from the marks, anchors and texts; nothing stored.
 */
export const GET = handler<Ctx>(async (_request, { params }) => {
  const novel = await getNovel((await params).id);
  const { result, chapters, characters, marks } = await novelChronology(novel, { texts: true });
  const dismissed = novel.dismissed_warnings ?? {};
  const view: ChronologyView = {
    calendar: novel.calendar,
    chapters: chapters.map((c, i) => ({
      id: c.id,
      title: c.title,
      mark: marks.find((m) => m.chapter_id === c.id) ?? null,
      time: formatPoint(result.points[i], novel.calendar),
      estimated: result.points[i].estimated,
    })),
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      anchored: Boolean(c.age_anchor),
      ages: (result.ages.get(c.id) ?? []).map((a) => (a ? formatAge(a) : null)),
    })),
    warnings: result.warnings.map((w) => ({ ...w, dismissed: dismissed[w.key] === w.fingerprint })),
  };
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
});

/**
 * The calendar, and the author's decisions on warnings: `dismiss` {key, fingerprint} ("it's
 * on purpose": it stays hidden while its data doesn't change) or `restore` {key}.
 */
export const PATCH = handler<Ctx>(async (request, { params }) => {
  const novel = await getNovel((await params).id);
  const body = await readJson(request);
  const update: Record<string, unknown> = {};
  if ("calendar" in body) {
    if (body.calendar !== "real" && body.calendar !== "relative") throw new HttpError(400, "Calendario: real o relativo.");
    update.calendar = body.calendar;
  }
  const dismissed = { ...(novel.dismissed_warnings ?? {}) };
  const d = body.dismiss as { key?: unknown; fingerprint?: unknown } | undefined;
  if (d) {
    if (typeof d.key !== "string" || typeof d.fingerprint !== "string" || d.key.length > 200 || d.fingerprint.length > 2000)
      throw new HttpError(400, "Advertencia inválida");
    dismissed[d.key] = d.fingerprint;
    update.dismissed_warnings = dismissed;
  }
  if (typeof body.restore === "string") {
    delete dismissed[body.restore];
    update.dismissed_warnings = dismissed;
  }
  if (!Object.keys(update).length) throw new HttpError(400, "Nada que guardar");
  const { error } = await db().from("novels").update(update).eq("id", novel.id);
  if (error) throw error;
  return new NextResponse(null, { status: 204 });
});
