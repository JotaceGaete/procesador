import "server-only";
import { assertId, db } from "../supabase";
import { HttpError } from "../http";
import { completeJson, InvalidOutput } from "../ai/structured";
import { recordUsage } from "../ai/usage";
import type {
  AdvisorMessage,
  ConversationSummary,
  ContextPart,
  Observation,
  ObservationStatus,
  ProviderId,
  StoredObservation,
  Usage,
} from "../types";
import { chapterRows } from "./reading";
import { findQuote } from "./quotes";
import { CONVERSATION_SUMMARY_INSTRUCTIONS } from "./prompts";
import { cardStates, cardsBlock, currentFocus, type Anchor, type CardRef, type CardWithState, type ConversationMessage } from "./cards";
import { conversationPlan, planBlock, type Plan } from "./converse";

/**
 * The Consejero's memory of a conversation (docs/consejero.md, phase 4): only the last
 * turns travel literally; the earlier ones, compacted into a short summary by the
 * cheap model. Observations are stored with the chapter revisions they relied on, so
 * after an edit they say "based on an earlier version" and can be checked again.
 */

/** Messages that always travel literally (three exchanges). */
const LITERAL = 6;
const MESSAGE_CHARS = 2500;

interface ConversationRow {
  id: string;
  novel_id: string;
  title: string;
  summary: string;
  summarized_count: number;
  updated_at: string;
}

export async function getConversation(id: string): Promise<ConversationRow> {
  const { data, error } = await db().from("advisor_conversations").select("*").eq("id", assertId(id, "Conversación")).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Conversación no encontrada");
  return data as ConversationRow;
}

async function messageRows(conversationId: string) {
  const { data, error } = await db()
    .from("advisor_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at")
    .order("role", { ascending: false }); // author before advisor when created together
  if (error) throw error;
  return data as { id: string; role: "author" | "advisor"; content: string; context: AdvisorMessage["context"]; created_at: string }[];
}

/** The messages with their cards (label, kind, title, status), for references and states. */
async function withCards(rows: Awaited<ReturnType<typeof messageRows>>): Promise<ConversationMessage[]> {
  const ids = rows.filter((m) => m.role === "advisor").map((m) => m.id);
  const { data, error } = ids.length
    ? await db().from("advisor_observations").select("id, message_id, kind, title, body, status, position").in("message_id", ids)
    : { data: [], error: null };
  if (error) throw error;
  const obs = (data ?? []) as (ConversationMessage["observations"][number] & { message_id: string })[];
  return rows.map((m) => ({ role: m.role, content: m.content, context: m.context, observations: obs.filter((o) => o.message_id === m.id) }));
}

/**
 * One turn, as the model reads it: the author's words (and the card they were about), or
 * the Consejero's text and the labels of the cards it proposed.
 */
function turn(m: ConversationMessage, labelled: CardWithState[]) {
  const text = m.content.length > MESSAGE_CHARS ? `${m.content.slice(0, MESSAGE_CHARS)}…` : m.content;
  if (m.role === "author") {
    const a = m.context?.anchor;
    return `[Autor${a ? `, sobre ${a.label}` : ""}] ${text}`;
  }
  const ids = new Set(m.observations.map((o) => o.id));
  const cards = labelled.filter((c) => ids.has(c.id));
  return `[Consejero] ${text}${cards.length ? `\nTarjetas: ${cards.map((c) => `${c.label} «${c.title}»`).join(" · ")}` : ""}`;
}

export interface ConversationState {
  /** What the model is told of the conversation so far. */
  text: string;
  messages: number;
  /** Every card, labelled and with its state. */
  cards: CardWithState[];
  /** The proposal being developed, if any. */
  focus: CardRef | null;
  /** The author's decisions (PLAN) and discards in this conversation. */
  plan: Plan;
}

/**
 * The conversation for the next answer. Compacts first when enough messages fell out of
 * the literal window (one cheap request, logged as 'digest'; never with `compact: false`,
 * as in a dry run). The summary is told to keep proposals as states, never as facts; and
 * after it, the states of every card are computed again from what the author did, so a
 * summary can never turn a discussed possibility into something decided.
 */
export async function conversationContext(opts: {
  conversationId: string;
  novelId: string;
  provider: ProviderId;
  signal: AbortSignal;
  compact?: boolean;
  /** Conversar: the cards block is shorter (the latest proposals with their text, the rest by title). */
  lean?: boolean;
}): Promise<ConversationState> {
  const c = await getConversation(opts.conversationId);
  if (c.novel_id !== opts.novelId) throw new HttpError(404, "Conversación no encontrada");
  const messages = await withCards(await messageRows(c.id));
  const cards = cardStates(messages);
  const focus = currentFocus(messages);
  const plan = conversationPlan(messages);
  const decided = planBlock(plan);
  let summary = c.summary;
  let from = c.summarized_count;
  const cut = messages.length - LITERAL;
  if (opts.compact !== false && cut - from >= 2) {
    const older = messages.slice(0, cut);
    const states = cardsBlock(
      cards.filter((x) => x.message < cut),
      null,
    );
    const { value } = await completeJson(
      opts.provider,
      {
        instructions: CONVERSATION_SUMMARY_INSTRUCTIONS,
        manuscript: null,
        project: "",
        prompt: `${summary ? `<resumen-anterior>\n${summary}\n</resumen-anterior>\n\n` : ""}<mensajes>\n${older
          .slice(from)
          .map((m) => turn(m, cards))
          .join("\n\n")}\n</mensajes>${states ? `\n\n<estado-de-las-tarjetas>\n${states}\n</estado-de-las-tarjetas>` : ""}${decided ? `\n\n<plan-del-autor>\n${decided}\n</plan-del-autor>` : ""}\n\nResume la conversación hasta aquí.`,
        signal: opts.signal,
        role: "digest",
        maxOutputTokens: 1500,
      },
      (raw) => {
        const s = raw && typeof raw === "object" ? (raw as { summary?: unknown }).summary : null;
        if (typeof s !== "string" || s.trim().length < 10) throw new InvalidOutput('Falta "summary".');
        return s.trim().slice(0, 4000);
      },
      (u) => recordUsage(opts.novelId, "digest", opts.provider, u),
    );
    summary = value;
    from = cut;
    const { error } = await db().from("advisor_conversations").update({ summary, summarized_count: from }).eq("id", c.id);
    if (error) throw error;
  }
  const recent = messages.slice(from);
  const block = opts.lean ? cardsBlock(cards, focus, 25, { recent: 5, chars: 450 }) : cardsBlock(cards, focus);
  if (!summary && !recent.length) return { text: "", messages: 0, cards, focus, plan };
  const text = [
    summary && `Resumen de lo hablado antes (ideas en discusión; nada de esto es un hecho de la novela):\n${summary}`,
    recent.length && `Últimos mensajes:\n${recent.map((m) => turn(m, cards)).join("\n\n")}`,
    block && `Estado actual de las tarjetas (manda sobre el resumen):\n${block}`,
    decided,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, messages: messages.length, cards, focus, plan };
}

/** Revisions of the given chapters now: what an observation relied on. */
export async function revisionsOf(novelId: string, ids: Iterable<string>): Promise<Record<string, number>> {
  const want = new Set(ids);
  const rows = await chapterRows(novelId);
  return Object.fromEntries(rows.filter((r) => want.has(r.id)).map((r) => [r.id, r.revision]));
}

function authorContext(opts: { anchor?: Anchor | null; mode?: string; decisions?: string[]; discarded?: string[] }) {
  const ctx = {
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.decisions?.length ? { decisions: opts.decisions } : {}),
    ...(opts.discarded?.length ? { discarded: opts.discarded } : {}),
  };
  return Object.keys(ctx).length ? ctx : null;
}

/** Stores the author's turn, the Consejero's answer and its cards. */
export async function saveExchange(opts: {
  novelId: string;
  conversationId: string | null;
  title: string;
  question: string;
  answer: string;
  context: {
    parts: ContextPart[];
    plan: { label: string; detail: string };
    model: string | null;
    usage: Usage | null;
    material?: { label: string; tokens: number }[];
    rounds?: number;
    cards?: { label: string; from: string | null }[];
    mode?: "conversar" | "analizar";
  };
  /** The card the author's message was about. */
  anchor?: Anchor | null;
  /** The mode of the turn, and the decisions and discards in the author's words. */
  mode?: "conversar" | "analizar";
  decisions?: string[];
  discarded?: string[];
  observations: Observation[];
  /** Chapters the whole answer relied on (the focus and any read complete). */
  basedOn: Record<string, number>;
}): Promise<{ conversationId: string; messageId: string; observationIds: string[] }> {
  let conversationId = opts.conversationId;
  if (!conversationId) {
    const { data, error } = await db()
      .from("advisor_conversations")
      .insert({ novel_id: opts.novelId, title: opts.title.slice(0, 200) })
      .select("id")
      .single();
    if (error) throw error;
    conversationId = data.id as string;
  } else {
    // Touch it, so the list shows the most recent first.
    const { error } = await db().from("advisor_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    if (error) throw error;
  }
  const { data: msgs, error } = await db()
    .from("advisor_messages")
    .insert([
      { conversation_id: conversationId, novel_id: opts.novelId, role: "author", content: opts.question, context: authorContext(opts) },
      { conversation_id: conversationId, novel_id: opts.novelId, role: "advisor", content: opts.answer, context: opts.context },
    ])
    .select("id, role");
  if (error) throw error;
  const messageId = msgs.find((m) => m.role === "advisor")!.id as string;
  if (!opts.observations.length) return { conversationId, messageId, observationIds: [] };

  const refChapters = opts.observations.flatMap((o) => o.refs.map((r) => r.chapterId)).filter(Boolean);
  const now = await revisionsOf(opts.novelId, refChapters);
  const { data: obs, error: obsError } = await db()
    .from("advisor_observations")
    .insert(
      opts.observations.map((o, position) => ({
        novel_id: opts.novelId,
        position,
        message_id: messageId,
        kind: o.kind,
        title: o.title,
        body: o.body,
        confidence: o.confidence,
        verified: o.verified,
        refs: o.refs,
        based_on: { ...opts.basedOn, ...Object.fromEntries(o.refs.filter((r) => r.chapterId in now).map((r) => [r.chapterId, now[r.chapterId]])) },
      })),
    )
    .select("id, position");
  if (obsError) throw obsError;
  // In the order of the cards, so the panel can pair ids with what it showed.
  return { conversationId, messageId, observationIds: obs.sort((a, b) => a.position - b.position).map((o) => o.id as string) };
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

/** Adds `changed`: chapters it relied on whose text changed since (or that no longer exist). */
function withFreshness(rows: Omit<StoredObservation, "changed">[], revisions: Map<string, number>): StoredObservation[] {
  return rows.map((o) => ({
    ...o,
    changed: Object.entries(o.based_on ?? {})
      .filter(([id, rev]) => revisions.get(id) !== rev)
      .map(([id]) => id),
  }));
}

async function revisionMap(novelId: string) {
  return new Map((await chapterRows(novelId)).map((r) => [r.id, r.revision]));
}

export async function listConversations(novelId: string): Promise<ConversationSummary[]> {
  const { data, error } = await db()
    .from("advisor_conversations")
    .select("id, title, updated_at")
    .eq("novel_id", novelId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data;
}

export async function conversationWithMessages(id: string) {
  const c = await getConversation(id);
  const messages = await messageRows(c.id);
  const { data, error } = await db()
    .from("advisor_observations")
    .select("*")
    .in("message_id", messages.length ? messages.map((m) => m.id) : ["00000000-0000-0000-0000-000000000000"])
    .order("created_at")
    .order("position");
  if (error) throw error;
  const observations = withFreshness(data as Omit<StoredObservation, "changed">[], await revisionMap(c.novel_id));
  return {
    conversation: { id: c.id, title: c.title, updated_at: c.updated_at, summarized: c.summarized_count },
    messages: messages.map((m): AdvisorMessage => ({ ...m, observations: observations.filter((o) => o.message_id === m.id) })),
  };
}

export async function listObservations(novelId: string, status: ObservationStatus) {
  const { data, error } = await db()
    .from("advisor_observations")
    .select("*")
    .eq("novel_id", novelId)
    .eq("status", status)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return withFreshness(data as Omit<StoredObservation, "changed">[], await revisionMap(novelId));
}

async function getObservation(id: string) {
  const { data, error } = await db().from("advisor_observations").select("*").eq("id", assertId(id, "Observación")).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Observación no encontrada");
  return data as Omit<StoredObservation, "changed"> & { novel_id: string };
}

export async function setObservationStatus(id: string, status: unknown) {
  if (!["new", "saved", "dismissed", "resolved"].includes(String(status))) throw new HttpError(400, "Estado desconocido.");
  const o = await getObservation(id);
  const { error } = await db().from("advisor_observations").update({ status }).eq("id", o.id);
  if (error) throw error;
  return (await listOne(o.id, o.novel_id))!;
}

async function listOne(id: string, novelId: string) {
  const o = await getObservation(id);
  return withFreshness([o], await revisionMap(novelId))[0];
}

/**
 * "Volver a comprobar", without AI: each quote is looked for again in the text as it is
 * now (in its chapter first, then anywhere); the observation then relies on the current
 * revisions. To have the Consejero reconsider it, the panel asks in the conversation.
 */
export async function recheckObservation(id: string) {
  const o = await getObservation(id);
  const rows = await chapterRows(o.novel_id);
  const refs = o.refs.map((r) => {
    const order = [...rows.filter((c) => c.id === r.chapterId), ...rows.filter((c) => c.id !== r.chapterId)];
    for (const c of order) {
      const at = findQuote(c.content, r.quote);
      if (at) return { chapterId: c.id, quote: c.content.slice(at.start, at.end), verified: true, at };
    }
    return { ...r, verified: false, at: null };
  });
  const ids = new Set([...Object.keys(o.based_on ?? {}), ...refs.map((r) => r.chapterId)]);
  const based_on = Object.fromEntries(rows.filter((r) => ids.has(r.id)).map((r) => [r.id, r.revision]));
  const { error } = await db()
    .from("advisor_observations")
    .update({ refs, verified: refs.some((r) => r.verified), based_on, checked_at: new Date().toISOString() })
    .eq("id", o.id);
  if (error) throw error;
  return listOne(o.id, o.novel_id);
}

/**
 * The author edits the conversation's plan (Conversar): the decisions and discards of one of
 * their messages, or a decision added by hand (it goes to their latest message). Only the
 * message's context changes; nothing of the novel.
 */
export async function editPlan(
  conversationId: string,
  edit: { messageId?: unknown; decisions?: unknown; discarded?: unknown; add?: unknown },
) {
  const c = await getConversation(conversationId);
  const rows = await messageRows(c.id);
  const authors = rows.filter((m) => m.role === "author");
  if (!authors.length) throw new HttpError(400, "La conversación aún no tiene mensajes.");
  const target = typeof edit.messageId === "string" ? authors.find((m) => m.id === edit.messageId) : authors.at(-1);
  if (!target) throw new HttpError(404, "Mensaje no encontrado");
  const strings = (x: unknown, what: string) => {
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new HttpError(400, `${what}: una lista de textos.`);
    return (x as string[]).map((s) => s.trim().slice(0, 400)).filter(Boolean).slice(0, 20);
  };
  const ctx = { ...(target.context ?? {}) } as Record<string, unknown>;
  if (edit.decisions !== undefined) ctx.decisions = strings(edit.decisions, "Decisiones");
  if (edit.discarded !== undefined) ctx.discarded = strings(edit.discarded, "Descartado");
  if (typeof edit.add === "string" && edit.add.trim())
    ctx.decisions = [...((ctx.decisions as string[] | undefined) ?? []), edit.add.trim().slice(0, 400)].slice(0, 20);
  const { error } = await db().from("advisor_messages").update({ context: ctx }).eq("id", target.id);
  if (error) throw error;
}
