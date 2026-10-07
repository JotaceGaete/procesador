import { NextResponse } from "next/server";
import { handler, noStore } from "@/lib/access";
import { db } from "@/lib/supabase";
import { HttpError, readJson } from "@/lib/http";
import { APP_IDLE_OPTIONS, DEFAULT_APP_IDLE } from "@/lib/privacy";

async function read() {
  const { data, error } = await db().from("app_settings").select("app_idle_minutes").eq("id", true).maybeSingle();
  if (error) throw error;
  return { appIdleMinutes: (data?.app_idle_minutes as number | undefined) ?? DEFAULT_APP_IDLE };
}

/** Minutes without activity before Procesador locks (docs/privacidad.md). */
export const GET = handler(async () => NextResponse.json(await read(), { headers: noStore }));

export const PATCH = handler(async (request) => {
  const { appIdleMinutes } = await readJson(request);
  if (!APP_IDLE_OPTIONS.includes(appIdleMinutes as (typeof APP_IDLE_OPTIONS)[number])) {
    throw new HttpError(400, "Elige 15, 30, 60, 120 o 240 minutos.");
  }
  const { error } = await db().from("app_settings").upsert({ id: true, app_idle_minutes: appIdleMinutes });
  if (error) throw error;
  return NextResponse.json(await read(), { headers: noStore });
});
