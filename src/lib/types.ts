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

export const EDIT_ACTIONS: { id: EditAction; label: string; character: "required" | "optional"; rewrites: boolean }[] = [
  { id: "redaccion", label: "Redacción", character: "optional", rewrites: true },
  { id: "dialogo", label: "Diálogo", character: "optional", rewrites: true },
  { id: "expandir", label: "Expandir", character: "optional", rewrites: true },
  { id: "acortar", label: "Acortar", character: "optional", rewrites: true },
  { id: "consistencia", label: "Consistencia", character: "optional", rewrites: false },
  { id: "personaje", label: "Personaje", character: "required", rewrites: false },
  { id: "evolucion", label: "Evolución", character: "required", rewrites: false },
];

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
  | { type: "error"; message: string };
