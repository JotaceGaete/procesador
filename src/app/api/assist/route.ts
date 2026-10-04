import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getChapterTexts, getMemory, getNovel, getOutline } from "@/lib/supabase";
import { describeImages, protectImages } from "@/lib/manuscript";
import { HttpError, readJson } from "@/lib/http";
import { compileGuide } from "@/lib/guide";
import {
  buildManuscript,
  chapterLabel,
  estimateTokens,
  excerpts,
  manuscriptRange,
  nearbyRange,
  relevantCharacters,
  selectMemory,
  type Manuscript,
  type SelectedMemory,
} from "@/lib/ai/context";
import { EDIT_INSTRUCTIONS, WRITE_INSTRUCTIONS, editPrompt, memoryBlock, scenePrompt } from "@/lib/ai/prompts";
import { getProvider, type CompletionRequest } from "@/lib/ai/providers";
import {
  guideSection,
  manuscriptSection,
  memorySectionsFor,
  passagesSection,
  sceneTextSections,
  selectionSection,
} from "@/lib/ai/inventory";
import { recordUsage, type UsagePurpose } from "@/lib/ai/usage";
import {
  EDIT_ACTIONS,
  SCENE_LENGTHS,
  type AssistEvent,
  type ContextPart,
  type ContextSection,
  type ProviderId,
  type SceneLength,
} from "@/lib/types";

export const maxDuration = 300;

const MAX_SELECTION_CHARS = 30_000;
const MAX_ARGUMENT_CHARS = 10_000;
const SCENE_BEFORE_CHARS = 6000;
const SCENE_AFTER_CHARS = 1500;
const PREVIOUS_CHAPTER_CHARS = 3000;
const PASSAGE_BUDGET = 12_000;

/**
 * One endpoint for every AI operation. `dryRun: true` returns the size of the
 * context that would be sent, without calling any provider.
 */
export const POST = handler(async (request) => {
  const body = await readJson(request);
  const provider = getProvider(body.provider as ProviderId);
  if (!provider && !body.dryRun) throw new HttpError(400, "Ese proveedor de IA no está configurado.");

  const { novelId, purpose, sections, ...completion } = await buildRequest(body, request.signal);
  const parts = contextParts(completion);

  if (body.dryRun) {
    const total = parts.reduce((n, p) => n + p.tokens, 0);
    return NextResponse.json({
      total,
      manuscript: estimateTokens(completion.manuscript?.length ?? 0),
      parts,
      // "Ver contexto": the same request, said for the author. The rest of the total are
      // Procesador's own instructions to the model (how to write, the format).
      sections,
      instructions: Math.max(0, total - sections.reduce((n, x) => n + x.tokens, 0)),
    });
  }
  return streamResponse(provider!, completion, parts, (u) => recordUsage(novelId, purpose, body.provider as ProviderId, u));
});

/** What the request carries, in estimated tokens, so the panel can say what the AI read. */
function contextParts(c: CompletionRequest): ContextPart[] {
  const part = (label: string, s: string | null) => ({ label, tokens: estimateTokens(s?.length ?? 0) });
  return [
    part("Instrucciones", c.instructions),
    part("Guía y memoria", c.project),
    part("Texto y tarea", c.prompt),
    ...(c.manuscript ? [part("Manuscrito completo", c.manuscript)] : []),
  ];
}

type BuiltRequest = CompletionRequest & { novelId: string; purpose: UsagePurpose; sections: ContextSection[] };

async function buildRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<BuiltRequest> {
  const novel = await getNovel(String(body.novelId ?? ""));
  const outline = await getOutline(novel.id);
  const chapterIndex = outline.findIndex((c) => c.id === body.chapterId);
  if (chapterIndex === -1) throw new HttpError(404, "Capítulo no encontrado");
  const chapter = outline[chapterIndex];
  const content = typeof body.content === "string" ? body.content : "";
  const includeManuscript = body.includeManuscript === true;
  const characterIds = stringList(body.characterIds);
  const placeIds = stringList(body.placeIds);
  const chapterOrder = outline.map((c) => c.id);

  const memory = await getMemory(novel.id);
  const guide = compileGuide(novel);
  const project = (selected: SelectedMemory) =>
    [guide, memoryBlock(selected, memory, outline, chapter.id)].filter(Boolean).join("\n\n");
  const guideInventory = guideSection(novel, guide);
  const wholeNovel = async (text: string | null) =>
    text ? [manuscriptSection(text, (await manuscript()).chapters.length)] : [];

  // Other chapters are read from the database only when the request needs them.
  let ms: Manuscript | null = null;
  const manuscript = async () => (ms ??= buildManuscript(await getChapterTexts(novel.id), { id: chapter.id, content }));

  // The assistant never receives images: each marker in the text it reads becomes a
  // neutral line, applied to each piece as it is cut (offsets stay those of the real text).
  let descriptions: Map<string, string> | null = null;
  const plain = async <T extends string | null>(t: T): Promise<T> => {
    if (!t || !t.includes("[[imagen:")) return t;
    if (!descriptions) {
      const { data, error } = await db().from("manuscript_images").select("id, alt, caption, decorative").eq("novel_id", novel.id);
      if (error) throw error;
      descriptions = new Map(data.map((i) => [i.id, i.decorative ? "decorativa" : i.alt || i.caption]));
    }
    return describeImages(t, (id) => descriptions!.get(id) ?? "") as T;
  };

  if (body.mode === "scene") {
    const argument = typeof body.argument === "string" ? body.argument.trim() : "";
    if (!argument) throw new HttpError(400, "Escribe el argumento de la escena.");
    if (argument.length > MAX_ARGUMENT_CHARS) throw new HttpError(400, "El argumento es demasiado largo.");
    const cursor = clamp(Number(body.cursor), 0, content.length);
    const near = nearbyRange(content, { start: cursor, end: cursor }, SCENE_BEFORE_CHARS, SCENE_AFTER_CHARS);
    const before = await plain(content.slice(near.start, cursor));
    const after = await plain(content.slice(cursor, near.end));

    let previousChapterTail: string | null = null;
    if (before.trim().length < 1500 && chapterIndex > 0) {
      const prev = (await manuscript()).chapters[chapterIndex - 1];
      previousChapterTail = (await plain(prev.content.slice(-PREVIOUS_CHAPTER_CHARS).trim())) || null;
    }
    const length = (SCENE_LENGTHS.some((l) => l.id === body.length) ? body.length : "media") as SceneLength;
    const selected = selectMemory(memory, {
      // Who is in the scene: the chosen ones, those named in the argument and those just on stage.
      text: `${argument}\n${before.slice(-1500)}`,
      characterIds,
      placeIds,
      chapterId: chapter.id,
      chapterOrder,
    });
    const whole = includeManuscript ? await plain((await manuscript()).text) : null;
    const prev = chapterIndex > 0 ? outline[chapterIndex - 1] : null;
    const texts = sceneTextSections({
      chapterIndex,
      chapterTitle: chapter.title,
      before,
      after,
      previousChapterTail,
      previousIndex: chapterIndex - 1,
      previousTitle: prev?.title ?? "",
      argument,
    });
    const sections: ContextSection[] = [
      ...texts.text,
      guideInventory,
      ...memorySectionsFor({
        selected,
        memory,
        chapters: outline,
        currentChapterId: chapter.id,
        chosenCharacters: characterIds,
        chosenCharacterReason: "elegido en «En escena»",
        chosenPlaces: placeIds,
        sources: [
          { reason: "nombrado en el argumento", text: argument },
          { reason: "nombrado justo antes del cursor", text: before.slice(-1500) },
        ],
      }),
      texts.argument,
      ...(await wholeNovel(whole)),
    ];
    return {
      sections,
      instructions: WRITE_INSTRUCTIONS,
      manuscript: whole,
      project: project(selected),
      prompt: scenePrompt({
        argument,
        length,
        chapter: chapterLabel(chapterIndex, chapter.title),
        previousChapterTail,
        before,
        after,
      }),
      signal,
      role: "write",
      novelId: novel.id,
      purpose: "assist",
    };
  }

  // Mode A: editing a selected fragment.
  const action = EDIT_ACTIONS.find((a) => a.id === body.action);
  if (!action) throw new HttpError(400, "Acción desconocida");
  const start = clamp(Number(body.selectionStart), 0, content.length);
  const end = clamp(Number(body.selectionEnd), start, content.length);
  const selection = content.slice(start, end);
  if (!selection.trim()) throw new HttpError(400, "Selecciona un fragmento del texto.");
  if (selection.length > MAX_SELECTION_CHARS) {
    throw new HttpError(400, "La selección es demasiado larga. Trabaja con una escena o unos pocos párrafos cada vez.");
  }
  const character = memory.characters.find((c) => c.id === characterIds[0]) ?? null;
  if (action.character === "required" && !character) throw new HttpError(400, "Elige un personaje para esta acción.");

  const near = nearbyRange(content, { start, end });
  const nearText = content.slice(near.start, near.end);
  const base = { text: nearText, characterIds: character ? [character.id] : [], chapterId: chapter.id, chapterOrder };

  let selected: SelectedMemory;
  let passages: string | null = null;
  let passageList: { name: string; text: string }[] = [];
  if (action.id === "consistencia") {
    selected = selectMemory(memory, base);
  } else if (action.id === "personaje" || action.id === "evolucion") {
    selected = selectMemory(memory, { ...base, focus: true });
  } else {
    // Light edits only need who appears: no facts, places or relationships.
    selected = { ...selectMemory(memory, base), relationships: [], places: [], facts: [] };
  }

  if (!includeManuscript && !action.rewrites) {
    // Earlier passages of the people involved, from the whole novel.
    const ms = await manuscript();
    const exclude = manuscriptRange(ms, chapter.id, near);
    // The chosen character, or (for a general check) up to three people named in the selection itself.
    const who = character ? [character] : relevantCharacters(memory.characters, [], selection).slice(0, 3);
    const found = who
      .map((c) => ({ name: c.name, text: excerpts(ms, c, exclude, Math.floor(PASSAGE_BUDGET / Math.max(1, who.length))) }))
      .filter((f): f is { name: string; text: string } => Boolean(f.text));
    passageList = found;
    passages = found.length ? await plain(found.map((f) => f.text).join("\n\n---\n\n")) : null;
  }

  // Images in the selection travel as [IMAGEN n]; the panel puts the real markers back.
  const protectedSelection = protectImages(selection);
  const whole = includeManuscript ? await plain((await manuscript()).text) : null;
  const before = await plain(content.slice(near.start, start));
  const after = await plain(content.slice(end, near.end));
  const passageSection = passagesSection(passageList);
  const sections: ContextSection[] = [
    selectionSection(protectedSelection.text, before, after),
    ...(passageSection ? [passageSection] : []),
    guideInventory,
    ...memorySectionsFor({
      selected,
      memory,
      chapters: outline,
      currentChapterId: chapter.id,
      chosenCharacters: character ? [character.id] : [],
      chosenCharacterReason: "elegido en «Personaje»",
      sources: [{ reason: "nombrado en el texto", text: nearText }],
    }),
    ...(await wholeNovel(whole)),
  ];
  return {
    sections,
    instructions: EDIT_INSTRUCTIONS,
    manuscript: whole,
    project: project(selected),
    prompt: editPrompt({
      action: action.id,
      character,
      selection: protectedSelection.text,
      before,
      after,
      passages,
      images: protectedSelection.ids.length,
    }),
    signal,
    // Rewrites are the Asistente's; the analyses belong to the Consejero and use its model.
    role: action.section === "advisor" ? "advise" : "write",
    novelId: novel.id,
    purpose: action.section === "advisor" ? "advise" : "assist",
  };
}

function streamResponse(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  completion: CompletionRequest,
  parts: ContextPart[],
  onUsage: (u: Extract<AssistEvent, { type: "usage" }>) => Promise<void>,
) {
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: AssistEvent) =>
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

  const generator = provider.stream(completion);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send(controller, { type: "context", parts });
    },
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) controller.close();
        else {
          if (value.type === "usage") await onUsage(value);
          send(controller, value);
        }
      } catch (e) {
        if (!completion.signal.aborted) {
          console.error("[assist]", e instanceof Error ? e.message : e);
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(Number.isFinite(n) ? n : 0, max));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
}
