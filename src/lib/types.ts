export interface Project {
  id: string;
  title: string;
  synopsis: string;
  style_notes: string;
  content: string;
  updated_at: string;
}

export interface Character {
  id: string;
  project_id: string;
  name: string;
  role: string;
  background: string;
  voice: string;
  traits: string;
  arc: string;
  notes: string;
}

export type CharacterInput = Omit<Character, "id" | "project_id">;

export const CHARACTER_FIELDS: { key: keyof CharacterInput; label: string; hint: string; rows: number }[] = [
  { key: "name", label: "Nombre", hint: "", rows: 1 },
  { key: "role", label: "Rol", hint: "Protagonista, antagonista, mentor…", rows: 1 },
  { key: "background", label: "Trasfondo", hint: "Historia previa, origen, heridas, secretos", rows: 4 },
  { key: "voice", label: "Voz", hint: "Cómo habla: registro, muletillas, ritmo, lo que nunca diría", rows: 4 },
  { key: "traits", label: "Características", hint: "Personalidad, deseos, miedos, contradicciones, físico", rows: 4 },
  { key: "arc", label: "Arco narrativo", hint: "Dónde empieza, hacia dónde va, qué lo cambia", rows: 4 },
  { key: "notes", label: "Notas", hint: "Relaciones, datos sueltos, continuidad", rows: 3 },
];

export const MAX_CHARACTERS = 10;

export type AnalysisAction = "redaccion" | "consistencia" | "dialogo" | "evolucion";

export const ACTIONS: { id: AnalysisAction; label: string; needsCharacter: boolean; rewrites: boolean }[] = [
  { id: "redaccion", label: "Revisar redacción", needsCharacter: false, rewrites: true },
  { id: "consistencia", label: "Verificar consistencia", needsCharacter: true, rewrites: false },
  { id: "dialogo", label: "Mejorar diálogo", needsCharacter: false, rewrites: true },
  { id: "evolucion", label: "Evolución del personaje", needsCharacter: true, rewrites: false },
];

export type ProviderId = "anthropic" | "xai";
