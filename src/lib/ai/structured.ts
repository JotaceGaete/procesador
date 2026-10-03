import "server-only";
import { HttpError } from "../http";
import type { Usage } from "../types";
import { getProvider, type CompletionRequest } from "./providers";

/**
 * Structured output (docs/consejero.md §7): the model answers with JSON, and the
 * server always validates it with the same rules before using it. If it isn't valid,
 * one retry telling the model what was wrong; if that fails too, an error instead of
 * storing garbage. Validated here for every provider, so "Probar con" keeps working.
 */

export class InvalidOutput extends Error {}

/** The JSON object in a reply, with or without ``` fences or text around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new InvalidOutput("La respuesta no contiene un objeto JSON.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new InvalidOutput(`JSON mal formado: ${(e as Error).message}`);
  }
}

export async function completeJson<T>(
  providerId: Parameters<typeof getProvider>[0],
  req: CompletionRequest,
  validate: (raw: unknown) => T,
  onUsage: (u: Usage) => Promise<void>,
): Promise<{ value: T; model: string }> {
  const provider = getProvider(providerId);
  if (!provider) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  let prompt = req.prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    let model = "";
    let refusal: string | null = null;
    let truncated = false;
    try {
      for await (const event of provider.stream({ ...req, prompt })) {
        if (event.type === "text") text += event.text;
        else if (event.type === "usage") {
          model = event.model;
          await onUsage(event);
        } else if (event.type === "refusal") refusal = event.message;
        else if (event.type === "truncated") truncated = true;
      }
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw new HttpError(502, provider.describeError(e));
    }
    if (refusal) throw new HttpError(422, refusal);
    try {
      if (truncated) throw new InvalidOutput("La respuesta se cortó por longitud.");
      return { value: validate(extractJson(text)), model };
    } catch (e) {
      if (!(e instanceof InvalidOutput)) throw e;
      if (attempt === 1) throw new HttpError(502, `La IA no devolvió una respuesta válida (${e.message}). No se guardó nada.`);
      prompt = `${req.prompt}\n\nTu respuesta anterior no era válida: ${e.message}\nResponde de nuevo sólo con el objeto JSON pedido, sin texto alrededor.`;
    }
  }
  throw new Error("unreachable");
}
