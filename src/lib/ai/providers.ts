import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AIRole, AssistEvent, ProviderId } from "../types";
import { costUsd, modelFor } from "./models";

/**
 * What every provider receives. The editor tools build this without knowing
 * which provider will answer; each provider maps it to its own API.
 */
export interface CompletionRequest {
  /** Mode instructions (edit or write): identical on every request of that mode. */
  instructions: string;
  /** Full manuscript, only when the author asks for it. Kept as its own block so it can be cached. */
  manuscript: string | null;
  /** Guía Maestra and the narrative memory relevant to this request. */
  project: string;
  /** Passages, nearby text, selection or argument, and the task. */
  prompt: string;
  signal: AbortSignal;
  /** Which configured model answers: writing (default), advice or the cheaper analysis one. */
  role?: AIRole;
  /** Output cap (default 16000). Quick advice is short. */
  maxOutputTokens?: number;
  /** `project` is a stable frame reused across requests: cache it where the API allows. */
  cacheProject?: boolean;
}

type ProviderEvent = Exclude<AssistEvent, { type: "error" } | { type: "context" } | { type: "plan" } | { type: "observations" }>;

/** The usage event every provider yields once, before a refusal or truncation. */
function usage(model: string, input: number, cached: number, output: number): ProviderEvent {
  return { type: "usage", model, input, cached, output, costUsd: costUsd(model, input, cached, output) };
}

interface Provider {
  configured(): boolean;
  stream(req: CompletionRequest): AsyncGenerator<ProviderEvent>;
  /** Turns a thrown error into a short message for the author. */
  describeError(e: unknown): string;
}

const providers: Record<ProviderId, Provider> = {
  anthropic: {
    configured: () => Boolean(process.env.ANTHROPIC_API_KEY),
    stream: streamAnthropic,
    describeError(e) {
      if (e instanceof Anthropic.AuthenticationError) return "La API key de Anthropic no es válida.";
      if (e instanceof Anthropic.RateLimitError) return "Claude: límite de uso alcanzado. Espera un momento y reintenta.";
      if (e instanceof Anthropic.APIConnectionError) return "No se pudo conectar con Claude.";
      if (e instanceof Anthropic.APIError) return `Claude respondió con un error (${e.status ?? "sin código"}).`;
      return "Error inesperado al llamar a Claude.";
    },
  },
  openai: {
    configured: () => Boolean(process.env.OPENAI_API_KEY),
    stream: streamOpenAI,
    describeError(e) {
      if (e instanceof OpenAI.AuthenticationError) return "La API key de OpenAI no es válida.";
      if (e instanceof OpenAI.RateLimitError) return "GPT: límite de uso alcanzado. Espera un momento y reintenta.";
      if (e instanceof OpenAI.APIConnectionError) return "No se pudo conectar con OpenAI.";
      if (e instanceof OpenAI.APIError) return `OpenAI respondió con un error (${e.status ?? "sin código"}).`;
      return e instanceof OpenAIStreamError ? e.message : "Error inesperado al llamar a GPT.";
    },
  },
  xai: {
    configured: () => Boolean(process.env.XAI_API_KEY),
    stream: streamXai,
    describeError(e) {
      return e instanceof XaiError ? e.message : "Error inesperado al llamar a Grok.";
    },
  },
};

export function availableProviders(): ProviderId[] {
  return (Object.keys(providers) as ProviderId[]).filter((id) => providers[id].configured());
}

export function defaultProvider(): ProviderId | null {
  const available = availableProviders();
  const preferred = process.env.AI_PROVIDER as ProviderId | undefined;
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

export function getProvider(id: ProviderId): Provider | null {
  return providers[id]?.configured() ? providers[id] : null;
}

// ---------- Claude ----------

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
let anthropic: Anthropic | null = null;

async function* streamAnthropic(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
  anthropic ??= new Anthropic();
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: req.instructions }];
  if (req.manuscript) {
    // The manuscript is the large, stable part: cache it so several analyses
    // in a row over the same text are billed at the cached rate.
    system.push({ type: "text", text: req.manuscript, cache_control: { type: "ephemeral" } });
  }
  if (req.project) {
    system.push(
      req.cacheProject
        ? { type: "text", text: req.project, cache_control: { type: "ephemeral" } }
        : { type: "text", text: req.project },
    );
  }

  const model = modelFor("anthropic", req.role);
  const stream = anthropic.messages.stream(
    {
      model,
      max_tokens: req.maxOutputTokens ?? 16000,
      output_config: { effort: (process.env.ANTHROPIC_EFFORT as Effort) || "medium" },
      system,
      messages: [{ role: "user", content: req.prompt }],
    },
    { signal: req.signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text", text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  const u = final.usage;
  // Anthropic counts cache reads and writes apart from input_tokens; the total input is their sum.
  const cached = u.cache_read_input_tokens ?? 0;
  yield usage(model, u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0), cached, u.output_tokens);
  if (final.stop_reason === "refusal") {
    yield { type: "refusal", message: "Claude no respondió a esta solicitud." };
  } else if (final.stop_reason === "max_tokens") {
    yield { type: "truncated" };
  }
}

// ---------- GPT (OpenAI Responses API) ----------

class OpenAIStreamError extends Error {}
let openai: OpenAI | null = null;

async function* streamOpenAI(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
  openai ??= new OpenAI();
  const model = modelFor("openai", req.role);
  const stream = await openai.responses.create(
    {
      model,
      instructions: [req.instructions, req.manuscript, req.project].filter(Boolean).join("\n\n"),
      input: req.prompt,
      max_output_tokens: req.maxOutputTokens ?? 16000,
      stream: true,
    },
    { signal: req.signal },
  );

  let refused = false;
  let truncated = false;
  let used: ProviderEvent | null = null;
  for await (const event of stream) {
    if ((event.type === "response.completed" || event.type === "response.incomplete") && event.response.usage) {
      const u = event.response.usage;
      used = usage(model, u.input_tokens, u.input_tokens_details?.cached_tokens ?? 0, u.output_tokens);
    }
    if (event.type === "response.output_text.delta") yield { type: "text", text: event.delta };
    else if (event.type === "response.refusal.delta") refused = true;
    else if (event.type === "response.incomplete") {
      const reason = event.response.incomplete_details?.reason;
      if (reason === "content_filter") refused = true;
      else if (reason === "max_output_tokens") truncated = true;
    } else if (event.type === "response.failed" || event.type === "error") {
      throw new OpenAIStreamError("GPT no pudo completar la respuesta.");
    }
  }
  if (used) yield used;
  if (refused) yield { type: "refusal", message: "GPT no respondió a esta solicitud." };
  else if (truncated) yield { type: "truncated" };
}

// ---------- Grok (xAI, Chat Completions-style REST API) ----------

class XaiError extends Error {}

async function* streamXai(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
  const model = modelFor("xai", req.role);
  const system = [req.instructions, req.manuscript, req.project].filter(Boolean).join("\n\n");
  let res: Response;
  try {
    res = await fetch(`${process.env.XAI_BASE_URL || "https://api.x.ai/v1"}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.XAI_API_KEY}` },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxOutputTokens ?? 16000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.prompt },
        ],
      }),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new XaiError("No se pudo conectar con Grok.");
  }
  if (!res.ok || !res.body) {
    const reason =
      res.status === 401 || res.status === 403
        ? "la API key de xAI no es válida"
        : res.status === 429
          ? "límite de uso alcanzado"
          : `error ${res.status}`;
    throw new XaiError(`Grok: ${reason}.`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finish: string | null = null;
  let used: ProviderEvent | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new XaiError("Grok devolvió un error durante la respuesta.");
      if (chunk.usage) {
        const u = chunk.usage;
        used = usage(model, u.prompt_tokens ?? 0, u.prompt_tokens_details?.cached_tokens ?? 0, u.completion_tokens ?? 0);
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) yield { type: "text", text: choice.delta.content };
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }

  if (used) yield used;
  if (finish === "content_filter") yield { type: "refusal", message: "Grok no respondió a esta solicitud." };
  else if (finish === "length") yield { type: "truncated" };
}
