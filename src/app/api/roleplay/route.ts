import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapter, getNovel, getScopedMemory } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { roleplayPrompt, type RoleTurn } from "@/lib/ai/roleplay";
import { getProvider } from "@/lib/ai/providers";
import { recordUsage } from "@/lib/ai/usage";
import type { ProviderId, Usage } from "@/lib/types";

export const POST = handler(async (request) => {
  const body = await readJson(request);
  const novel = await getNovel(String(body.novelId ?? ""));
  const chapter = await getChapter(String(body.chapterId ?? ""));
  if (chapter.novel_id !== novel.id) throw new HttpError(404, "Capítulo no encontrado");
  const providerId = body.provider as ProviderId;
  const provider = getProvider(providerId);
  if (!provider) throw new HttpError(400, "Proveedor de IA no disponible");
  const memory = await getScopedMemory(novel.id, chapter.id);
  const character = memory.characters.find((c) => c.id === body.characterId);
  const name = character?.name ?? (typeof body.casualName === "string" ? body.casualName.trim().slice(0, 100) : "");
  if (!name) throw new HttpError(400, "Selecciona un personaje o indica su nombre");
  const raw = Array.isArray(body.history) ? body.history : [];
  if (raw.length > 200) throw new HttpError(400, "Conversación demasiado larga");
  const history: RoleTurn[] = raw.map((t: unknown) => {
    if (!t || typeof t !== "object") throw new HttpError(400, "Mensaje no válido");
    const x = t as Record<string, unknown>;
    if ((x.speaker !== "autor" && x.speaker !== "personaje") || typeof x.text !== "string" || x.text.length > 500)
      throw new HttpError(400, "Mensaje no válido");
    return { speaker: x.speaker, text: x.text };
  });
  let prompt: string;
  try {
    prompt = roleplayPrompt({ name, authorName: typeof body.authorName === "string" ? body.authorName : "Autor",
      personality: character?.personality, voice: character?.voice, permanentRules: character?.dialogue_rules, knows: character?.knows,
      unaware: character?.unaware, objective: typeof body.objective === "string" ? body.objective : "", avoid: typeof body.avoid === "string" ? body.avoid : "", history });
  } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : "Conversación no válida"); }
  let text = "";
  let truncated = false;
  let usage: Usage | null = null;
  for await (const event of provider.stream({
    instructions: "Eres un personaje ficticio en un role play literario. Solo una intervención por respuesta.",
    manuscript: null, project: "", prompt, signal: request.signal, role: "write", maxOutputTokens: 450,
  })) {
    if (event.type === "text") text += event.text;
    if (event.type === "truncated") truncated = true;
    if (event.type === "usage") usage = { model: event.model, input: event.input, cached: event.cached, output: event.output, costUsd: event.costUsd };
    if (event.type === "refusal") throw new HttpError(422, event.message);
  }
  if (usage) await recordUsage(novel.id, "assist", providerId, usage);
  if (!text.trim()) throw new HttpError(502, "El personaje no respondió");
  return NextResponse.json({ text: text.trim(), truncated, usage }, { headers: { "Cache-Control": "no-store" } });
});
