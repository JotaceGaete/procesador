import { CHARACTER_KEYS, type MemoryKind } from "./types";

/** What each kind of narrative memory accepts from the client. */
export const MEMORY_KINDS: Record<
  MemoryKind,
  { table: string; fields: readonly string[]; nullable?: readonly string[]; required: string; label: string }
> = {
  characters: { table: "characters", fields: CHARACTER_KEYS, required: "name", label: "El personaje necesita un nombre." },
  relationships: {
    table: "relationships",
    fields: ["from_id", "to_id", "kind", "note"],
    required: "kind",
    label: "Indica el tipo de relación.",
  },
  places: {
    table: "places",
    fields: ["name", "aliases", "description", "notes"],
    required: "name",
    label: "El lugar necesita un nombre.",
  },
  facts: {
    table: "facts",
    // status: 'suggested' (proposed by the Consejero, not canon yet) or 'approved'.
    fields: ["text", "chapter_id", "place_id", "story_time", "note", "status"],
    nullable: ["chapter_id", "place_id"],
    required: "text",
    label: "Escribe el hecho.",
  },
};

export const MAX_CHARACTERS = 40;

export function isMemoryKind(kind: string): kind is MemoryKind {
  return kind in MEMORY_KINDS;
}
