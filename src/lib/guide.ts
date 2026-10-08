import type { Guide, GuideKey, Novel } from "./types";

interface GuideField {
  key: GuideKey;
  label: string;
  hint?: string;
  rows: number;
  /** Suggestions offered while typing; the author can write anything. */
  options?: string[];
}

export const GUIDE_SECTIONS: { title: string; fields: GuideField[] }[] = [
  {
    title: "Mundo",
    fields: [
      {
        key: "genre",
        label: "Género",
        rows: 1,
        options: [
          "Novela negra",
          "Drama",
          "Realismo",
          "Thriller",
          "Histórica",
          "Fantasía",
          "Ciencia ficción",
          "Romance",
          "Terror",
        ],
      },
      { key: "period", label: "Época", hint: "Ej.: Chile, 1972–1973", rows: 1 },
      { key: "setting", label: "Lugar / ambientación", rows: 2 },
      { key: "world_rules", label: "Reglas del mundo", hint: "Lo que es posible o imposible en esta historia", rows: 2 },
    ],
  },
  {
    title: "Narración",
    fields: [
      {
        key: "narrator",
        label: "Tipo de narrador",
        rows: 1,
        options: [
          "Omnisciente",
          "Equisciente (focalizado en un personaje)",
          "Testigo",
          "Protagonista",
          "Múltiple, por capítulos",
        ],
      },
      { key: "person", label: "Persona narrativa", rows: 1, options: ["Primera persona", "Segunda persona", "Tercera persona"] },
      { key: "tense", label: "Tiempo verbal predominante", rows: 1, options: ["Pasado", "Presente"] },
      {
        key: "conventions",
        label: "Convenciones narrativas",
        hint: "Saltos temporales, cartas, cambios de punto de vista…",
        rows: 2,
      },
    ],
  },
  {
    title: "Estilo",
    fields: [
      { key: "tone", label: "Tono", hint: "Ej.: seco, melancólico, irónico", rows: 1 },
      { key: "style", label: "Estilo", hint: "Ej.: frases cortas, poca adjetivación, mucho subtexto", rows: 2 },
      { key: "pacing", label: "Ritmo", rows: 1 },
      { key: "description", label: "Nivel de descripción", rows: 1, options: ["Mínimo", "Moderado", "Detallado"] },
      { key: "dialogue", label: "Tratamiento de diálogos", hint: "Raya, comillas, acotaciones, cuánto diálogo", rows: 2 },
      {
        key: "language",
        label: "Lenguaje y regionalismos",
        hint: "Ej.: español de Chile, voseo, garabatos sin censura",
        rows: 2,
      },
      { key: "influences", label: "Influencias o referencias", rows: 2 },
    ],
  },
  {
    title: "Intención",
    fields: [
      { key: "themes", label: "Temas centrales", rows: 2 },
      { key: "avoid", label: "Cosas que quiero evitar", rows: 3 },
      {
        key: "instructions",
        label: "Instrucciones libres",
        hint: "Cualquier otra cosa que la IA deba respetar siempre",
        rows: 3,
      },
    ],
  },
];

export const GUIDE_KEYS = GUIDE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));

const MAX_GUIDE_FIELD = 4000;

export function cleanGuide(input: unknown): Guide {
  const out: Guide = {};
  if (typeof input !== "object" || !input) return out;
  for (const key of GUIDE_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) out[key] = value.slice(0, MAX_GUIDE_FIELD);
  }
  return out;
}

/**
 * Turns the author's guide into the "Prompt Maestro" sent with every AI operation: how the
 * novel is written (narrator, tone, dialogue…). Only filled fields appear; the author never
 * has to write prompt text.
 *
 * The synopsis and the author's notes are not part of it (docs/consejero.md, «Argumento
 * general»): they hold the author's plan, often with what hasn't happened yet and secrets the
 * reader doesn't know. The Asistente never receives them (so a scene can't reveal them early);
 * the Consejero reads them apart, as the plan (`authorPlan`).
 */
export function compileGuide(novel: Pick<Novel, "title" | "guide">): string {
  const g = novel.guide ?? {};
  const parts: string[] = [`# Novela: ${novel.title}`];

  for (const section of GUIDE_SECTIONS) {
    const lines = section.fields.filter((f) => g[f.key]?.trim()).map((f) => `- ${f.label}: ${g[f.key]!.trim()}`);
    if (lines.length) parts.push(`## ${section.title}\n${lines.join("\n")}`);
  }

  const hasGuide = GUIDE_KEYS.some((k) => g[k]?.trim());
  parts.push(
    hasGuide
      ? "Estas decisiones del autor sobre la novela tienen prioridad sobre tus preferencias de estilo."
      : "El autor no ha definido una guía de estilo: infiere el estilo del texto existente y respétalo.",
  );
  return `# Guía Maestra\n\n${parts.join("\n\n")}`;
}
