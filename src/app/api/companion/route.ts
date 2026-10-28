import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapter, getChapterTexts, getNovel } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { COMPANIONS, companionPrompt, pickCompanion } from "@/lib/companions";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

/** Cuántos caracteres del capítulo anterior se mandan: sólo la continuidad inmediata. */
const TAIL_CHARS = 1500;
/** Turnos previos que se mandan con cada pedido, y tope de caracteres por turno. */
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1500;

/**
 * Compañero de lectura: lee el argumento y el capítulo abierto y responde. Nunca escribe en la
 * novela: el autor decide qué copia.
 */
export const POST = handler(async (request) => {
  const body = await readJson(request);
  const novel = await getNovel(String(body.novelId ?? ""));
  const chapter = await getChapter(String(body.chapterId ?? ""));
  if (chapter.novel_id !== novel.id) throw new HttpError(404, "Capítulo no encontrado");
  const provider = getProvider(body.provider as ProviderId);
  if (!provider) throw new HttpError(400, "Proveedor no disponible");

  const companionId = typeof body.companionId === "string" ? body.companionId : undefined;
  const genre = typeof novel.guide?.genre === "string" ? novel.guide.genre : undefined;
  const companion = pickCompanion(genre, companionId);

  const all = await getChapterTexts(novel.id);
  const index = all.findIndex((c) => c.id === chapter.id);
  const previous = index > 0 ? all[index - 1] : undefined;
  const previousTail = previous && !previous.reserved ? previous.content.slice(-TAIL_CHARS) : undefined;

  const request_ = String(body.request ?? "").trim().slice(0, 600);
  if (!request_) throw new HttpError(400, "Falta el pedido");

  // Sólo los últimos turnos, acotados: la conversación no crece sin límite en tokens.
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t: { speaker?: unknown; text?: unknown }) => (t.speaker === "autor" || t.speaker === "compañero") && typeof t.text === "string")
    .slice(-HISTORY_TURNS)
    .map((t: { speaker: "autor" | "compañero"; text: string }) => ({ speaker: t.speaker, text: t.text.slice(0, HISTORY_CHARS) }));

  const prompt = companionPrompt({
    companion,
    novel: { title: novel.title, guide: novel.guide ?? {} },
    synopsis: novel.synopsis ?? "",
    chapter: chapter.content,
    previousTail,
    history,
    request: request_,
  });

  let output = "";
  let truncated = false;
  for await (const event of provider.stream({
    instructions: `Eres ${companion.name}, compañero de lectura. Responde en español rioplatense, breve y concreto.`,
    manuscript: null, project: "", prompt, signal: request.signal, role: "write", maxOutputTokens: 1200,
  })) {
    if (event.type === "text") output += event.text;
    if (event.type === "truncated") truncated = true;
    if (event.type === "refusal") throw new HttpError(422, event.message);
  }
  if (!output.trim()) throw new HttpError(502, "No hubo respuesta del compañero");
  return NextResponse.json({ text: output.trim(), truncated, companion: companion.id, companions: COMPANIONS.map((c) => ({ id: c.id, name: c.name })) });
});
