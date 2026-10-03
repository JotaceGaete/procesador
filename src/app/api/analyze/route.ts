import { db, getActiveProject } from "@/lib/supabase";
import { errorResponse, HttpError, readJson } from "@/lib/http";
import { requireAuth } from "@/lib/auth";
import { characterExcerpts, nearbyRange, relevantCharacters } from "@/lib/ai/context";
import { BASE_INSTRUCTIONS, manuscriptBlock, projectBlock, taskPrompt } from "@/lib/ai/prompts";
import { getProvider } from "@/lib/ai/providers";
import { ACTIONS, type AnalysisEvent, type Character, type ProviderId } from "@/lib/types";

export const maxDuration = 300;

const MAX_SELECTION_CHARS = 30_000;

export async function POST(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  let req;
  try {
    req = await buildRequest(request);
  } catch (e) {
    return errorResponse(e);
  }

  const { provider, ...completion } = req;
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: AnalysisEvent) =>
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

  const generator = provider.stream(completion);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) controller.close();
        else send(controller, value);
      } catch (e) {
        if (!completion.signal.aborted) {
          console.error("[analyze]", e instanceof Error ? e.message : e);
          send(controller, { type: "error", message: provider.describeError(e) });
        }
        controller.close();
      }
    },
    async cancel() {
      // The author pressed "Detener" or closed the tab: stop the upstream call so it stops billing.
      await generator.return(undefined);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function buildRequest(request: Request) {
  const body = await readJson(request);

  const action = ACTIONS.find((a) => a.id === body.action);
  if (!action) throw new HttpError(400, "Acción desconocida");
  const provider = getProvider(body.provider as ProviderId);
  if (!provider) throw new HttpError(400, "Ese proveedor de IA no está configurado.");

  const content = typeof body.content === "string" ? body.content : "";
  const start = Math.max(0, Math.min(Number(body.selectionStart) || 0, content.length));
  const end = Math.max(start, Math.min(Number(body.selectionEnd) || 0, content.length));
  const selection = content.slice(start, end);
  if (!selection.trim()) throw new HttpError(400, "Selecciona un fragmento del texto.");
  if (selection.length > MAX_SELECTION_CHARS) {
    throw new HttpError(400, "La selección es demasiado larga. Analiza una escena o unos pocos párrafos cada vez.");
  }

  const project = await getActiveProject("id, title, synopsis, style_notes");
  const { data, error } = await db().from("characters").select("*").eq("project_id", project.id).order("created_at");
  if (error) throw error;
  const characters = data as Character[];

  const character = typeof body.characterId === "string" ? (characters.find((c) => c.id === body.characterId) ?? null) : null;
  if (action.character === "required" && !character) throw new HttpError(400, "Elige un personaje para esta acción.");

  const nearby = nearbyRange(content, { start, end });
  const includeManuscript = body.includeManuscript === true;

  return {
    provider,
    instructions: BASE_INSTRUCTIONS,
    manuscript: includeManuscript ? manuscriptBlock(content) : null,
    project: projectBlock(
      project,
      relevantCharacters(characters, character, content.slice(nearby.start, nearby.end)),
      characters.length,
    ),
    prompt: taskPrompt({
      action: action.id,
      character,
      selection,
      before: content.slice(nearby.start, start),
      after: content.slice(end, nearby.end),
      // With the full manuscript included the excerpts would be redundant.
      excerpts:
        character && !includeManuscript && action.character === "required" ? characterExcerpts(content, character, nearby) : null,
    }),
    signal: request.signal,
  };
}
