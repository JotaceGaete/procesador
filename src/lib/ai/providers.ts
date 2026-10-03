import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderId } from "../types";

export interface CompletionRequest {
  /** Instrucciones fijas: nunca cambian, primera parte del prefijo cacheable. */
  instructions: string;
  /** Proyecto, personajes y manuscrito: cambia cuando escribes. */
  context: string;
  prompt: string;
}

export function availableProviders(): ProviderId[] {
  const list: ProviderId[] = [];
  if (process.env.ANTHROPIC_API_KEY) list.push("anthropic");
  if (process.env.XAI_API_KEY) list.push("xai");
  return list;
}

export function defaultProvider(): ProviderId | null {
  const available = availableProviders();
  const preferred = process.env.AI_PROVIDER as ProviderId | undefined;
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

export function streamCompletion(provider: ProviderId, req: CompletionRequest): AsyncGenerator<string> {
  return provider === "xai" ? streamXai(req) : streamAnthropic(req);
}

let anthropic: Anthropic | null = null;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

async function* streamAnthropic(req: CompletionRequest): AsyncGenerator<string> {
  anthropic ??= new Anthropic();
  const stream = anthropic.beta.messages.stream({
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    max_tokens: 64000,
    output_config: { effort: (process.env.ANTHROPIC_EFFORT as Effort) || "medium" },
    // If a safety classifier declines, the API re-runs the request on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: req.instructions },
      // Cache breakpoint after the manuscript: repeated analyses on unchanged text reuse it.
      { type: "text", text: req.context, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: req.prompt }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    const why = final.stop_details?.explanation;
    yield `\n\n> ⚠️ El modelo rechazó esta petición${why ? `: ${why}` : "."} Prueba reformular la selección o cambiar de proveedor.`;
  } else if (final.stop_reason === "max_tokens") {
    yield "\n\n> ⚠️ Respuesta cortada por longitud.";
  }
}

// xAI exposes a Chat Completions-style REST API.
async function* streamXai(req: CompletionRequest): AsyncGenerator<string> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.XAI_MODEL || "grok-4",
      stream: true,
      messages: [
        { role: "system", content: `${req.instructions}\n\n${req.context}` },
        { role: "user", content: req.prompt },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`xAI respondió ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) yield delta as string;
    }
  }
}
