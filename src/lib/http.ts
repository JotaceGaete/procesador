import { NextResponse } from "next/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Logs only the error message (never request bodies or manuscript text). */
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  const pg = error as { code?: string; message?: string };
  // Foreign keys are what keep novels apart: an id from another novel lands here.
  if (pg?.code === "23503")
    return NextResponse.json({ error: "Referencia a un elemento que no pertenece a esta novela." }, { status: 400 });
  if (pg?.code === "22023") return NextResponse.json({ error: pg.message }, { status: 400 });
  // A function's own "not found" (raise … using errcode = 'P0002').
  if (pg?.code === "P0002") return NextResponse.json({ error: pg.message }, { status: 404 });
  // A locked chapter (docs/bloqueo-capitulos.md): the database refused to change it.
  if (pg?.code === "P0423") return NextResponse.json({ error: pg.message, locked: true }, { status: 423 });
  const message = error instanceof Error ? error.message : typeof pg?.message === "string" ? pg.message : "Error desconocido";
  console.error("[api]", message);
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body === "object" && body) return body;
  } catch {}
  throw new HttpError(400, "JSON inválido");
}

const MAX_FIELD_CHARS = 20_000;

/** Keeps only the listed fields with string values (empty strings become null for nullable ids). */
export function pickFields(body: Record<string, unknown>, fields: readonly string[], nullable: readonly string[] = []) {
  const out: Record<string, string | null> = {};
  for (const key of fields) {
    const value = body[key];
    if (nullable.includes(key) && (value === null || value === "")) out[key] = null;
    else if (typeof value === "string") out[key] = value.slice(0, MAX_FIELD_CHARS);
  }
  return out;
}
