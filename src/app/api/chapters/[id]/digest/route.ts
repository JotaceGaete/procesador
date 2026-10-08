import { NextResponse } from "next/server";
import { byChild, novelHandler } from "@/lib/access";
import { HttpError, readJson } from "@/lib/http";
import { digestChapter, editDigest } from "@/lib/advisor/reading";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reads the chapter (as saved) and stores its digest. `auto: true` is the switch's call
 * when the author leaves a chapter: the server decides whether the change deserves it.
 */
export const POST = novelHandler<Ctx>(byChild("chapters"), async (request, { params }) => {
  const body = await readJson(request);
  const provider = body.provider as ProviderId;
  if (!getProvider(provider)) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  const outcome = await digestChapter({
    chapterId: (await params).id,
    provider,
    signal: request.signal,
    auto: body.auto === true,
    force: body.force === true,
  });
  return NextResponse.json(outcome);
});

/** The author's correction of the summary or the notes. */
export const PATCH = novelHandler<Ctx>(byChild("chapters"), async (request, { params }) => {
  const body = await readJson(request);
  await editDigest((await params).id, { summary: body.summary as string, notes: body.notes as string });
  return new NextResponse(null, { status: 204 });
});
