import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMON_RELATIONS, relationKey, resolveRelation, tidyRelation, usedRelations } from "@/lib/relations";

test("relationKey: case, spacing and accents do not count; ñ does", () => {
  const same = ["desconfía de", "desconfia de", "Desconfía de", "  DESCONFIA   de ", "desconfía de"];
  for (const s of same) assert.equal(relationKey(s), "desconfia de", s);
  assert.equal(relationKey("Ex amante de"), relationKey("ex  amante\tde"));
  assert.equal(relationKey("pingüino de"), relationKey("pinguino de"));
  assert.notEqual(relationKey("año de"), relationKey("ano de"));
  assert.notEqual(relationKey("amante de"), relationKey("ex amante de"));
});

test("tidyRelation: only the spacing; case and accents stay as written", () => {
  assert.equal(tidyRelation("  Amante   de \n"), "Amante de");
  assert.equal(tidyRelation("Protegido de"), "Protegido de");
  assert.equal(tidyRelation("informante  DE"), "informante DE");
});

test("usedRelations: the novel's own kinds, once each (first form wins), without the common ones", () => {
  const rels = [
    { id: "1", kind: "amante de" },
    { id: "2", kind: "Amante  de" },
    { id: "3", kind: "socio de" },
    { id: "4", kind: "Desconfia de" }, // a variant of a common one: not a custom kind
    { id: "5", kind: "Padrino de" },
  ];
  // «amante de» and «desconfía de» are common: offered there, not repeated as the novel's own.
  assert.ok(COMMON_RELATIONS.includes("amante de"));
  assert.deepEqual(usedRelations(rels), ["Padrino de", "socio de"]);
  assert.deepEqual(usedRelations([{ id: "1", kind: "vecino de" }, { id: "2", kind: "Vecino de" }]), ["vecino de"]);
  // The relationship being edited does not count.
  assert.deepEqual(usedRelations([{ id: "1", kind: "vecino de" }], "1"), []);
});

test("resolveRelation: the form already used in the novel, else the common one, else what was typed", () => {
  const rels = [
    { id: "1", kind: "Ex amante de" },
    { id: "2", kind: "Desconfía de" },
  ];
  assert.deepEqual(resolveRelation("ex  AMANTE de ", rels), { kind: "Ex amante de", reused: "Ex amante de" });
  assert.deepEqual(resolveRelation("Ex amante de", rels), { kind: "Ex amante de", reused: null });
  // The novel's form wins over the common one.
  assert.deepEqual(resolveRelation("desconfia de", rels), { kind: "Desconfía de", reused: "Desconfía de" });
  // Common, not used yet in the novel.
  assert.deepEqual(resolveRelation("Le debe a", []), { kind: "le debe a", reused: "le debe a" });
  // New: kept as written (only the spacing tidied).
  assert.deepEqual(resolveRelation("  Informante   de ", rels), { kind: "Informante de", reused: null });
  assert.deepEqual(resolveRelation("   ", rels), { kind: "", reused: null });
  // Editing the only relationship with a kind: it can be rewritten (case fixed) freely.
  assert.deepEqual(resolveRelation("ex amante de", rels, "1"), { kind: "ex amante de", reused: null });
});
