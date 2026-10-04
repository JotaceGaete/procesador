import "server-only";
import { estimateTokens } from "../ai/context";
import { confirmTokens } from "../ai/models";
import type { CompletionRequest, getProvider } from "../ai/providers";
import type { AssistEvent, Usage } from "../types";
import { LAST_ROUND, REQUEST_OPEN, mightBeRequest, newState, parseRequests, serve, type DeepRequest, type MaterialItem, type ToolContext } from "./deep";

type Provider = NonNullable<ReturnType<typeof getProvider>>;

export interface LoopResult {
  /** The final answer (Markdown and observations block), or null if it paused to ask. */
  text: string | null;
  items: MaterialItem[];
  rounds: number;
  usage: Usage | null;
}

/**
 * The answer, in rounds (docs/consejero.md, phase 5). Round 1 starts from the
 * hierarchical context. If the model asks for material instead of answering, the
 * server serves it (read-only, within the limits) and asks again; the last allowed
 * round tells it to answer with what it has. Before a round that would take the
 * query above AI_CONFIRM_TOKENS (counting every round, since each one sends the
 * context again), it pauses and asks the author, unless they already approved that.
 * Only the final answer streams to the author; request rounds become progress events.
 */
export async function* adviseRounds(opts: {
  provider: Provider;
  request: CompletionRequest;
  tools: ToolContext;
  deep: boolean;
  /** Requests approved by the author after a pause: served before the first call. */
  preload: DeepRequest[];
  approvedTokens: number;
  onUsage(u: Usage): Promise<void>;
}): AsyncGenerator<AssistEvent, LoopResult> {
  const state = newState();
  const material: string[] = [];
  const items: MaterialItem[] = [];
  const asked: DeepRequest[] = [];
  let total = null as Usage | null;
  let spentInput = 0;

  if (opts.preload.length) {
    const res = serve(opts.tools, state, opts.preload);
    material.push(`<material ronda="0">\n${res.text}\n</material>`);
    items.push(...res.items);
    asked.push(...opts.preload);
    yield { type: "reading", round: 0, items: res.items.map((i) => i.label) };
  }

  for (let round = 0; ; round++) {
    const costly: boolean = total?.costUsd != null && total.costUsd >= state.limits.costUsd;
    const canAsk: boolean = opts.deep && round < state.limits.rounds && !costly;
    const prompt: string = [
      opts.request.prompt,
      material.length && `Material que pediste:\n${material.join("\n\n")}`,
      opts.deep && !canAsk && LAST_ROUND,
    ]
      .filter(Boolean)
      .join("\n\n");
    const req: CompletionRequest = { ...opts.request, prompt };

    // Every round sends the context again: what the whole query will have read.
    const projected = estimateTokens(req.instructions.length + req.project.length + prompt.length);
    if ((round > 0 || opts.preload.length) && spentInput + projected > confirmTokens() && spentInput + projected > opts.approvedTokens) {
      yield { type: "confirm", tokens: spentInput + projected, requests: asked, items: items.map((i) => i.label) };
      return { text: null, items, rounds: round, usage: total };
    }

    let text = "";
    let shown = 0; // characters already sent to the author
    let refusal: AssistEvent | null = null;
    let truncated = false;
    const stream: AsyncGenerator<AssistEvent> = opts.provider.stream(req);
    for await (const e of stream) {
      if (e.type === "text") {
        text += e.text;
        // Held back while it could still be a request for material.
        if (canAsk && mightBeRequest(text)) continue;
        if (text.length > shown) {
          yield { type: "text", text: text.slice(shown) };
          shown = text.length;
        }
      } else if (e.type === "usage") {
        spentInput += e.input;
        await opts.onUsage(e);
        total = total
          ? {
              model: e.model,
              input: total.input + e.input,
              cached: total.cached + e.cached,
              output: total.output + e.output,
              costUsd: total.costUsd == null || e.costUsd == null ? (total.costUsd ?? e.costUsd) : total.costUsd + e.costUsd,
            }
          : { model: e.model, input: e.input, cached: e.cached, output: e.output, costUsd: e.costUsd };
      } else if (e.type === "refusal") refusal = e;
      else if (e.type === "truncated") truncated = true;
    }

    // A request for material (at the start, or after some text it then took back).
    const at = text.indexOf(REQUEST_OPEN);
    if (canAsk && at !== -1 && !refusal) {
      if (shown) yield { type: "reset" };
      const requests = parseRequests(text.slice(at)) ?? [];
      const res = requests.length ? serve(opts.tools, state, requests) : { text: "(el pedido no era JSON válido)", items: [] };
      asked.push(...requests);
      material.push(`<material ronda="${round + 1}">\n${res.text}\n</material>`);
      items.push(...res.items);
      yield { type: "reading", round: round + 1, items: res.items.length ? res.items.map((i) => i.label) : ["nada nuevo"] };
      continue;
    }

    let final = text;
    if (at !== -1) {
      // It still asked when it could not: whatever it said before the request is the answer.
      final = text.slice(0, at).trim() || "No pude completar la lectura dentro de los límites de esta consulta.";
      if (shown) yield { type: "reset" };
      yield { type: "text", text: final };
    } else if (shown < text.length) yield { type: "text", text: text.slice(shown) };
    if (total) yield { type: "usage", ...total };
    if (refusal) yield refusal;
    if (truncated) yield { type: "truncated" };
    if (items.length) yield { type: "material", rounds: round, items: items.map(({ label, tokens }) => ({ label, tokens })) };
    return { text: refusal ? null : final, items, rounds: round, usage: total };
  }
}
