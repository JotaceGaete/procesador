import type { AgeAnchor, Calendar, StoryDate, TimeMark, TimeWarning } from "./chronology";

export interface NovelSummary {
  id: string;
  title: string;
  updated_at: string;
  chapters: number;
  words: number;
}

export interface Novel {
  id: string;
  title: string;
  synopsis: string;
  notes: string;
  guide: Guide;
  /** Re-read a chapter on leaving it after a substantial change (Consejero). */
  auto_digest: boolean;
  /** Cronología: real dates (1972) or relative years (Año 0, Año 5). */
  calendar: Calendar;
  /** Time warnings the author dismissed: key → fingerprint of the data it was about. */
  dismissed_warnings: Record<string, string>;
  updated_at: string;
}

export type Guide = Partial<Record<GuideKey, string>>;
export type GuideKey =
  | "genre"
  | "period"
  | "setting"
  | "narrator"
  | "person"
  | "tense"
  | "tone"
  | "style"
  | "pacing"
  | "description"
  | "dialogue"
  | "language"
  | "themes"
  | "world_rules"
  | "conventions"
  | "influences"
  | "avoid"
  | "instructions";

/** Chapter list entry, without the text. */
export interface ChapterInfo {
  id: string;
  title: string;
  position: number;
  chars: number;
  words: number;
}

export interface Chapter {
  id: string;
  novel_id: string;
  title: string;
  content: string;
  revision: number;
}

/** Why a version of a chapter was kept (docs/versiones.md). */
export type VersionReason = "auto" | "ai" | "conflict" | "manual" | "restore" | "delete";

export const VERSION_REASONS: Record<VersionReason, string> = {
  auto: "Copia automática",
  ai: "Antes de aplicar la IA",
  conflict: "Versión de otro dispositivo",
  manual: "Guardada por ti",
  restore: "Antes de restaurar",
  delete: "Al eliminar el capítulo",
};

/** A saved copy of a chapter's text; `content` only when one version is asked for. */
export interface ChapterVersion {
  id: string;
  reason: VersionReason;
  label: string;
  title: string;
  words: number;
  created_at: string;
  content?: string;
}

/** A deleted chapter in the trash, with its last version. */
export interface TrashEntry {
  source_chapter_id: string;
  title: string;
  position: number;
  words: number;
  deleted_at: string;
  versions: number;
}

export interface Character {
  id: string;
  novel_id: string;
  name: string;
  aliases: string;
  age: string;
  role: string;
  description: string;
  background: string;
  personality: string;
  motivations: string;
  fears: string;
  contradictions: string;
  values: string;
  voice: string;
  vocabulary: string;
  secrets: string;
  knows: string;
  unaware: string;
  arc: string;
  notes: string;
  /** Cronología: what is known of the age (computed per chapter); `age` stays a free note. */
  age_anchor: AgeAnchor | null;
  age_approx: boolean;
  death: StoryDate | null;
}

export interface Relationship {
  id: string;
  novel_id: string;
  from_id: string;
  to_id: string;
  kind: string;
  note: string;
}

export interface Place {
  id: string;
  novel_id: string;
  name: string;
  aliases: string;
  description: string;
  notes: string;
}

export interface Fact {
  id: string;
  novel_id: string;
  text: string;
  chapter_id: string | null;
  place_id: string | null;
  story_time: string;
  note: string;
  status: "approved" | "suggested";
  character_ids: string[];
}

/** What the browser knows about a file of the novel (paths stay on the server). See docs/archivos.md. */
export interface AssetInfo {
  id: string;
  version: number;
  file_name: string;
  original_type: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  original_bytes: number;
  /** Pixel size of the original as it is seen (EXIF orientation applied). */
  width: number;
  height: number;
  /** EXIF orientation of the original (1–8). Exporters apply it when embedding the original. */
  orientation: number;
  derived_type: "image/webp" | "image/jpeg" | "image/png";
}

/** Where a file of the novel is used. */
export type AssetUse =
  | { kind: "character"; character_id: string; character_image_id: string }
  | { kind: "manuscript"; manuscript_image_id: string; chapter_id: string | null };

/**
 * An image of the book, placed in a chapter by its marker [[imagen:<id>]]
 * (docs/manuscrito-imagenes.md). Everything an exporter needs besides the original.
 */
export interface ManuscriptImage {
  id: string;
  novel_id: string;
  asset_id: string;
  /** Where its marker was at the last save; null = not placed (still kept). */
  chapter_id: string | null;
  /** Alternative text, independent of the caption. Not needed when decorative. */
  alt: string;
  decorative: boolean;
  /** Editorial caption, and credit/attribution: separate concepts. */
  caption: string;
  credit: string;
  layout: "inline" | "page";
  align: "center" | "left" | "right";
  /** Share of the text block width. */
  width_pct: 25 | 50 | 75 | 100;
  created_at: string;
  asset: AssetInfo;
}

/** A use of a file: one image in a character's gallery (reference image, not part of the book). */
export interface CharacterImage {
  id: string;
  novel_id: string;
  character_id: string;
  asset_id: string;
  caption: string;
  /** Descriptive label ("1982", "tras la cárcel"). Not chronological data: the app never interprets it. */
  stage_label: string;
  is_primary: boolean;
  sort_order: number;
  created_at: string;
  asset: AssetInfo;
}

export interface Memory {
  characters: Character[];
  relationships: Relationship[];
  places: Place[];
  facts: Fact[];
}

export type MemoryKind = keyof Memory;

export const CHARACTER_SECTIONS: {
  title: string;
  open?: boolean;
  fields: { key: keyof Character; label: string; hint?: string; rows: number }[];
}[] = [
  {
    title: "Esencial",
    open: true,
    fields: [
      { key: "name", label: "Nombre", rows: 1 },
      {
        key: "aliases",
        label: "También llamado",
        hint: "Apodos o formas de nombrarlo en el texto, separados por comas",
        rows: 1,
      },
      { key: "age", label: "Edad o nacimiento", rows: 1 },
      { key: "role", label: "Rol", hint: "Protagonista, antagonista, secundario…", rows: 1 },
      { key: "description", label: "Descripción", hint: "Aspecto, presencia, cómo lo ven los demás", rows: 3 },
    ],
  },
  {
    title: "Interior",
    fields: [
      { key: "personality", label: "Personalidad", rows: 3 },
      { key: "motivations", label: "Motivaciones", hint: "Qué quiere, qué necesita", rows: 2 },
      { key: "fears", label: "Miedos", rows: 2 },
      { key: "contradictions", label: "Contradicciones", rows: 2 },
      { key: "values", label: "Valores", hint: "Lo que defiende, aunque no lo cumpla", rows: 2 },
    ],
  },
  {
    title: "Voz",
    fields: [
      { key: "voice", label: "Forma de hablar", hint: "Registro, ritmo, lo que nunca diría", rows: 3 },
      { key: "vocabulary", label: "Vocabulario y expresiones", hint: "Muletillas, groserías, giros propios", rows: 2 },
    ],
  },
  {
    title: "Historia y conocimiento",
    fields: [
      { key: "background", label: "Trasfondo", rows: 3 },
      { key: "secrets", label: "Secretos", rows: 2 },
      { key: "knows", label: "Sabe", hint: "Información que conoce", rows: 2 },
      { key: "unaware", label: "No sabe", hint: "Información que desconoce", rows: 2 },
      { key: "arc", label: "Arco narrativo", hint: "Dónde empieza, hacia dónde va, qué lo cambia", rows: 3 },
    ],
  },
  { title: "Notas", fields: [{ key: "notes", label: "Notas", rows: 3 }] },
];

export const CHARACTER_KEYS = CHARACTER_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)) as (keyof Character)[];

export type EditAction = "redaccion" | "dialogo" | "expandir" | "acortar" | "consistencia" | "personaje" | "evolucion";

/**
 * Where each action lives (docs/consejero.md): the Asistente writes with the author
 * (it proposes text); the Consejero thinks with the author (analysis, never text to apply).
 */
export type AIPanelSection = "assistant" | "advisor";

export const EDIT_ACTIONS: {
  id: EditAction;
  label: string;
  character: "required" | "optional";
  rewrites: boolean;
  section: AIPanelSection;
}[] = [
  { id: "redaccion", label: "Redacción", character: "optional", rewrites: true, section: "assistant" },
  { id: "dialogo", label: "Diálogo", character: "optional", rewrites: true, section: "assistant" },
  { id: "expandir", label: "Expandir", character: "optional", rewrites: true, section: "assistant" },
  { id: "acortar", label: "Acortar", character: "optional", rewrites: true, section: "assistant" },
  { id: "consistencia", label: "Consistencia", character: "optional", rewrites: false, section: "advisor" },
  { id: "personaje", label: "Personaje", character: "required", rewrites: false, section: "advisor" },
  { id: "evolucion", label: "Evolución", character: "required", rewrites: false, section: "advisor" },
];

/** Which model a request uses: each is configured separately (docs/consejero.md). */
export type AIRole = "write" | "advise" | "digest";

/** One piece of what was sent to the model, shown to the author ("Leí: …"). */
export interface ContextPart {
  label: string;
  tokens: number;
}

/**
 * What a request to the Asistente carries, for the author ("Ver contexto"): built by the same
 * code that builds the request, so it lists exactly what is sent and nothing else.
 */
export interface ContextItem {
  label: string;
  /** What the author sees when the item is unfolded (the fact, the relationship's note…). */
  detail?: string;
  /** Why it was included: "elegido", "nombrado en el argumento"… */
  reason?: string;
  note?: string;
}
/** What a request carries, for the author: the dry run's answer, and the real request's first event. */
export interface ContextInventory {
  /** Estimated tokens (characters ÷ 3.5): the provider reports the real ones after answering. */
  total: number;
  sections: ContextSection[];
  notices: string[];
  /** Procesador's own instructions to the model, only counted. */
  instructions: number;
}

export type ContextSectionId =
  | "chapter"
  | "previous"
  | "selection"
  | "passages"
  | "guide"
  | "characters"
  | "places"
  | "relationships"
  | "facts"
  | "story"
  | "knowledge"
  | "threads"
  | "argument"
  | "time"
  | "draft"
  | "manuscript";
export interface ContextSection {
  id: ContextSectionId;
  label: string;
  tokens: number;
  items: ContextItem[];
}

/** Real usage reported by the provider, and its cost when the model's prices are configured. */
export interface Usage {
  model: string;
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
}

export type SceneLength = "breve" | "media" | "larga" | "libre";

/**
 * `words` is the reference shown in the panel; `range` what the model is asked for (a target,
 * not a quota); `warnBelow` the fraction of `words` under which the panel says the scene came
 * out short and offers "Ampliar" (only where a short scene is a real problem).
 */
export const SCENE_LENGTHS: {
  id: SceneLength;
  label: string;
  words: number | null;
  range: [number, number] | null;
  warnBelow: number | null;
}[] = [
  { id: "breve", label: "Breve", words: 400, range: [300, 500], warnBelow: null },
  { id: "media", label: "Media", words: 900, range: [800, 1000], warnBelow: 0.6 },
  { id: "larga", label: "Larga", words: 1800, range: [1500, 2100], warnBelow: 0.6 },
  { id: "libre", label: "Libre", words: null, range: null, warnBelow: null },
];

export type ProviderId = "anthropic" | "openai" | "xai";

export const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: "Claude", openai: "GPT", xai: "Grok" };

/** Events of the /api/assist stream, one JSON object per line. */
export type AssistEvent =
  | { type: "text"; text: string }
  | { type: "refusal"; message: string }
  | { type: "truncated" }
  | { type: "error"; message: string }
  /** First event: what the request reads. */
  | {
      type: "context";
      parts: ContextPart[];
      /** The Asistente's request as sent ("Ver contexto" of the real request, not of a preview). */
      sent?: ContextInventory;
    }
  /** Last event before refusal/truncated: tokens and cost. */
  | ({ type: "usage" } & Usage)
  /** Consejero: how a free question was understood, and the verified cards at the end. */
  | { type: "plan"; action: string; label: string; detail: string }
  | { type: "observations"; items: Observation[]; invalid?: boolean }
  /** Consejero: the exchange is stored; ids to act on the cards. */
  | { type: "saved"; conversationId: string; messageId: string; observationIds: string[] }
  /** Lectura profunda: what was served in a round, what it read in all, and a pause to ask. */
  | { type: "reading"; round: number; items: string[] }
  | { type: "material"; rounds: number; items: { label: string; tokens: number }[] }
  | { type: "confirm"; tokens: number; requests: unknown[]; items: string[] }
  /** Discard the text shown so far (it turned out to be a request for material). */
  | { type: "reset" };

// ---------------------------------------------------------------------------
// Consejero: the reading of the novel (docs/consejero.md, phase 2)
// ---------------------------------------------------------------------------

export type ThreadKind = "conflict" | "mystery" | "promise" | "relationship" | "other";
export type ThreadStatus = "open" | "closed" | "abandoned";
export type ThreadChange = "opened" | "advanced" | "closed";

export const THREAD_KINDS: { id: ThreadKind; label: string }[] = [
  { id: "conflict", label: "Conflicto" },
  { id: "mystery", label: "Misterio" },
  { id: "promise", label: "Promesa al lector" },
  { id: "relationship", label: "Relación" },
  { id: "other", label: "Otro" },
];
export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  open: "Abierto",
  closed: "Cerrado",
  abandoned: "Abandonado a propósito",
};

export interface DigestEvent {
  text: string;
  characters: string[];
  /** Literal, short; "" when the model's quote wasn't in the text (never shown as a quote). */
  quote: string;
}
export interface DigestPresence {
  character: string;
  kind: "present" | "mentioned";
}
export interface DigestRevelation {
  text: string;
  /** "lector" or a character id. */
  to: string;
  quote: string;
}
export interface DigestThread {
  thread: string;
  change: ThreadChange;
  quote: string;
}

export interface ChapterDigest {
  chapter_id: string;
  novel_id: string;
  source_revision: number;
  /** Numeric sketch of the text read (see lib/advisor/freshness.ts). */
  text_sketch: { n: number; h: number[] };
  summary: string;
  events: DigestEvent[];
  presence: DigestPresence[];
  revelations: DigestRevelation[];
  threads: DigestThread[];
  notes: string;
  author_edited: boolean;
  model: string;
  updated_at: string;
}

export interface StoryThread {
  id: string;
  novel_id: string;
  title: string;
  description: string;
  kind: ThreadKind;
  status: ThreadStatus;
  status_by: "advisor" | "author";
  origin: "advisor" | "author";
  confirmed: boolean;
  opened_chapter_id: string | null;
  last_chapter_id: string | null;
  closed_chapter_id: string | null;
}

export interface NovelDigest {
  novel_id: string;
  summary: string;
  based_on: Record<string, number>;
  model: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Consejero: actions and observations (docs/consejero.md, phase 3)
// ---------------------------------------------------------------------------

export type AdvisorAction = "analizar" | "seguir" | "repeticiones" | "cabos" | "coherencia" | "personajes";

export const ADVISOR_ACTIONS: { id: AdvisorAction; label: string; hint: string }[] = [
  { id: "analizar", label: "Analizar capítulo", hint: "Qué funciona y qué no en el capítulo abierto" },
  { id: "seguir", label: "¿Cómo seguir?", hint: "Varios caminos posibles; no escribe la continuación" },
  { id: "repeticiones", label: "Repeticiones", hint: "Expresiones, imágenes o situaciones que se repiten" },
  { id: "cabos", label: "Cabos pendientes", hint: "Qué quedó abierto y cuánto hace que no aparece" },
  { id: "coherencia", label: "Coherencia", hint: "Contradicciones y revelaciones a destiempo" },
  { id: "personajes", label: "Personajes", hint: "Presencia, evolución y personajes desaprovechados" },
];

export type ObservationKind = "problem" | "repetition" | "contradiction" | "thread" | "opportunity" | "alternative" | "pacing";

export const OBSERVATION_LABELS: Record<ObservationKind, string> = {
  problem: "Posible problema",
  repetition: "Repetición",
  contradiction: "Posible contradicción",
  thread: "Cabo pendiente",
  opportunity: "Oportunidad narrativa",
  alternative: "Alternativa para continuar",
  pacing: "Ritmo y estructura",
};

export interface ObservationRef {
  chapterId: string;
  /** Exactly as in the text when verified; as the model wrote it otherwise. */
  quote: string;
  verified: boolean;
  at: { start: number; end: number } | null;
}

export interface Observation {
  kind: ObservationKind;
  title: string;
  body: string;
  confidence: "high" | "medium" | "low";
  refs: ObservationRef[];
  /** False when none of its references could be found in the manuscript: an impression. */
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Consejero: conversations and stored observations (phase 4)
// ---------------------------------------------------------------------------

export type ObservationStatus = "new" | "saved" | "dismissed" | "resolved";

export interface StoredObservation extends Observation {
  id: string;
  message_id: string | null;
  status: ObservationStatus;
  based_on: Record<string, number>;
  checked_at: string;
  created_at: string;
  /** Chapters it relied on that changed since (computed when read). */
  changed: string[];
}

export interface AdvisorMessage {
  id: string;
  role: "author" | "advisor";
  content: string;
  context: {
    parts?: ContextPart[];
    plan?: { label: string; detail: string };
    model?: string;
    usage?: Usage | null;
    material?: { label: string; tokens: number }[];
    rounds?: number;
  } | null;
  created_at: string;
  observations: StoredObservation[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
}

/** The Cronología view (GET /api/novels/[id]/chronology): computed, said for the author. */
export interface ChronologyView {
  calendar: Calendar;
  chapters: { id: string; title: string; mark: TimeMark | null; time: string; estimated: boolean }[];
  /** Ages per chapter, in chapter order ("26 años", "20–21 años", "≈ 40 años"; null unknown). */
  characters: { id: string; name: string; anchored: boolean; ages: (string | null)[] }[];
  warnings: (TimeWarning & { dismissed: boolean })[];
}

