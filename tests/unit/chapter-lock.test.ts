import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTarget, lockedChapterMessage, wrongChapterMessage } from "../../src/lib/chapter-lock";

const names: Record<string, string> = { c8: "Capítulo 8", c9: "Capítulo 9" };
const label = (id: string) => names[id] ?? null;

test("a proposal applies only in the chapter it was written for, open and unlocked", () => {
  assert.deepEqual(
    checkTarget({ proposalChapterId: "c8", openChapterId: "c8", editorChapterId: "c8", locked: false, action: "insert", label }),
    { ok: true },
  );
});

test("another chapter open: stopped, with the message the author reads", () => {
  const r = checkTarget({ proposalChapterId: "c8", openChapterId: "c9", editorChapterId: "c9", locked: false, action: "insert", label });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "other-chapter");
  assert.equal(
    r.ok === false && r.message,
    "Esta propuesta fue preparada para «Capítulo 8», pero ahora estás en «Capítulo 9». La inserción se ha detenido para evitar modificar el capítulo equivocado.",
  );
  const replace = checkTarget({ proposalChapterId: "c8", openChapterId: "c9", editorChapterId: "c9", locked: false, action: "replace", label });
  assert.match(replace.ok === false ? replace.message : "", /El reemplazo se ha detenido/);
});

test("the editor still showing the old chapter (a switch half done) is a mismatch too", () => {
  // The workspace already says chapter 9, the mounted editor is still chapter 8's (or the reverse).
  for (const [open, editor] of [
    ["c9", "c8"],
    ["c8", "c9"],
  ]) {
    const r = checkTarget({ proposalChapterId: "c8", openChapterId: open, editorChapterId: editor, locked: false, action: "insert", label });
    assert.equal(r.ok === false && r.reason, "other-chapter", `${open}/${editor}`);
  }
});

test("no editor mounted: nothing is applied", () => {
  const r = checkTarget({ proposalChapterId: "c8", openChapterId: "c8", editorChapterId: null, locked: false, action: "insert", label });
  assert.equal(r.ok === false && r.reason, "no-editor");
});

test("a locked chapter refuses its own proposals", () => {
  const r = checkTarget({ proposalChapterId: "c8", openChapterId: "c8", editorChapterId: "c8", locked: true, action: "replace", label });
  assert.equal(r.ok === false && r.reason, "locked");
  assert.equal(r.ok === false && r.message, lockedChapterMessage("Capítulo 8", "replace"));
  assert.match(lockedChapterMessage("Capítulo 8", "insert"), /bloqueado.*insertar/);
});

test("the chapter is checked before the lock: a proposal of 8 in locked 9 says which chapter it belongs to", () => {
  const r = checkTarget({ proposalChapterId: "c8", openChapterId: "c9", editorChapterId: "c9", locked: true, action: "insert", label });
  assert.equal(r.ok === false && r.reason, "other-chapter");
});

test("a proposal of a chapter that no longer exists", () => {
  assert.equal(
    wrongChapterMessage(null, "Capítulo 9", "insert"),
    "Esta propuesta fue preparada para un capítulo que ya no existe, pero ahora estás en «Capítulo 9». La inserción se ha detenido para evitar modificar el capítulo equivocado.",
  );
  const r = checkTarget({ proposalChapterId: "gone", openChapterId: "c9", editorChapterId: "c9", locked: false, action: "insert", label });
  assert.match(r.ok === false ? r.message : "", /ya no existe/);
});
