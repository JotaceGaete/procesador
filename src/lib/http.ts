import { NextResponse } from "next/server";
import { CHARACTER_KEYS } from "./types";

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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Error desconocido";
  console.error("[api]", message);
  return NextResponse.json({ error: message }, { status: 500 });
}

const MAX_FIELD_CHARS = 20_000;

/** Keeps only known character fields with string values. */
export function pickCharacterFields(body: unknown) {
  const out: Record<string, string> = {};
  if (typeof body !== "object" || !body) return out;
  for (const key of CHARACTER_KEYS) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value.slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body === "object" && body) return body;
  } catch {}
  throw new HttpError(400, "JSON inválido");
}
