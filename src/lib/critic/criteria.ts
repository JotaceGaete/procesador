/**
 * The Crítico Literario's vocabulary (docs/critico.md), shared by the server (instructions,
 * validation) and the panel (labels). Changing a key here changes what is stored.
 */

export const CRITERIA = [
  { key: "interes", label: "Interés", question: "¿El capítulo es interesante o aburrido?" },
  { key: "emocion", label: "Emoción", question: "¿Despierta emociones? ¿Cuáles y dónde?" },
  { key: "tension", label: "Tensión narrativa", question: "¿Hay algo en juego que el lector quiere ver resuelto?" },
  {
    key: "dialogos",
    label: "Diálogos",
    question: "¿Los diálogos suenan naturales y propios de cada personaje? Si casi no hay diálogo, «no aplica»",
  },
  { key: "ritmo", label: "Ritmo", question: "¿El ritmo mantiene la atención, según el tipo de capítulo que es?" },
  { key: "atmosfera", label: "Atmósfera", question: "¿El lugar, el tiempo y el clima emocional están conseguidos?" },
  {
    key: "continuar",
    label: "Deseo de continuar",
    question: "¿El lector siente deseos de pasar al siguiente capítulo?",
  },
  { key: "prosa", label: "Prosa y estilo", question: "¿La frase está a la altura: precisión, voz, sin relleno?" },
  { key: "funcion", label: "Función en la novela", question: "¿El capítulo hace falta y hace lo que la novela necesita en ese punto?" },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]["key"];

/** Only dialogue may be «no aplica»: a chapter with almost none is not penalised for it. */
export const MAY_NOT_APPLY: readonly CriterionKey[] = ["dialogos"];

export const VERDICTS = [
  { key: "excelente", label: "Excelente", when: "a la altura de una novela publicada exigente" },
  { key: "solido", label: "Sólido", when: "funciona; los reparos no lo comprometen" },
  { key: "irregular", label: "Irregular", when: "tiene partes logradas y partes que no sostienen al lector" },
  { key: "no_funciona", label: "No funciona todavía", when: "mediocre o aburrido en conjunto" },
] as const;

export type VerdictKey = (typeof VERDICTS)[number]["key"];

/** What the chapter does to the reader, as a whole (the explicit conclusion). */
export const EXPERIENCE = [
  { key: "entretiene", label: "Entretiene" },
  { key: "emociona", label: "Emociona" },
  { key: "aburre", label: "Aburre" },
  { key: "pierde_interes", label: "Pierde interés" },
] as const;

export type ExperienceKey = (typeof EXPERIENCE)[number]["key"];

/** What one stretch of the chapter does to the reader. */
export const EFFECTS = [
  { key: "engancha", label: "Engancha" },
  { key: "emociona", label: "Emociona" },
  { key: "entretiene", label: "Entretiene" },
  { key: "sorprende", label: "Sorprende" },
  { key: "inquieta", label: "Inquieta" },
  { key: "decae", label: "Decae" },
  { key: "aburre", label: "Aburre" },
] as const;

export type EffectKey = (typeof EFFECTS)[number]["key"];

export const labelOf = <K extends string>(list: readonly { key: K; label: string }[], key: K) =>
  list.find((x) => x.key === key)?.label ?? key;

/** A score as the author reads it: one decimal, Spanish comma ("7,5"). */
export const formatScore = (n: number | null) => (n === null ? "no aplica" : n.toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
