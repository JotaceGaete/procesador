import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { db, getChapterTexts, getScopedMemory, getNovel, readingOutline } from "@/lib/supabase";
import { countWords, forModel, protectImages, separatorsForModel } from "@/lib/manuscript";
import { HttpError, readJson } from "@/lib/http";
import { briefBlock, parseBrief } from "@/lib/advisor/converse";
import { checkContinuity, currentScene, type ContinuityInput, type ContinuityWarning } from "@/lib/continuity";
import { compileGuide } from "@/lib/guide";
import {
  buildManuscript,
  chapterLabel,
  estimateTokens,
  excerpts,
  manuscriptRange,
  nameMatcher,
  nearbyRange,
  relevantCharacters,
  selectMemory,
  type Manuscript,
  type SelectedMemory,
} from "@/lib/ai/context";
import {
  EDIT_INSTRUCTIONS,
  RESERVE_NOTE,
  RESERVE_NOTICE,
  SCENE_PROVIDER_NOTES,
  editPrompt,
  memoryBlock,
  type StoryTime,
  scenePrompt,
  writeInstructions,
} from "@/lib/ai/prompts";
import { getProvider, type CompletionRequest } from "@/lib/ai/providers";
import {
  draftSection,
  guideSection,
  manuscriptSection,
  storyManuscriptSection,
  memorySectionsFor,
  passagesSection,
  sceneTextSections,
  selectionSection,
} from "@/lib/ai/inventory";
import { recordUsage, type UsagePurpose } from "@/lib/ai/usage";
import { storySoFar } from "@/lib/ai/story";
import { novelChronology } from "@/lib/chronology-server";
import { describeAge, formatPoint } from "@/lib/chronology";
import { chapterRows, digestRows, novelDigestFresh, novelDigestRow, threadRows } from "@/lib/advisor/reading";
import {
  EDIT_ACTIONS,
  SCENE_LENGTHS,
  type AssistEvent,
  type Character,
  type ContextInventory,
  type ContextPart,
  type ContextSection,
  type ProviderId,
  type SceneLength,
} from "@/lib/types";

export const maxDuration = 300;

const MAX_SELECTION_CHARS = 30_000;
const MAX_ARGUMENT_CHARS = 10_000;
/** «Revisar escena»: the changes the author approved, from the Consejero or their own. */
const MAX_NOTES_CHARS = 8_000;
const SCENE_BEFORE_CHARS = 6000;
const SCENE_AFTER_CHARS = 1500;
const PREVIOUS_CHAPTER_CHARS = 3000;
const PASSAGE_BUDGET = 12_000;
/** The current chapter before the text around the cursor: up to ~6.000 tokens. */
const EARLIER_CHARS = 21_000;
/** "Early in a chapter": the first ~1.500 words, where a scene goes on from the previous chapter. */
const EARLY_IN_CHAPTER_CHARS = 9000;
/** Where the scene goes, inside the whole novel when it is sent. */
const SCENE_MARK = "⟦AQUÍ VA LA ESCENA NUEVA⟧";

/**
 * One endpoint for every AI operation. `dryRun: true` returns the size of the
 * context that would be sent, without calling any provider.
 */
export const POST = handler(async (request) => {
  const body = await readJson(request);
  const provider = getProvider(body.provider as ProviderId);
  if (!provider && !body.dryRun) throw new HttpError(400, "Ese proveedor de IA no está configurado.");

  const { novelId, purpose, sections, notices, ...completion } = await buildRequest(body, request.signal);
  const parts = contextParts(completion);
  const total = parts.reduce((n, p) => n + p.tokens, 0);
  // "Ver contexto": the request, said for the author. The rest of the total are Procesador's
  // own instructions to the model (how to write, the format). The real request sends the
  // same inventory first, so what was actually sent can be checked afterwards.
  const inventory = {
    total,
    manuscript: estimateTokens(completion.manuscript?.length ?? 0),
    parts,
    sections,
    notices,
    instructions: Math.max(0, total - sections.reduce((n, x) => n + x.tokens, 0)),
  };

  if (body.dryRun) return NextResponse.json(inventory);
  return streamResponse(provider!, completion, inventory, (u) => recordUsage(novelId, purpose, body.provider as ProviderId, u));
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

type BuiltRequest = CompletionRequest & {
  novelId: string;
  purpose: UsagePurpose;
  sections: ContextSection[];
  /** What the author should know about the context (chapters without a digest…). */
  notices: string[];
  /** The automatic continuity check of the answer (scenes and rewrites): no AI, run at the end. */
  continuity?: (output: string) => ContinuityWarning[];
};

/** The proposal inside the answer (<escena> or <reescritura>), as the panel will show it. */
function proposalOf(output: string, tag: "escena" | "reescritura"): string {
  const m = output.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`));
  return m ? m[1].trim() : "";
}

async function buildRequest(body: Record<string, unknown>, signal: AbortSignal): Promise<BuiltRequest> {
  const novel = await getNovel(String(body.novelId ?? ""));
  // What the AI may read (docs/capitulos-reserva.md): the manuscript and, if the open chapter
  // is in reserve, that one after it. Never another chapter in reserve.
  const open = typeof body.chapterId === "string" ? body.chapterId : null;
  const outline = await readingOutline(novel.id, open);
  const chapterIndex = outline.findIndex((c) => c.id === body.chapterId);
  if (chapterIndex === -1) throw new HttpError(404, "Capítulo no encontrado");
  const chapter = outline[chapterIndex];
  // A chapter in reserve has no place in the story yet: the manuscript is its background, not
  // what comes right before it (no previous chapter's ending, no one carried over from it).
  const reserved = chapter.reserved;
  const content = typeof body.content === "string" ? body.content : "";
  const includeManuscript = body.includeManuscript === true;
  const characterIds = stringList(body.characterIds);
  const placeIds = stringList(body.placeIds);
  const chapterOrder = outline.map((c) => c.id);

  const memory = await getScopedMemory(novel.id, chapter.id);
  const guide = compileGuide(novel);
  // Cronología (docs/cronologia-edades.md): the time at this chapter and each character's age,
  // computed from marks up to here (nothing of later chapters is said).
  const chron = await novelChronology(novel, { memory, chapters: outline });
  const point = chron.result.points[chapterIndex];
  const time: StoryTime = {
    now: chron.marks.length ? formatPoint(point, novel.calendar) : null,
    estimated: point.estimated,
    ages: new Map(
      memory.characters
        .map((c) => [c.id, describeAge(c, chron.result.ages.get(c.id)?.[chapterIndex] ?? null, outline, novel.calendar)] as const)
        .filter((x): x is readonly [string, string] => Boolean(x[1])),
    ),
  };
  // Continuidad (no AI): the Memoria and each character's age at this point of the story.
  const continuityBase = (): Pick<ContinuityInput, "characters" | "places" | "ages" | "relationships"> => ({
    characters: memory.characters,
    places: memory.places,
    relationships: memory.relationships.flatMap((r) => {
      const from = memory.characters.find((c) => c.id === r.from_id);
      const to = memory.characters.find((c) => c.id === r.to_id);
      return from && to ? [{ from, to, kind: r.kind }] : [];
    }),
    ages: memory.characters.flatMap((c) => {
      const a = chron.marks.length ? chron.result.ages.get(c.id)?.[chapterIndex] : null;
      return a ? [{ name: c.name, aliases: c.aliases, min: a.min, max: a.max, approx: a.approx }] : [];
    }),
  });
  const project = (selected: SelectedMemory) =>
    [guide, reserved ? RESERVE_NOTE : "", memoryBlock(selected, memory, outline, chapter.id, time)].filter(Boolean).join("\n\n");
  const guideInventory = guideSection(novel, guide);
  const wholeNovel = async (text: string | null) =>
    text ? [manuscriptSection(text, (await manuscript()).chapters.length)] : [];

  // Other chapters are read from the database only when the request needs them.
  let ms: Manuscript | null = null;
  const manuscript = async () => (ms ??= buildManuscript(await getChapterTexts(novel.id, chapter.id), { id: chapter.id, content }));

  // The assistant never receives images or markers: each image becomes a neutral line and
  // each separator `* * *`, applied to each piece as it is cut (offsets stay those of the real text).
  let descriptions: Map<string, string> | null = null;
  const plain = async <T extends string | null>(t: T): Promise<T> => {
    if (!t || !t.includes("[[imagen:")) return (t && separatorsForModel(t)) as T;
    if (!descriptions) {
      const { data, error } = await db().from("manuscript_images").select("id, alt, caption, decorative").eq("novel_id", novel.id);
      if (error) throw error;
      descriptions = new Map(data.map((i) => [i.id, i.decorative ? "decorativa" : i.alt || i.caption]));
    }
    return forModel(t, (id) => descriptions!.get(id) ?? "") as T;
  };

  if (body.mode === "scene") {
    const argument = typeof body.argument === "string" ? body.argument.trim() : "";
    if (!argument) throw new HttpError(400, "Escribe el argumento de la escena.");
    if (argument.length > MAX_ARGUMENT_CHARS) throw new HttpError(400, "El argumento es demasiado largo.");
    const cursor = clamp(Number(body.cursor), 0, content.length);
    const near = nearbyRange(content, { start: cursor, end: cursor }, SCENE_BEFORE_CHARS, SCENE_AFTER_CHARS);
    const before = await plain(content.slice(near.start, cursor));
    const after = await plain(content.slice(cursor, near.end));
    const length = (SCENE_LENGTHS.some((l) => l.id === body.length) ? body.length : "media") as SceneLength;
    // "Ampliar": the scene the model already wrote, to develop with the same context.
    const draft = typeof body.expand === "string" && body.expand.trim() ? body.expand : null;
    // «Enviar al Asistente»: the brief the author reviewed in the Consejero (optional).
    let brief: string | null = null;
    if (body.brief != null) {
      try {
        const b = parseBrief({ ...(body.brief as object), argument }, {
          characters: memory.characters.map((c) => c.id),
          places: memory.places.map((p) => p.id),
        });
        brief = briefBlock(b) || null;
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (draft && draft.length > MAX_SELECTION_CHARS) throw new HttpError(400, "La escena es demasiado larga para ampliarla.");

    // The Consejero's reading of the novel, as far as this point (docs/asistente-contexto.md).
    const [rows, digests, threads, global] = await Promise.all([
      chapterRows(novel.id, chapter.id),
      digestRows(novel.id, chapter.id),
      threadRows(novel.id, chapter.id),
      novelDigestRow(novel.id),
    ]);

    // Who is in the scene: the chosen ones, those named in the argument or in the text before the
    // cursor, and, early in a chapter, those on stage in the previous one (the scene goes on from there).
    const previousDigest = chapterIndex > 0 && !reserved ? digests.find((d) => d.chapter_id === outline[chapterIndex - 1].id) : null;
    const continuing =
      previousDigest && cursor <= EARLY_IN_CHAPTER_CHARS
        ? previousDigest.presence
            .filter((p) => p.kind === "present" && !characterIds.includes(p.character) && memory.characters.some((c) => c.id === p.character))
            .map((p) => p.character)
        : [];
    // Temporal ignorance: nothing of later chapters (docs/asistente-contexto.md).
    const picked = selectMemory(memory, {
      text: `${argument}\n${before}`,
      characterIds: [...characterIds, ...continuing],
      placeIds,
      chapterId: chapter.id,
      chapterOrder,
      noLaterThan: chapter.id,
    });
    // Relationships of the people chosen in "En escena" go with anyone (the other one only by name).
    const chosen = new Set(characterIds);
    const extra = memory.relationships.filter(
      (r) => (chosen.has(r.from_id) || chosen.has(r.to_id)) && !picked.relationships.some((x) => x.id === r.id),
    );
    // Listed (and sent) in order: chosen, named, then those carried over from the previous chapter.
    const named = (c: Character) => Boolean(nameMatcher(c)?.test(`${argument}\n${before}`));
    const rank = (c: Character) => (chosen.has(c.id) ? 0 : continuing.includes(c.id) && !named(c) ? 2 : 1);
    const characters = [...picked.characters].sort((a, b) => rank(a) - rank(b));
    const selected: SelectedMemory = { ...picked, characters, relationships: [...picked.relationships, ...extra] };

    const story = storySoFar({
      chapters: rows,
      currentIndex: chapterIndex,
      liveContent: content,
      cursor,
      digests,
      threads,
      global,
      globalCurrent: global ? novelDigestFresh(global, digests) : false,
      // The global summary tells the whole novel: only when nothing comes after what the request shows.
      atEnd: near.end >= content.length && rows.slice(chapterIndex + 1).every((c) => !c.content.trim()),
      characters: selected.characters,
      names: new Map(memory.characters.map((c) => [c.id, c.name])),
      includeManuscript,
    });

    // «Leer toda la historia hasta aquí»: the previous chapters and this one up to the cursor,
    // where the mark goes. Never a later chapter, never the text after the cursor: the model
    // can't give away what the reader will only learn later. Without it, the chapter from its
    // start, the text around the cursor, and the end of the previous one when the scene opens
    // a chapter.
    let whole: string | null = null;
    let earlier: string | null = null;
    let earlierOmitted = 0;
    let previousChapterTail: string | null = null;
    if (includeManuscript) {
      const full = await manuscript();
      const story = full.chapters.slice(0, chapterIndex + 1);
      const marked = `${content.slice(0, cursor).trimEnd()}\n\n${SCENE_MARK}`;
      whole = await plain(buildManuscript(story, { id: chapter.id, content: marked }).text);
    } else {
      const head = content.slice(0, near.start);
      if (head.trim()) {
        if (head.length <= EARLIER_CHARS) earlier = await plain(head);
        else {
          // The beginning of the chapter, cut at a paragraph; the middle is left out, said so.
          const cut = head.lastIndexOf("\n", EARLIER_CHARS);
          const end = cut > EARLIER_CHARS / 2 ? cut : EARLIER_CHARS;
          earlier = await plain(head.slice(0, end));
          earlierOmitted = countWords(head.slice(end));
        }
      }
      if (before.trim().length < 1500 && !earlier && chapterIndex > 0 && !reserved) {
        const prev = (await manuscript()).chapters[chapterIndex - 1];
        previousChapterTail = (await plain(prev.content.slice(-PREVIOUS_CHAPTER_CHARS).trim())) || null;
      }
    }

    const prev = chapterIndex > 0 ? outline[chapterIndex - 1] : null;
    const texts = sceneTextSections({
      chapterIndex,
      chapterTitle: chapter.title,
      chapterReserved: reserved,
      before,
      after,
      earlier,
      earlierOmitted,
      inManuscript: includeManuscript,
      previousChapterTail,
      previousIndex: chapterIndex - 1,
      previousTitle: prev?.title ?? "",
      argument,
    });
    const memorySections = memorySectionsFor({
      selected,
      memory,
      chapters: outline,
      currentChapterId: chapter.id,
      chosenCharacters: characterIds,
      chosenCharacterReason: "elegido en «En escena»",
      chosenPlaces: placeIds,
      sources: [
        { reason: "nombrado en el argumento", text: argument },
        { reason: "nombrado en el texto anterior", text: before },
      ],
      extraReasons: new Map(continuing.map((id) => [id, "en escena en el capítulo anterior"])),
      time,
    });
    const kind = (id: string) => memorySections.filter((x) => x.id === id);
    const sections: ContextSection[] = [
      ...texts.text,
      ...(story.sections.story ? [story.sections.story] : []),
      guideInventory,
      ...kind("time"),
      ...kind("characters"),
      ...(story.sections.knowledge ? [story.sections.knowledge] : []),
      ...kind("places"),
      ...kind("relationships"),
      ...kind("facts"),
      ...(story.sections.threads ? [story.sections.threads] : []),
      brief
        ? {
            ...texts.argument,
            tokens: texts.argument.tokens + estimateTokens(brief.length),
            items: [...texts.argument.items, { label: "Encargo del Consejero", detail: brief.slice(0, 400) }],
          }
        : texts.argument,
      ...(draft ? [draftSection(draft)] : []),
      ...(whole ? [storyManuscriptSection(whole, chapterIndex, reserved)] : []),
    ];
    const later = picked.later
      ? [
          `${picked.later === 1 ? "1 hecho de un capítulo posterior no se envía" : `${picked.later} hechos de capítulos posteriores no se envían`}: la escena no puede saber lo que aún no ha ocurrido.`,
        ]
      : [];
    return {
      sections,
      notices: [...(reserved ? [RESERVE_NOTICE] : []), ...story.notices, ...later],
      // The common base, plus the provider's own block (only Grok has one).
      instructions: writeInstructions(body.provider as ProviderId),
      manuscript: whole,
      project: project(selected),
      prompt: scenePrompt({
        argument,
        length,
        chapter: chapterLabel(chapterIndex, chapter.title, reserved),
        previousChapterTail,
        earlier,
        earlierOmitted,
        before: includeManuscript ? "" : before,
        after: includeManuscript ? "" : after,
        mark: includeManuscript ? SCENE_MARK : null,
        story: story.story,
        knowledge: story.knowledge,
        threads: story.threads,
        providerNote: SCENE_PROVIDER_NOTES[body.provider as ProviderId] ?? null,
        draft,
        brief,
        confirmedChange: body.confirmChange === true,
      }),
      continuity: (output) => {
        const chosen = memory.places.find((p) => placeIds.includes(p.id)) ?? null;
        return checkContinuity({
          ...continuityBase(),
          proposal: proposalOf(output, "escena"),
          before: currentScene(content.slice(0, cursor)),
          given: `${argument}\n${brief ?? ""}`,
          place: chosen,
        });
      },
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
  if (action.id === "consistencia" || action.id === "revisar") {
    // Revisar escena keeps what the scene established: who knows whom, places, facts.
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

  // Images in the selection travel as [IMAGEN n] and separators as `* * *`; the panel puts
  // the real markers back (restoreImages, fromModel).
  const images = protectImages(selection);
  const protectedSelection = { ...images, text: separatorsForModel(images.text) };
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
      time,
    }),
    ...(await wholeNovel(whole)),
  ];
  // Checking a character or the continuity: the time warnings about the people involved
  // (warnings, never errors: the model is told they may be on purpose).
  let timeWarnings: string[] = [];
  if (action.id === "consistencia" || action.id === "personaje") {
    const involved = new Set(selected.characters.map((c) => c.id));
    const full = await novelChronology(novel, { memory, chapters: (await manuscript()).chapters });
    const dismissed = novel.dismissed_warnings ?? {};
    timeWarnings = full.result.warnings
      .filter((w) => dismissed[w.key] !== w.fingerprint && w.characterIds.some((id) => involved.has(id)))
      .map((w) => w.message);
    if (timeWarnings.length) {
      const items = timeWarnings.map((label) => ({ label }));
      const existing = sections.find((s) => s.id === "time");
      if (existing) existing.items.push(...items);
      else sections.splice(3, 0, { id: "time", label: "Advertencias de cronología", tokens: estimateTokens(timeWarnings.join("\n").length), items });
    }
  }
  return {
    sections,
    notices: reserved ? [RESERVE_NOTICE] : [],
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
      timeWarnings,
      notes: action.id === "revisar" && typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_CHARS) : null,
    }),
    signal,
    // A rewrite keeps what the fragment established (clothes, names, ages); analyses are not checked.
    continuity:
      action.section === "advisor"
        ? undefined
        : (output) => checkContinuity({ ...continuityBase(), proposal: proposalOf(output, "reescritura"), before: selection }),
    // Rewrites are the Asistente's; the analyses belong to the Consejero and use its model.
    role: action.section === "advisor" ? "advise" : "write",
    novelId: novel.id,
    purpose: action.section === "advisor" ? "advise" : "assist",
  };
}

function streamResponse(
  provider: NonNullable<ReturnType<typeof getProvider>>,
  completion: CompletionRequest & { continuity?: (output: string) => ContinuityWarning[] },
  inventory: { parts: ContextPart[] } & ContextInventory,
  onUsage: (u: Extract<AssistEvent, { type: "usage" }>) => Promise<void>,
) {
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: AssistEvent) =>
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

  const generator = provider.stream(completion);
  let output = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const { parts, total, sections, notices, instructions } = inventory;
      send(controller, { type: "context", parts, sent: { total, sections, notices, instructions } });
    },
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          // Continuidad: what the proposal changes of what is established (never blocks).
          const warnings = output && completion.continuity ? completion.continuity(output) : [];
          if (warnings.length) send(controller, { type: "continuity", warnings });
          controller.close();
        } else {
          if (value.type === "text") output += value.text;
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
