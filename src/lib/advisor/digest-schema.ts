import type { DigestEvent, DigestPresence, DigestRevelation, ThreadChange, ThreadKind } from "../types";
import { findQuote } from "./quotes";

/**
 * Validation of a chapter reading as the model returns it. Structure errors reject the
 * whole answer (and the caller retries once); a bad item is dropped; a quote that is not
 * in the chapter is emptied: it is never stored as a quote (decision 5).
 */

export class SchemaError extends Error {}

export interface ProposedThread {
  /** An existing thread id, or null for a new one. */
  thread: string | null;
  title: string;
  kind: ThreadKind;
  change: ThreadChange;
  quote: string;
}

export interface ParsedDigest {
  summary: string;
  events: DigestEvent[];
  presence: DigestPresence[];
  revelations: DigestRevelation[];
  threads: ProposedThread[];
  notes: string;
  /** Quotes dropped because they were not in the text. */
  unverified: number;
}

const KINDS = ["conflict", "mystery", "promise", "relationship", "other"];
const CHANGES = ["opened", "advanced", "closed"];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");

function list(raw: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const v = raw[key] ?? [];
  if (!Array.isArray(v)) throw new SchemaError(`"${key}" debe ser una lista.`);
  return v.filter(isObj).slice(0, max);
}

export function parseChapterDigest(
  raw: unknown,
  ctx: { text: string; characterIds: Set<string>; threadIds: Set<string> },
): ParsedDigest {
  if (!isObj(raw)) throw new SchemaError("Se esperaba un objeto.");
  const summary = str(raw.summary, 4000);
  if (summary.length < 20) throw new SchemaError('Falta "summary" o es demasiado breve.');
  let unverified = 0;
  // Only literal quotes survive, and as they are in the text (its exact characters).
  const quote = (x: unknown) => {
    const q = str(x, 400);
    if (!q) return "";
    const at = findQuote(ctx.text, q);
    if (!at) {
      unverified++;
      return "";
    }
    return ctx.text.slice(at.start, at.end);
  };
  const people = (x: unknown) =>
    Array.isArray(x) ? [...new Set(x.filter((id): id is string => typeof id === "string" && ctx.characterIds.has(id)))] : [];

  // Items without text are dropped before their quotes are checked (and counted).
  const events = list(raw, "events", 12)
    .filter((e) => str(e.text, 500))
    .map((e) => ({ text: str(e.text, 500), characters: people(e.characters), quote: quote(e.quote) }));

  const seen = new Set<string>();
  const presence: DigestPresence[] = [];
  for (const p of list(raw, "presence", 100)) {
    const id = str(p.character, 64);
    if (!ctx.characterIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    presence.push({ character: id, kind: p.kind === "mentioned" ? "mentioned" : "present" });
  }

  const revelations = list(raw, "revelations", 12)
    .filter((r) => str(r.text, 500))
    .map((r) => {
      const to = str(r.to, 64);
      return { text: str(r.text, 500), to: ctx.characterIds.has(to) ? to : "lector", quote: quote(r.quote) };
    });

  const threads: ProposedThread[] = [];
  for (const t of list(raw, "threads", 12)) {
    const id = str(t.thread, 64);
    const existing = ctx.threadIds.has(id) ? id : null;
    const title = str(t.title, 200);
    if (!existing && !title) continue;
    const change = CHANGES.includes(t.change as string) ? (t.change as ThreadChange) : existing ? "advanced" : "opened";
    threads.push({
      thread: existing,
      title,
      kind: (KINDS.includes(t.kind as string) ? t.kind : "other") as ThreadKind,
      change,
      quote: quote(t.quote),
    });
  }

  return { summary, events, presence, revelations, threads, notes: str(raw.notes, 600), unverified };
}

export function parseNovelDigest(raw: unknown): { summary: string } {
  if (!isObj(raw)) throw new SchemaError("Se esperaba un objeto.");
  const summary = str(raw.summary, 20_000);
  if (summary.length < 20) throw new SchemaError('Falta "summary" o es demasiado breve.');
  return { summary };
}
