import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { getChapter, getNovel, getScopedMemory } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { roleplayPrompt, roleplayMessages, type RoleTurn } from "@/lib/ai/roleplay";
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
  const history: RoleTurn[] = raw.map((t: unknown, index: number) => {
    if (!t || typeof t !== "object") throw new HttpError(400, `Intervención ${index + 1} inválida: no es un objeto.`);
    const x = t as Record<string, unknown>;
    if ((x.speaker !== "autor" && x.speaker !== "personaje") || typeof x.text !== "string" || x.text.length > 500)
      throw new HttpError(400, `Intervención ${index + 1} inválida: comprueba el tipo de participante y el límite de 500 caracteres.`);
    return { speaker: x.speaker, text: x.text, context: typeof x.context === "string" ? x.context.slice(0, 600) : undefined };
  });
  const recentText = history.slice(-12).map((t) => t.text).join(" ").toLocaleLowerCase("es");
  const mentioned = memory.characters.filter((c) => c.id !== character?.id &&
    [c.name, ...c.aliases.split(",")].some((n) => n.trim().length >= 3 && recentText.includes(n.trim().toLocaleLowerCase("es"))));
  const relatedIds = new Set(memory.relationships.filter((r) => r.from_id === character?.id || r.to_id === character?.id)
    .map((r) => r.from_id === character?.id ? r.to_id : r.from_id));
  const relevant = memory.characters.filter((c) => c.id !== character?.id && (mentioned.includes(c) || relatedIds.has(c.id))).slice(0, 8);
  const storyContext = relevant.map((c) => {
    const links = memory.relationships.filter((r) => (r.from_id === character?.id && r.to_id === c.id) ||
      (r.to_id === character?.id && r.from_id === c.id));
    return [c.name, c.role && `Rol: ${c.role.slice(0, 90)}`, c.description && `Descripción: ${c.description.slice(0, 180)}`,
      ...links.map((l) => `Vínculo: ${l.kind.slice(0, 90)}`)].filter(Boolean).join(". ");
  }).join("\n");
  let prompt: string;
  try {
    prompt = roleplayPrompt({ name, authorName: typeof body.authorName === "string" ? body.authorName : "Autor",
      personality: character?.personality, voice: character?.voice, permanentRules: character?.dialogue_rules, knows: character?.knows,
      unaware: character?.unaware, storyContext, objective: typeof body.objective === "string" ? body.objective : "", direction: typeof body.direction === "string" ? body.direction.slice(0, 900) : "", avoid: typeof body.avoid === "string" ? body.avoid : "", history });
  } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : "Conversación no válida"); }
  const direction = typeof body.direction === "string" ? body.direction.trim().slice(0, 900) : "";
  const messages = roleplayMessages(history);
  let text = "";
  let truncated = false;
  let usage: Usage | null = null;
  let feedback = "";
  // The actor's first response is only a proposal when a director's order exists.
  // An independent check can reject a response that ignores the prescribed outcome.
  for (let attempt = 0; attempt < (direction ? 3 : 2); attempt++) {
    text = "";
    truncated = false;
    usage = null;
    const correction = attempt === 0 ? "" : feedback
      ? "\nCORRECCIÓN OBLIGATORIA DEL DIRECTOR: tu interpretación anterior fue rechazada porque " + feedback.slice(0, 300) + ". Reescribe la respuesta completa; realiza el resultado indicado por el director, no lo pospongas."
      : "\nRESPUESTA DE RECUPERACIÓN: contesta directamente a la última intervención. Produce una respuesta visible, concreta y coherente con la dirección.";
    for await (const event of provider.stream({
      instructions: prompt + correction,
      messages,
      manuscript: null, project: "", prompt: "", signal: request.signal, role: "write",
      maxOutputTokens: direction ? 650 : (attempt === 0 ? 300 : 550),
    })) {
      if (event.type === "text") text += event.text;
      if (event.type === "truncated") truncated = true;
      if (event.type === "usage") usage = { model: event.model, input: event.input, cached: event.cached, output: event.output, costUsd: event.costUsd };
      if (event.type === "refusal") throw new HttpError(422, event.message);
    }
    if (!text.trim()) { feedback = "no hubo una respuesta visible"; continue; }
    if (!direction) break;

    // Judge the proposed answer separately from the character persona. The judge
    // checks narrative compliance, not whether the character would personally agree.
    let verdict = "";
    for await (const event of provider.stream({
      instructions: "Eres un verificador editorial, NO el personaje. Comprueba si la respuesta representa efectivamente la dirección del autor EN ESTA intervención. Las acciones ordenadas tienen que suceder, no solo prometerse o discutirse. Si el director especifica una secuencia, comprueba su orden y desenlace. No evalúes si al personaje le gustaría obedecer. Responde solo con CUMPLE o NO_CUMPLE: motivo breve. No reescribas la escena.",
      messages: [{ role: "user", content: "DIRECCIÓN:\n" + direction + "\n\nRESPUESTA PROPUESTA:\n" + text.slice(0, 3500) }],
      manuscript: null, project: "", prompt: "", signal: request.signal, role: "write",
      maxOutputTokens: 100,
    })) {
      if (event.type === "text") verdict += event.text;
    }
    if (/^CUMPLE\b/i.test(verdict.trim())) { feedback = ""; break; }
    feedback = verdict.trim().replace(/^NO_CUMPLE\s*:?\s*/i, "") || "no cumple la dirección narrativa";
    text = "";
  }
  if (direction && !text.trim()) throw new HttpError(422, "La IA no consiguió cumplir la dirección del autor tras varios intentos. No se agregó ninguna respuesta al diálogo; puedes reformular la instrucción o probar otro proveedor.");
  if (usage) await recordUsage(novel.id, "assist", providerId, usage);
  if (!text.trim()) throw new HttpError(502, "El personaje no respondió");
  return NextResponse.json({ text: text.trim(), truncated, usage }, { headers: { "Cache-Control": "no-store" } });
});
