import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapter, getNovel, getScopedMemory } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { dialoguePrompt } from "@/lib/ai/dialogue";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

export const POST = handler(async (request) => {
  const body = await readJson(request);
  const novel = await getNovel(String(body.novelId ?? ""));
  const chapter = await getChapter(String(body.chapterId ?? ""));
  if (chapter.novel_id !== novel.id) throw new HttpError(404, "Capítulo no encontrado");
  const provider = getProvider(body.provider as ProviderId);
  if (!provider) throw new HttpError(400, "Proveedor no disponible");
  const memory = await getScopedMemory(novel.id, chapter.id);
  const selected = Array.isArray(body.participants) ? body.participants : [];
  const participants = selected.map((p: {id?: string; name?: string; role?: string}) => {
    const role = p.role === "escucha" ? "escucha" as const : "habla" as const;
    if (!p.id) return { name: p.name ?? "", role, occasional: true };
    const character = memory.characters.find((c) => c.id === p.id);
    if (!character) throw new HttpError(400, "Personaje no encontrado");
    return { name: character.name, role, personality: character.personality, voice: character.voice, knows: character.knows, unaware: character.unaware };
  });
  let prompt: string;
  try {
    prompt = dialoguePrompt({ argument: String(body.argument ?? ""), context: String(body.context ?? ""),
      length: body.length === "breve" || body.length === "larga" ? body.length : "media", participants });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "Argumento no válido");
  }
  let output = "";
  let truncated = false;
  for await (const event of provider.stream({
    instructions: "Escribe únicamente la escena dialogada solicitada.", manuscript: null, project: "",
    prompt, signal: request.signal, role: "write", maxOutputTokens: 1200,
  })) {
    if (event.type === "text") output += event.text;
    if (event.type === "truncated") truncated = true;
    if (event.type === "refusal") throw new HttpError(422, event.message);
  }
  if (!output.trim()) throw new HttpError(502, "No se generó un diálogo");
  return NextResponse.json({ text: output.trim(), truncated });
});
