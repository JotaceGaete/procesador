import { NextResponse } from "next/server";
import { authorizeNovel, byParam, noStore, novelHandler, novelStatus, type NovelAccess } from "@/lib/access";
import { checkSecret, protect, readOptions, saveOptions } from "@/lib/protection";
import { validateSecret } from "@/lib/secret";
import { db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

const answer = async ({ principal, novelId }: NovelAccess) =>
  NextResponse.json({ novel: novelStatus(novelId!, await authorizeNovel(principal, novelId!, { touch: false })) }, { headers: noStore });

/**
 * Protects the novel, or changes its PIN (with the current one). Body: { kind, secret,
 * currentSecret?, idleMinutes?, hideTitle?, lockOnHide? }. The novel stays unlocked in this
 * session only: every other unlock (other tabs' sessions, other devices) ends.
 */
export const PUT = novelHandler<Ctx>(byParam(), async (request, _ctx, access) => {
  const { novelId } = access;
  if (!novelId) throw new HttpError(404, "Novela no encontrada");
  const body = await readJson(request);
  const { kind, secret } = validateSecret(body.kind, body.secret);
  const options = readOptions(body);
  if (access.protected) await checkSecret(novelId, body.currentSecret);
  else {
    const { data, error } = await db().from("novels").select("id").eq("id", novelId).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "Novela no encontrada");
  }
  await protect(access.principal.sessionId, novelId, kind, secret);
  if (Object.keys(options).length) await saveOptions(novelId, options);
  return answer(access);
});

/** Idle time, hidden title, lock on leaving the tab. */
export const PATCH = novelHandler<Ctx>(byParam(), async (request, _ctx, access) => {
  if (!access.novelId) throw new HttpError(404, "Novela no encontrada");
  if (!access.protected) throw new HttpError(400, "Esta novela no está protegida.");
  const options = readOptions(await readJson(request));
  if (!Object.keys(options).length) throw new HttpError(400, "Nada que guardar");
  await saveOptions(access.novelId, options);
  return answer(access);
});

/** Removes the protection, with the current PIN. */
export const DELETE = novelHandler<Ctx>(byParam(), async (request, _ctx, access) => {
  if (!access.novelId) throw new HttpError(404, "Novela no encontrada");
  const { secret } = await readJson(request);
  await checkSecret(access.novelId, secret);
  const { error } = await db().rpc("novel_unprotect", { p_novel: access.novelId });
  if (error) throw error;
  return answer(access);
});
