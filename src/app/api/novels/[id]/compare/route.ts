import { NextResponse } from "next/server";
import { handler } from "@/lib/auth";
import { HttpError, readJson } from "@/lib/http";
import { COMPARE_LIMIT, compareVersions } from "@/lib/advisor/compare";
import { getNovel } from "@/lib/supabase";
import { getProvider } from "@/lib/ai/providers";
import type { ProviderId } from "@/lib/types";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Juicio comparativo (docs/consejero.md, «Revisar escena»): the author's scene and a rewrite,
 * judged by the Consejero. A recommendation only: nothing is stored or applied.
 */
export const POST = handler<Ctx>(async (request, { params }) => {
  const body = await readJson(request);
  const novelId = (await params).id;
  const provider = body.provider as ProviderId;
  if (!getProvider(provider)) throw new HttpError(400, "Ese proveedor de IA no está configurado.");
  const original = typeof body.original === "string" ? body.original.trim() : "";
  const proposal = typeof body.proposal === "string" ? body.proposal.trim() : "";
  if (!original || !proposal) throw new HttpError(400, "Faltan las dos versiones de la escena.");
  if (original.length > COMPARE_LIMIT || proposal.length > COMPARE_LIMIT) throw new HttpError(400, "La escena es demasiado larga para compararla.");
  await getNovel(novelId);
  return NextResponse.json(await compareVersions({ novelId, original, proposal, provider, signal: request.signal }));
});
