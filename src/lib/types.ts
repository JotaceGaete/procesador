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

/** Real usage reported by the provider, and its cost when the model's prices are configured. */
export interface Usage {
  model: string;
  input: number;
  cached: number;
  output: number;
  costUsd: number | null;
}

export type SceneLength = "breve" | "media" | "larga" | "libre";

export const SCENE_LENGTHS: { id: SceneLength; label: string; words: number | null }[] = [
  { id: "breve", label: "Breve", words: 400 },
  { id: "media", label: "Media", words: 900 },
  { id: "larga", label: "Larga", words: 1800 },
  { id: "libre", label: "Libre", words: null },
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
  | { type: "context"; parts: ContextPart[] }
  /** Last event before refusal/truncated: tokens and cost. */
  | ({ type: "usage" } & Usage);
