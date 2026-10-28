import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapter, getChapterTexts, getNovel, getScopedMemory } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { COMPANIONS, companionPrompt, pickCompanion, reviewPrompt } from "@/lib/companions";
import { fromModel, protectImages, restoreImages, separatorsForModel } from "@/lib/manuscript";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

/** Cuántos caracteres del capítulo anterior se mandan: sólo la continuidad inmediata. */
const TAIL_CHARS = 1500;
/** Turnos previos que se mandan con cada pedido, y tope de caracteres por turno. */
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1500;
/** Personajes que se mandan y tope por personaje. */
const MAX_CHARACTERS = 15;
const CHARACTER_CHARS = 350;
/** Ni la revisión ni el diálogo pasan de este largo de texto del modelo. */
const REVIEW_MAX_TOKENS = 16000;
const CHAT_MAX_TOKENS = 1200;

/**
 * Compañero de lectura. Conversa (task "chat") o revisa el capítulo entero (task "revisar").
 * La revisión devuelve una propuesta: nunca escribe en la novela; el autor la aplica.
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
  const memory = await getScopedMemory(novel.id, chapter.id);
  const characters = memory.characters.slice(0, MAX_CHARACTERS).map((c) =>
    `- ${c.name}${c.role ? ` (${c.role})` : ""}: ${[c.description, c.motivations && `quiere ${c.motivations}`, c.fears && `teme ${c.fears}`]
      .filter(Boolean).join(". ")}`.slice(0, CHARACTER_CHARS));
  const synopsis = novel.synopsis ?? "";
  const guide = novel.guide ?? {};

  if (body.task === "revisar") {
    // El capítulo viaja con marcadores y separadores neutros; la propuesta vuelve con las imágenes reales.
    const protectedChapter = protectImages(chapter.content);
    const prompt = reviewPrompt({
      companion,
      novel: { title: novel.title, guide },
      synopsis,
      chapter: separatorsForModel(protectedChapter.text),
      notes: String(body.request ?? "").slice(0, 2000),
      characters,
    });
    const { output, truncated } = await run(provider, companion.name, prompt, request.signal, REVIEW_MAX_TOKENS);
    // Sin la etiqueta de cierre el capítulo puede estar cortado: no se propone nada.
    const match = output.match(/<capitulo>([\s\S]*?)<\/capitulo>/);
    if (truncated || !match || !match[1].trim()) throw new HttpError(502, "La revisión quedó incompleta. No se propuso ningún cambio; prueba de nuevo.");
    const restored = restoreImages(fromModel(match[1].trim()), protectedChapter.ids);
    const changes = output.slice(output.indexOf("</capitulo>") + "</capitulo>".length).trim();
    return NextResponse.json({
      task: "revisar",
      proposal: restored.text,
      missing: restored.missing,
      changes,
      companion: companion.id,
    });
  }

  const request_ = String(body.request ?? "").trim().slice(0, 600);
  if (!request_) throw new HttpError(400, "Falta el pedido");
  // Sólo los últimos turnos, acotados: la conversación no crece sin límite en tokens.
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t: { speaker?: unknown; text?: unknown }) => (t.speaker === "autor" || t.speaker === "compañero") && typeof t.text === "string")
    .slice(-HISTORY_TURNS)
    .map((t: { speaker: "autor" | "compañero"; text: string }) => ({ speaker: t.speaker, text: t.text.slice(0, HISTORY_CHARS) }));
  const all = await getChapterTexts(novel.id);
  const index = all.findIndex((c) => c.id === chapter.id);
  const previous = index > 0 ? all[index - 1] : undefined;
  const previousTail = previous && !previous.reserved ? previous.content.slice(-TAIL_CHARS) : undefined;

  const prompt = companionPrompt({
    companion,
    novel: { title: novel.title, guide },
    synopsis,
    chapter: chapter.content,
    previousTail,
    characters,
    history,
    request: request_,
  });
  const { output } = await run(provider, companion.name, prompt, request.signal, CHAT_MAX_TOKENS);
  return NextResponse.json({ text: output, truncated: false, companion: companion.id, companions: COMPANIONS.map((c) => ({ id: c.id, name: c.name })) });
});

async function run(provider: NonNullable<ReturnType<typeof getProvider>>, name: string, prompt: string, signal: AbortSignal, maxOutputTokens: number) {
  let output = "";
  let truncated = false;
  for await (const event of provider.stream({
    instructions: `Eres ${name}, compañero de lectura. Responde en español rioplatense, breve, cálido y sin listas salvo que el autor las pida.`,
    manuscript: null, project: "", prompt, signal, role: "write", maxOutputTokens,
  })) {
    if (event.type === "text") output += event.text;
    if (event.type === "truncated") truncated = true;
    if (event.type === "refusal") throw new HttpError(422, event.message);
  }
  if (!output.trim()) throw new HttpError(502, "No hubo respuesta del compañero");
  return { output: output.trim(), truncated };
}
