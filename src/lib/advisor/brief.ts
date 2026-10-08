import "server-only";
import { getMemory } from "../supabase";
import { HttpError } from "../http";
import { nameMatcher } from "../ai/context";
import { completeJson, InvalidOutput } from "../ai/structured";
import { recordUsage } from "../ai/usage";
import type { ProviderId } from "../types";
import { conversationContext } from "./conversations";
import { lastProposal, parseBrief, planBlock, type SceneBrief } from "./converse";
import { BRIEF_INSTRUCTIONS } from "./prompts";

/**
 * «Enviar al Asistente» (docs/consejero.md, Conversar): the scene order for the Asistente,
 * prepared by the cheap model from the conversation, never sent by itself. The author's
 * decisions and discards go in their own words (from the conversation's plan), before
 * anything the model adds; the author reviews and edits the whole brief before using it.
 * If the model's answer can't be used, the brief is made from the proposal itself.
 */
export async function buildBrief(opts: {
  novelId: string;
  conversationId: string;
  anchorId: string | null;
  provider: ProviderId;
  signal: AbortSignal;
}): Promise<SceneBrief> {
  const conv = await conversationContext({ ...opts, compact: false });
  const card = opts.anchorId
    ? conv.cards.find((c) => c.id === opts.anchorId)
    : (conv.focus && conv.cards.find((c) => c.id === conv.focus!.id)) ?? lastProposal(conv.cards);
  if (!card) throw new HttpError(400, opts.anchorId ? "Esa propuesta no es de esta conversación." : "No hay ninguna propuesta que enviar.");
  const memory = await getMemory(opts.novelId);
  const known = { characters: memory.characters.map((c) => c.id), places: memory.places.map((p) => p.id) };

  const byName = <T extends { id: string; name: string; aliases: string }>(list: T[], names: string[], text: string) =>
    list
      .filter((x) => names.some((n) => n && nameMatcher(x)?.test(n)) || nameMatcher(x)?.test(text))
      .map((x) => x.id);

  const plan = conv.plan;
  const prompt = [
    `<personajes>\n${memory.characters.map((c) => `- ${c.name}${c.aliases ? ` (también: ${c.aliases})` : ""}`).join("\n") || "(ninguno)"}\n</personajes>`,
    `<lugares>\n${memory.places.map((p) => `- ${p.name}`).join("\n") || "(ninguno)"}\n</lugares>`,
    `<propuesta-elegida etiqueta="${card.label}">\n${card.title}\n${card.body}\n</propuesta-elegida>`,
    planBlock(plan) && `<plan-del-autor>\n${planBlock(plan)}\n</plan-del-autor>`,
    conv.text && `<conversacion>\n${conv.text.slice(-12_000)}\n</conversacion>`,
    "Prepara el encargo de la escena.",
  ]
    .filter(Boolean)
    .join("\n\n");

  let model: { argument: string; decisions: string[]; constraints: string[]; discarded: string[]; characters: string[]; place: string } | null = null;
  try {
    ({ value: model } = await completeJson(
      opts.provider,
      { instructions: BRIEF_INSTRUCTIONS, manuscript: null, project: "", prompt, signal: opts.signal, role: "digest", maxOutputTokens: 1500 },
      (raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
        if (typeof r.argument !== "string" || r.argument.trim().length < 10) throw new InvalidOutput('Falta "argument".');
        return {
          argument: r.argument,
          decisions: strings(r.decisions),
          constraints: strings(r.constraints),
          discarded: strings(r.discarded),
          characters: strings(r.characters),
          place: typeof r.place === "string" ? r.place : "",
        };
      },
      (u) => recordUsage(opts.novelId, "digest", opts.provider, u),
    ));
  } catch (e) {
    // Twice without valid JSON: the brief is made from the proposal (the author edits it anyway).
    if (opts.signal.aborted || !(e instanceof HttpError && e.status === 502 && /no devolvió una respuesta válida/.test(e.message))) throw e;
  }

  // Without a usable answer: the proposal itself, as the plan of the scene.
  const what = card.body.split("\n").find((l) => l.startsWith("Qué podría ocurrir: "))?.slice(20) ?? card.body.split("\n")[0];
  const argument = model?.argument.trim() || `${card.title}. ${what}`.trim();
  const unique = (xs: string[]) => [...new Map(xs.map((x) => [x.trim().toLocaleLowerCase("es"), x.trim()])).values()].filter(Boolean);
  const text = `${argument}\n${card.title}\n${card.body}`;
  return parseBrief(
    {
      argument,
      decisions: unique([...plan.decisions.map((d) => d.text), ...(model?.decisions ?? [])]),
      constraints: unique(model?.constraints ?? []),
      discarded: unique([...plan.discarded.map((d) => d.text), ...(model?.discarded ?? [])]),
      characterIds: byName(memory.characters, model?.characters ?? [], text),
      placeId: byName(memory.places, model?.place ? [model.place] : [], text)[0] ?? null,
      target: "end",
      source: `Propuesta ${card.label}`,
    },
    known,
  );
}
