import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { HttpError, readJson } from "@/lib/http";
import { buildAdvice } from "@/lib/advisor/advice";
import { actionLabel } from "@/lib/advisor/planner";
import { splitAnswer, verifyObservations } from "@/lib/advisor/observations";
import { extractJson } from "@/lib/ai/structured";
import { getProvider } from "@/lib/ai/providers";
import { recordUsage } from "@/lib/ai/usage";
import type { AdvisorAction, AssistEvent, ProviderId } from "@/lib/types";

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
  const advice = await buildAdvice(
    {
      novelId: String(body.novelId ?? ""),
      chapterId: String(body.chapterId ?? ""),
      content: typeof body.content === "string" ? body.content : "",
      action: typeof body.action === "string" ? (body.action as AdvisorAction) : undefined,
      question: typeof body.question === "string" ? body.question : undefined,
      selection: sel && Number.isFinite(Number(sel.start)) ? { start: Number(sel.start), end: Number(sel.end) } : null,
      characterIds: Array.isArray(body.characterIds) ? body.characterIds.filter((x): x is string => typeof x === "string") : [],
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
  const generator = provider!.stream(advice.request);
  let text = "";
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      send(c, { type: "context", parts: advice.parts });
      send(c, plan);
    },
    async pull(c) {
      if (ended) return c.close();
      try {
        const { value, done } = await generator.next();
        if (!done) {
          if (value.type === "text") text += value.text;
          if (value.type === "usage") await recordUsage(advice.novelId, "advise", body.provider as ProviderId, value);
          send(c, value);
          return;
        }
        // The cards, validated and verified, once the whole answer is in.
        const { json } = splitAnswer(text);
        if (json !== null) {
          try {
            send(c, { type: "observations", items: verifyObservations(parseList(json), advice.chapters) });
          } catch {
            send(c, { type: "observations", items: [], invalid: true });
          }
        }
        ended = true;
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
      await generator.return(undefined);
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
