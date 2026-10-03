export interface Project {
  id: string;
  title: string;
  synopsis: string;
  style_notes: string;
  content: string;
  revision: number;
  updated_at: string;
}

export interface Character {
  id: string;
  project_id: string;
  name: string;
  aliases: string;
  role: string;
  background: string;
  traits: string;
  voice: string;
  motivations: string;
  relationships: string;
  arc: string;
  notes: string;
}

export type CharacterInput = Omit<Character, "id" | "project_id">;

export const CHARACTER_KEYS = [
  "name",
  "aliases",
  "role",
  "background",
  "traits",
  "voice",
  "motivations",
  "relationships",
  "arc",
  "notes",
] as const satisfies readonly (keyof CharacterInput)[];

export const CHARACTER_FIELDS: { key: keyof CharacterInput; label: string; hint: string; rows: number }[] = [
  { key: "name", label: "Nombre", hint: "", rows: 1 },
  { key: "aliases", label: "También llamado", hint: "Apodos o formas de nombrarlo en el texto, separados por comas", rows: 1 },
  { key: "role", label: "Rol", hint: "Protagonista, antagonista, secundario…", rows: 1 },
  { key: "background", label: "Trasfondo", hint: "Historia previa, origen, heridas, secretos", rows: 3 },
  { key: "traits", label: "Personalidad", hint: "Temperamento, defectos, contradicciones, físico", rows: 3 },
  { key: "voice", label: "Voz", hint: "Registro, vocabulario, ritmo, muletillas, lo que nunca diría", rows: 3 },
  { key: "motivations", label: "Motivaciones", hint: "Qué quiere, qué necesita, qué teme", rows: 3 },
  { key: "relationships", label: "Relaciones", hint: "Con quién y cómo: lealtades, deudas, rencores", rows: 3 },
  { key: "arc", label: "Arco narrativo", hint: "Dónde empieza, hacia dónde va, qué lo cambia", rows: 3 },
  { key: "notes", label: "Notas", hint: "Continuidad y datos sueltos", rows: 2 },
];

export const MAX_CHARACTERS = 10;

export type AnalysisAction = "redaccion" | "consistencia" | "dialogo" | "evolucion";

export const ACTIONS: { id: AnalysisAction; label: string; character: "required" | "optional" }[] = [
  { id: "redaccion", label: "Redacción", character: "optional" },
  { id: "consistencia", label: "Consistencia", character: "required" },
  { id: "dialogo", label: "Diálogo", character: "optional" },
  { id: "evolucion", label: "Evolución", character: "required" },
];

export type ProviderId = "anthropic" | "xai";

export const PROVIDER_LABELS: Record<ProviderId, string> = { anthropic: "Claude", xai: "Grok" };

/** Events of the /api/analyze stream, one JSON object per line. */
export type AnalysisEvent =
  | { type: "text"; text: string }
  | { type: "refusal"; message: string }
  | { type: "truncated" }
  | { type: "error"; message: string };
