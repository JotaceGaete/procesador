import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "@/lib/next-path";

test("safeNext: back to the page being opened, with its query; never outside the app", () => {
  assert.equal(safeNext("/novela/abc?editor=visual"), "/novela/abc?editor=visual");
  assert.equal(safeNext("/novela/abc"), "/novela/abc");
  for (const bad of [null, "", "https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "novela/abc", "/login", "/login?next=/x", "/novela\n/x"]) {
    assert.equal(safeNext(bad), "/", String(bad));
  }
});
