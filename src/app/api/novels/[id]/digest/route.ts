import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { HttpError, readJson } from "@/lib/http";
import { digestNovel } from "@/lib/advisor/reading";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Rebuilds the global summary from the chapter digests (not from the text). */
export const POST = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  const provider = body.provider as ProviderId;
  if (!getProvider(provider)) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  await digestNovel({ novelId: (await params).id, provider, signal: request.signal });
  return new NextResponse(null, { status: 204 });
});
