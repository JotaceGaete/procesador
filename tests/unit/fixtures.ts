import type { Character, Fact, Place } from "@/lib/types";

export const character = (p: Partial<Character> & { name: string }): Character => ({
  id: p.name,
  novel_id: "n",
  aliases: "",
  age: "",
  role: "",
  description: "",
  background: "",
  personality: "",
  motivations: "",
  fears: "",
  contradictions: "",
  values: "",
  voice: "",
  vocabulary: "",
  secrets: "",
  knows: "",
  unaware: "",
  arc: "",
  notes: "",
  ...p,
});

export const fact = (p: Partial<Fact> & { text: string }): Fact => ({
  id: p.text,
  novel_id: "n",
  chapter_id: null,
  place_id: null,
  story_time: "",
  note: "",
  status: "approved",
  character_ids: [],
  ...p,
});

export const place = (p: Partial<Place> & { name: string }): Place => ({
  id: p.name,
  novel_id: "n",
  aliases: "",
  description: "",
  notes: "",
  ...p,
});
