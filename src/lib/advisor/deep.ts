import { chapterLabel, estimateTokens, nameMatcher } from "../ai/context";
import { memoryBlock } from "../ai/prompts";
import type { ChapterDigest, Memory, StoryThread } from "../types";
import { presence } from "./stats";

/**
 * Lectura profunda (docs/consejero.md, phase 5). The first answer starts from the
 * hierarchical context; if the model finds it needs more, instead of answering it asks
 * for specific material inside <solicitar>…</solicitar> and gets it in the next round.
 *
 * The protocol is plain text, the same for every provider and model: no API-specific
 * tool calling. Every tool is read-only (none can touch the manuscript), works on what
 * is already stored (digests, Memory, threads) or on the text itself, and is capped.
 * Digests are served as they are, author's corrections included: nothing is
 * regenerated or overwritten here.
 */

export const REQUEST_OPEN = "<solicitar>";
const REQUEST_CLOSE = "</solicitar>";

export interface DeepLimits {
  /** Extra rounds after the first answer attempt. */
  rounds: number;
  /** Requests served per round. */
  perRound: number;
  /** Tokens of material added in the whole query. */
  materialTokens: number;
  /** Complete chapters per query, and the size of each. */
  chapters: number;
  chapterTokens: number;
  /** Stop asking once the query cost this much (only when prices are configured). */
  costUsd: number;
}

export function deepLimits(): DeepLimits {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    rounds: Math.floor(num("DEEP_MAX_ROUNDS", 3)),
    perRound: Math.floor(num("DEEP_MAX_REQUESTS", 6)),
    materialTokens: num("DEEP_MAX_MATERIAL_TOKENS", 40_000),
    chapters: Math.floor(num("DEEP_MAX_CHAPTERS", 2)),
    chapterTokens: num("DEEP_CHAPTER_TOKENS", 20_000),
    costUsd: num("DEEP_MAX_COST_USD", 0.5),
  };
}

export function deepInstructions(l: DeepLimits): string {
  return `<lectura-profunda>
El contexto que recibes es una selección de la novela, no la novela entera. Si para responder con rigor necesitas algo que no está (un hecho de un capítulo lejano, la ficha de otro capítulo, los pasajes donde aparece un personaje, el texto exacto de un capítulo), NO respondas todavía: escribe únicamente

<solicitar>
[{ "tipo": "...", ... }]
</solicitar>

Recibirás el material dentro de <material> y entonces podrás responder o pedir más. Lo que puedes pedir:
- { "tipo": "ficha", "capitulo": N } — la ficha de lectura del capítulo: resumen, acontecimientos con citas, revelaciones, cabos. Barata: úsala primero.
- { "tipo": "pasajes", "buscar": "palabras clave", "personaje": "Nombre" (opcional), "capitulos": [N, …] (opcional) } — párrafos literales de cualquier capítulo con esas palabras o ese personaje.
- { "tipo": "revelaciones", "personaje": "Nombre" (opcional) } — qué se reveló, a quién y en qué capítulo, en toda la novela.
- { "tipo": "personaje", "nombre": "Nombre" } — su ficha en la Memoria, en qué capítulos aparece y los acontecimientos en que participa.
- { "tipo": "hechos", "personaje": "Nombre" (opcional) } — hechos de continuidad aprobados por el autor.
- { "tipo": "relaciones", "personaje": "Nombre" (opcional) }
- { "tipo": "cabo", "titulo": "título" } — el cabo y los pasajes donde se abre, avanza o se cierra.
- { "tipo": "capitulo", "capitulo": N } — el texto completo. Caro: pídelo sólo si las fichas y los pasajes no bastan.

Reglas: pide sólo lo necesario; primero fichas y pasajes, un capítulo completo sólo si es imprescindible. Como mucho ${l.rounds} rondas, ${l.perRound} pedidos por ronda y ${l.chapters} capítulos completos por consulta. Nunca pidas la novela completa. Si ya tienes lo necesario, responde directamente sin pedir nada. Las citas de tu respuesta pueden venir del material recibido.
</lectura-profunda>`;
}

export const LAST_ROUND = "Ya no puedes pedir más material: responde ahora con lo que tienes, y di qué no pudiste comprobar.";

export interface DeepRequest {
  tipo: string;
  [k: string]: unknown;
}

/** The requests of a round, or null when the text is an answer. */
export function parseRequests(text: string): DeepRequest[] | null {
  const t = text.trim();
  if (!t.startsWith(REQUEST_OPEN)) return null;
  const end = t.indexOf(REQUEST_CLOSE);
  const body = t.slice(REQUEST_OPEN.length, end === -1 ? undefined : end);
  const a = body.indexOf("[");
  const o = body.indexOf("{");
  try {
    const raw = a !== -1 && (o === -1 || a < o) ? JSON.parse(body.slice(a, body.lastIndexOf("]") + 1)) : [JSON.parse(body.slice(o, body.lastIndexOf("}") + 1))];
    return (Array.isArray(raw) ? raw : [raw]).filter((r): r is DeepRequest => !!r && typeof r === "object" && typeof r.tipo === "string");
  } catch {
    return [];
  }
}

/** Whether streamed text could still turn out to be a request (so it is held back). */
export function mightBeRequest(text: string): boolean {
  const t = text.trimStart();
  return t.length < REQUEST_OPEN.length ? REQUEST_OPEN.startsWith(t) : t.startsWith(REQUEST_OPEN);
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  chapters: { id: string; title: string; content: string; revision: number; reserved?: boolean }[];
  digests: Map<string, ChapterDigest>;
  memory: Memory;
  threads: StoryThread[];
  /** Index of the open chapter (its text is already in the context). */
  current: number;
  /** Image markers as descriptions. */
  plain(text: string): string;
}

export interface MaterialItem {
  label: string;
  tokens: number;
  /** Chapters whose text (or reading of it) this relied on. */
  chapters: string[];
}

export interface DeepState {
  limits: DeepLimits;
  usedTokens: number;
  fullChapters: Set<string>;
  served: Set<string>;
}

export function newState(limits = deepLimits()): DeepState {
  return { limits, usedTokens: 0, fullChapters: new Set(), served: new Set() };
}

const PARAGRAPH_CHARS = 900;
const MAX_PASSAGES = 8;

function clip(t: string, max: number) {
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function findCharacter(ctx: ToolContext, name: unknown) {
  if (typeof name !== "string" || !name.trim()) return null;
  const n = name.trim().toLocaleLowerCase("es");
  return (
    ctx.memory.characters.find((c) => c.name.toLocaleLowerCase("es") === n) ??
    ctx.memory.characters.find((c) => nameMatcher(c)?.test(name)) ??
    null
  );
}

function chapterIndex(ctx: ToolContext, n: unknown): number | null {
  const i = Number(n) - 1;
  return Number.isInteger(i) && i >= 0 && i < ctx.chapters.length ? i : null;
}

const label = (ctx: ToolContext, i: number) => chapterLabel(i, ctx.chapters[i].title, ctx.chapters[i].reserved);

const STOP = new Set(
  "para como pero porque cuando donde esta este esto todo toda sobre entre desde hasta tiene tenía había habia fueron estaba nunca siempre algo nada".split(" "),
);

/** Executes one request. Returns the text for the model and what it read, or an error line. */
function run(ctx: ToolContext, state: DeepState, r: DeepRequest): { text: string; item: MaterialItem | null } {
  const err = (m: string) => ({ text: `(${m})`, item: null });
  switch (r.tipo) {
    case "ficha": {
      const i = chapterIndex(ctx, r.capitulo);
      if (i === null) return err(`no existe el capítulo ${String(r.capitulo)}`);
      const d = ctx.digests.get(ctx.chapters[i].id);
      if (!d) return err(`${label(ctx, i)} aún no tiene ficha: pide pasajes o el capítulo`);
      const stale = d.source_revision !== ctx.chapters[i].revision;
      const names = new Map(ctx.memory.characters.map((c) => [c.id, c.name]));
      const text = [
        `### Ficha de ${label(ctx, i)}${stale ? " (de una versión anterior del capítulo)" : ""}${d.author_edited ? " (corregida por el autor)" : ""}`,
        d.summary,
        ...d.events.map((e) => `- ${e.text}${e.characters.length ? ` (${e.characters.map((id) => names.get(id)).filter(Boolean).join(", ")})` : ""}${e.quote ? ` «${e.quote}»` : ""}`),
        ...d.revelations.map((v) => `- Revelación: ${v.text} → ${v.to === "lector" ? "el lector" : names.get(v.to) ?? "?"}${v.quote ? ` «${v.quote}»` : ""}`),
        d.notes,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, item: { label: `ficha del cap. ${i + 1}`, tokens: 0, chapters: [ctx.chapters[i].id] } };
    }

    case "pasajes": {
      const who = r.personaje ? findCharacter(ctx, r.personaje) : null;
      if (r.personaje && !who) return err(`no hay ningún personaje llamado «${String(r.personaje)}»`);
      const terms = [
        ...new Set((typeof r.buscar === "string" ? r.buscar : "").toLocaleLowerCase("es").match(/[\p{L}\p{N}]{3,}/gu) ?? []),
      ].filter((w) => !STOP.has(w));
      if (!terms.length && !who) return err("pasajes: indica qué buscar o un personaje");
      const only = Array.isArray(r.capitulos) ? new Set(r.capitulos.map((n) => chapterIndex(ctx, n)).filter((i): i is number => i !== null)) : null;
      const matcher = who ? nameMatcher(who) : null;
      const hits: { i: number; text: string; score: number }[] = [];
      ctx.chapters.forEach((c, i) => {
        if (only && !only.has(i)) return;
        for (const p of c.content.split(/\n+/)) {
          const lower = p.toLocaleLowerCase("es");
          const termScore = terms.filter((t) => lower.includes(t)).length;
          const named = matcher ? matcher.test(p) : false;
          if (who && !named) continue;
          if (terms.length && !termScore) continue;
          hits.push({ i, text: p.trim(), score: termScore + (named ? 1 : 0) });
        }
      });
      if (!hits.length) return err(`sin pasajes para «${[...terms, who?.name].filter(Boolean).join(", ")}»`);
      // The best ones, then in the order of the novel: far-apart chapters stay side by side.
      const picked = hits
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, MAX_PASSAGES)
        .sort((a, b) => a.i - b.i);
      const text = picked.map((h) => `[${label(ctx, h.i)}]\n${clip(ctx.plain(h.text), PARAGRAPH_CHARS)}`).join("\n\n");
      const what = [terms.length && `«${terms.join(" ")}»`, who?.name].filter(Boolean).join(" · ");
      return {
        text: `### Pasajes ${what}${hits.length > picked.length ? ` (${picked.length} de ${hits.length})` : ""}\n${text}`,
        item: { label: `pasajes ${what} (${picked.length})`, tokens: 0, chapters: [...new Set(picked.map((h) => ctx.chapters[h.i].id))] },
      };
    }

    case "revelaciones": {
      const who = r.personaje ? findCharacter(ctx, r.personaje) : null;
      if (r.personaje && !who) return err(`no hay ningún personaje llamado «${String(r.personaje)}»`);
      const names = new Map(ctx.memory.characters.map((c) => [c.id, c.name]));
      const lines: string[] = [];
      const used: string[] = [];
      ctx.chapters.forEach((c, i) => {
        for (const v of ctx.digests.get(c.id)?.revelations ?? []) {
          if (who && v.to !== who.id && !nameMatcher(who)?.test(v.text)) continue;
          lines.push(`- ${label(ctx, i)}: ${v.text} → ${v.to === "lector" ? "el lector" : names.get(v.to) ?? "?"}${v.quote ? ` «${v.quote}»` : ""}`);
          used.push(c.id);
        }
      });
      if (!lines.length) return err("no hay revelaciones registradas en las fichas");
      return {
        text: `### Revelaciones${who ? ` de o sobre ${who.name}` : ""}\n${lines.join("\n")}`,
        item: { label: `revelaciones${who ? ` · ${who.name}` : ""} (${lines.length})`, tokens: 0, chapters: [...new Set(used)] },
      };
    }

    case "personaje": {
      const who = findCharacter(ctx, r.nombre);
      if (!who) return err(`no hay ningún personaje llamado «${String(r.nombre)}»`);
      const card = memoryBlock({ characters: [who], relationships: [], places: [], facts: [] }, ctx.memory, ctx.chapters, null);
      const [p] = presence(ctx.chapters, [who], ctx.current);
      const where = p.counts.flatMap((n, i) => (n ? [`${i + 1} (${n})`] : [])).join(", ");
      const events: string[] = [];
      ctx.chapters.forEach((c, i) => {
        for (const e of ctx.digests.get(c.id)?.events ?? []) {
          if (e.characters.includes(who.id)) events.push(`- ${label(ctx, i)}: ${e.text}${e.quote ? ` «${e.quote}»` : ""}`);
        }
      });
      const text = [
        `### Personaje: ${who.name}`,
        card,
        `Aparece en los capítulos (menciones): ${where || "ninguno todavía"}.`,
        events.length ? `Acontecimientos en que participa (según las fichas):\n${events.slice(-25).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return { text, item: { label: `personaje · ${who.name}`, tokens: 0, chapters: [] } };
    }

    case "hechos": {
      const who = r.personaje ? findCharacter(ctx, r.personaje) : null;
      if (r.personaje && !who) return err(`no hay ningún personaje llamado «${String(r.personaje)}»`);
      // Only approved facts are canon; suggestions waiting for the author are not served.
      const facts = ctx.memory.facts.filter((f) => f.status === "approved" && (!who || f.character_ids.includes(who.id)));
      if (!facts.length) return err("no hay hechos aprobados");
      const lines = facts.map((f) => {
        const i = ctx.chapters.findIndex((c) => c.id === f.chapter_id);
        return `- ${f.text}${i >= 0 ? ` (${label(ctx, i)})` : ""}${f.story_time ? ` [${f.story_time}]` : ""}`;
      });
      return { text: `### Hechos de continuidad${who ? ` de ${who.name}` : ""}\n${lines.join("\n")}`, item: { label: `hechos (${facts.length})`, tokens: 0, chapters: [] } };
    }

    case "relaciones": {
      const who = r.personaje ? findCharacter(ctx, r.personaje) : null;
      const names = new Map(ctx.memory.characters.map((c) => [c.id, c.name]));
      const rels = ctx.memory.relationships.filter((x) => !who || x.from_id === who.id || x.to_id === who.id);
      if (!rels.length) return err("no hay relaciones registradas");
      const lines = rels.map((x) => `- ${names.get(x.from_id)} → ${x.kind} → ${names.get(x.to_id)}${x.note ? ` (${x.note})` : ""}`);
      return { text: `### Relaciones\n${lines.join("\n")}`, item: { label: `relaciones (${rels.length})`, tokens: 0, chapters: [] } };
    }

    case "cabo": {
      const q = typeof r.titulo === "string" ? r.titulo.toLocaleLowerCase("es").trim() : "";
      const t = q && ctx.threads.find((x) => x.title.toLocaleLowerCase("es").includes(q) || q.includes(x.title.toLocaleLowerCase("es")));
      if (!t) return err(`no hay ningún cabo «${String(r.titulo)}»`);
      const lines: string[] = [];
      const used: string[] = [];
      ctx.chapters.forEach((c, i) => {
        const ref = ctx.digests.get(c.id)?.threads.find((x) => x.thread === t.id);
        if (!ref) return;
        used.push(c.id);
        const para = ref.quote ? c.content.split(/\n+/).find((p) => p.includes(ref.quote)) : null;
        lines.push(`- ${label(ctx, i)}: ${ref.change === "opened" ? "se abre" : ref.change === "closed" ? "se cierra" : "avanza"}${para ? `\n  ${clip(ctx.plain(para.trim()), PARAGRAPH_CHARS)}` : ""}`);
      });
      return {
        text: `### Cabo «${t.title}» (${t.status}${t.confirmed ? "" : ", posible"})\n${t.description}\n${lines.join("\n") || "(ninguna ficha lo menciona)"}`,
        item: { label: `cabo «${t.title}»`, tokens: 0, chapters: used },
      };
    }

    case "capitulo": {
      const i = chapterIndex(ctx, r.capitulo);
      if (i === null) return err(`no existe el capítulo ${String(r.capitulo)}`);
      if (i === ctx.current) return err(`${label(ctx, i)} es el capítulo abierto: ya lo tienes completo`);
      if (!state.fullChapters.has(ctx.chapters[i].id) && state.fullChapters.size >= state.limits.chapters)
        return err(`límite de ${state.limits.chapters} capítulos completos por consulta alcanzado: pide pasajes o la ficha`);
      state.fullChapters.add(ctx.chapters[i].id);
      const max = Math.round(state.limits.chapterTokens * 3.5);
      const content = ctx.plain(ctx.chapters[i].content);
      return {
        text: `<capitulo numero="${i + 1}" titulo="${ctx.chapters[i].title}">\n${clip(content, max)}\n</capitulo>${content.length > max ? "\n(recortado por el límite de tamaño)" : ""}`,
        item: { label: `cap. ${i + 1} completo`, tokens: 0, chapters: [ctx.chapters[i].id] },
      };
    }
  }
  return err(`no existe la herramienta «${r.tipo}»`);
}

/**
 * Serves a round of requests within the limits. Repeated requests are not served twice,
 * extra ones beyond the per-round cap are dropped, and material stops at the token budget.
 */
export function serve(ctx: ToolContext, state: DeepState, requests: DeepRequest[]): { text: string; items: MaterialItem[] } {
  const out: string[] = [];
  const items: MaterialItem[] = [];
  for (const [k, r] of requests.entries()) {
    if (k >= state.limits.perRound) {
      out.push(`(se ignoraron ${requests.length - k} pedidos: como mucho ${state.limits.perRound} por ronda)`);
      break;
    }
    const key = JSON.stringify(r);
    if (state.served.has(key)) {
      out.push(`(ya entregado antes: ${r.tipo})`);
      continue;
    }
    const left = state.limits.materialTokens - state.usedTokens;
    if (left <= 0) {
      out.push("(límite de material de esta consulta alcanzado: responde con lo que tienes)");
      break;
    }
    state.served.add(key);
    let { text, item } = run(ctx, state, r);
    if (estimateTokens(text.length) > left) text = `${text.slice(0, Math.round(left * 3.5))}…\n(recortado: límite de material de esta consulta)`;
    const tokens = estimateTokens(text.length);
    state.usedTokens += tokens;
    out.push(text);
    if (item) items.push({ ...item, tokens });
  }
  return { text: out.join("\n\n"), items };
}
