import { test } from "node:test";
import assert from "node:assert/strict";

test("papelera de novelas: 30 días exactos desde la eliminación", async () => {
  const { NOVEL_TRASH_DAYS, trashCutoff, purgeDate } = await import("../../src/lib/novel-trash");
  assert.equal(NOVEL_TRASH_DAYS, 30);
  const now = Date.parse("2026-10-28T12:00:00Z");
  // Lo eliminado antes de este instante (hace más de 30 días) se borra; lo demás se queda.
  assert.equal(trashCutoff(now), "2026-09-28T12:00:00.000Z");
  assert.equal(purgeDate("2026-10-01T09:30:00Z").toISOString(), "2026-10-31T09:30:00.000Z");
});
