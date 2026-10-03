import Anthropic from "@anthropic-ai/sdk";
import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse } from "@/lib/http";
import { BASE_INSTRUCTIONS, projectContext, taskPrompt } from "@/lib/ai/prompts";
import { availableProviders, streamCompletion } from "@/lib/ai/providers";
import { ACTIONS, type AnalysisAction, type Character, type ProviderId } from "@/lib/types";

export const maxDuration = 300;

const CONTEXT_CHARS = 1500;

interface AnalyzeBody {
  action: AnalysisAction;
  characterId?: string | null;
  content: string;
  selectionStart: number;
  selectionEnd: number;
  includeManuscript?: boolean;
  provider: ProviderId;
}

export async function POST(request: Request) {
  let body: AnalyzeBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new Error("JSON inválido"), 400);
  }

  const action = ACTIONS.find((a) => a.id === body.action);
  if (!action) return errorResponse(new Error("Acción desconocida"), 400);
  if (!availableProviders().includes(body.provider)) {
    return errorResponse(new Error(`Proveedor "${body.provider}" no configurado`), 400);
  }

  const content = typeof body.content === "string" ? body.content : "";
  const start = Math.max(0, Math.min(body.selectionStart, content.length));
  const end = Math.max(start, Math.min(body.selectionEnd, content.length));
  const selection = content.slice(start, end);
  if (!selection.trim()) return errorResponse(new Error("Selecciona un fragmento del texto."), 400);

  let characters: Character[];
  let project;
  try {
    project = await getActiveProject();
    const { data, error } = await db().from("characters").select("*").eq("project_id", project.id).order("created_at");
    if (error) throw error;
    characters = data as Character[];
  } catch (e) {
    return errorResponse(e);
  }

  const character = body.characterId ? (characters.find((c) => c.id === body.characterId) ?? null) : null;
  if (action.needsCharacter && !character) {
    return errorResponse(new Error("Elige un personaje para esta acción."), 400);
  }

  const generator = streamCompletion(body.provider, {
    instructions: BASE_INSTRUCTIONS,
    context: projectContext(project, characters, body.includeManuscript === false ? null : content),
    prompt: taskPrompt({
      action: action.id,
      character,
      selection,
      before: content.slice(Math.max(0, start - CONTEXT_CHARS), start),
      after: content.slice(end, end + CONTEXT_CHARS),
    }),
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n> ❌ Error: ${describeError(e)}`));
        controller.close();
      }
    },
    async cancel() {
      await generator.return(undefined);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "API key de Anthropic inválida.";
  if (e instanceof Anthropic.RateLimitError) return "Límite de uso alcanzado; espera un momento y reintenta.";
  if (e instanceof Anthropic.APIError) return `API de Anthropic (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
