import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { HttpError, readJson } from "@/lib/http";
import { evaluateChapter, listCritiques } from "@/lib/critic/evaluate";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** The chapter's reports from the Crítico Literario (docs/critico.md), newest first. */
export const GET = handler<Ctx>(async (_request, { params }) => NextResponse.json(await listCritiques((await params).id)));

/**
 * Evaluates the chapter as saved: one report, stored. Reads the manuscript and the Memoria,
 * writes nothing but the report. Above AI_CONFIRM_TOKENS it answers { confirm } first;
 * `approvedTokens` is the author's yes.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  const provider = body.provider as ProviderId;
  if (!getProvider(provider)) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  const outcome = await evaluateChapter({
    chapterId: (await params).id,
    provider,
    signal: request.signal,
    approvedTokens: typeof body.approvedTokens === "number" ? body.approvedTokens : undefined,
  });
  return NextResponse.json(outcome);
});
