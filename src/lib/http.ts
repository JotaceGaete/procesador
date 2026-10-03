import { NextResponse } from "next/server";

export function errorResponse(error: unknown, status = 500) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Error desconocido";
  return NextResponse.json({ error: message }, { status });
}

const CHARACTER_KEYS = ["name", "role", "background", "voice", "traits", "arc", "notes"] as const;

/** Keeps only known character fields with string values. */
export function pickCharacterFields(body: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const key of CHARACTER_KEYS) {
    if (typeof body[key] === "string") out[key] = body[key] as string;
  }
  return out;
}
