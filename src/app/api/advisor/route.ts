import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { HttpError, readJson } from "@/lib/http";
import { buildAdvice } from "@/lib/advisor/advice";
import { actionLabel } from "@/lib/advisor/planner";
import { splitAnswer, verifyObservations } from "@/lib/advisor/observations";
import { extractJson } from "@/lib/ai/structured";
import { getProvider } from "@/lib/ai/providers";
import { recordUsage } from "@/lib/ai/usage";
import { conversationContext, getConversation, saveExchange } from "@/lib/advisor/conversations";
import { adviseRounds, type LoopResult } from "@/lib/advisor/loop";
import type { DeepRequest } from "@/lib/advisor/deep";
import type { AdvisorAction, AssistEvent, Observation, ProviderId, Usage } from "@/lib/types";

export const maxDuration = 300;

/**
 * The Consejero's actions and free questions (docs/consejero.md, phase 3). The answer
 * streams as Markdown; the observations come at the end, each reference checked against
 * the manuscript. `dryRun` returns the context it would send and the chapters it would
 * like read first, without calling any provider.
 */
export const POST = handler(async (request) => {
  const body = await readJson(request);
  const provider = getProvider(body.provider as ProviderId);
  if (!provider && !body.dryRun) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  const sel = body.selection as { start?: unknown; end?: unknown } | null;
  const novelId = String(body.novelId ?? "");
  // Continuing a conversation: its summary and last turns go with the question
  // (compacting the older ones first if needed; never on a dry run).
  const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : null;
  let conversation: { text: string; messages: number } | null = null;
  if (conversationId) {
    const c = await getConversation(conversationId);
    if (c.novel_id !== novelId) throw new HttpError(404, "Conversación no encontrada");
    if (!body.dryRun) conversation = await conversationContext({ conversationId, novelId, provider: body.provider as ProviderId, signal: request.signal });
  }
  const advice = await buildAdvice(
    {
      novelId,
      chapterId: String(body.chapterId ?? ""),
      content: typeof body.content === "string" ? body.content : "",
      action: typeof body.action === "string" ? (body.action as AdvisorAction) : undefined,
      question: typeof body.question === "string" ? body.question : undefined,
      selection: sel && Number.isFinite(Number(sel.start)) ? { start: Number(sel.start), end: Number(sel.end) } : null,
      characterIds: Array.isArray(body.characterIds) ? body.characterIds.filter((x): x is string => typeof x === "string") : [],
      conversation: conversation?.text,
      deep: body.deep !== false,
    },
    request.signal,
  );
  const plan = { type: "plan" as const, action: advice.plan.action, label: actionLabel(advice.plan.action), detail: advice.detail };

  if (body.dryRun) {
    return NextResponse.json({
      total: advice.parts.reduce((n, p) => n + p.tokens, 0),
      parts: advice.parts,
      plan,
      unread: advice.unread,
    });
  }

  const encoder = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, e: AssistEvent) => c.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
  const question = typeof body.question === "string" && body.question.trim() ? body.question.trim().slice(0, 2000) : plan.label;
  // Requests the author approved after a pause, served before the first call.
  const preload = (Array.isArray(body.preload) ? body.preload : [])
    .filter((r): r is DeepRequest => !!r && typeof r === "object" && typeof (r as DeepRequest).tipo === "string")
    .slice(0, 30);
  const rounds = adviseRounds({
    provider: provider!,
    request: advice.request,
    tools: advice.tools,
    deep: body.deep !== false,
    preload,
    approvedTokens: Number(body.approvedTokens) || 0,
    onUsage: (u) => recordUsage(advice.novelId, "advise", body.provider as ProviderId, u),
  });
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      send(c, { type: "context", parts: advice.parts });
      send(c, plan);
    },
    async pull(c) {
      if (ended) return c.close();
      try {
        const step = await rounds.next();
        if (!step.done) {
          send(c, step.value);
          return;
        }
        ended = true;
        const result: LoopResult = step.value;
        if (result.text === null) return c.close(); // paused to ask the author, or refused
        // The cards, validated and verified (against every chapter, the material's too).
        const { markdown, json } = splitAnswer(result.text);
        let items: Observation[] = [];
        if (json !== null) {
          try {
            items = verifyObservations(parseList(json), advice.chapters);
            send(c, { type: "observations", items });
          } catch {
            send(c, { type: "observations", items: [], invalid: true });
          }
        }
        // Stored as an exchange of the conversation. What it relied on includes the chapters
        // it read through lectura profunda, at their current revision.
        if (markdown || items.length) {
          const extra = new Set(result.items.flatMap((m) => m.chapters));
          const basedOn = {
            ...advice.basedOn,
            ...Object.fromEntries(advice.tools.chapters.filter((x) => extra.has(x.id)).map((x) => [x.id, x.revision])),
          };
          const saved = await saveExchange({
            novelId: advice.novelId,
            conversationId,
            title: question,
            question,
            answer: markdown,
            context: {
              parts: advice.parts,
              plan: { label: plan.label, detail: plan.detail },
              model: result.usage?.model ?? null,
              usage: result.usage,
              material: result.items.map(({ label, tokens }) => ({ label, tokens })),
              rounds: result.rounds,
            },
            observations: items,
            basedOn,
          });
          send(c, { type: "saved", ...saved });
        }
        c.close();
      } catch (e) {
        if (!request.signal.aborted) {
          console.error("[advisor]", e instanceof Error ? e.message : e);
          send(c, { type: "error", message: provider!.describeError(e) });
        }
        c.close();
      }
    },
    async cancel() {
      await rounds.return({ text: null, items: [], rounds: 0, usage: null });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
});

/** The list of observations: a JSON array (maybe in ``` fences) or an object with "items". */
function parseList(json: string): unknown {
  const a = json.indexOf("[");
  const o = json.indexOf("{");
  if (a !== -1 && (o === -1 || a < o)) return JSON.parse(json.slice(a, json.lastIndexOf("]") + 1));
  return extractJson(json);
}
