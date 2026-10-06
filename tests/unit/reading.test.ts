import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote } from "@/lib/advisor/quotes";
import { freshness, measureChange, textSketch } from "@/lib/advisor/freshness";
import { parseChapterDigest, parseNovelDigest, SchemaError } from "@/lib/advisor/digest-schema";
import { extractJson, InvalidOutput } from "@/lib/ai/structured";

const IMG = "[[imagen:11111111-2222-4333-8444-555555555555]]";
const TEXT = `Elena abrió la puerta.\n\n—No vuelvas —dijo   Juan,  sin mirarla.\n\n${IMG}\n\n«Nunca había visto el mar», pensó ella.`;

test("quotes: found despite case, spacing, quote marks, dashes and ellipsis; offsets are the real text's", () => {
  const a = findQuote(TEXT, "-No vuelvas -dijo Juan, sin mirarla");
  assert.ok(a);
  assert.equal(TEXT.slice(a.start, a.end), "—No vuelvas —dijo   Juan,  sin mirarla");
  const b = findQuote(TEXT, '..."nunca había visto el mar"…');
  assert.equal(TEXT.slice(b!.start, b!.end), "Nunca había visto el mar");
  assert.equal(findQuote(TEXT, "nunca había visto la montaña"), null, "an invented quote is not found");
  assert.equal(findQuote(TEXT, "imagen:1111"), null, "never inside an image marker");
  assert.equal(findQuote(TEXT, "el"), null, "too short to mean anything");
});

test("quotes: the occurrence nearest to a position", () => {
  const t = "Llovía. Otra cosa. Llovía.";
  assert.equal(findQuote(t, "llovía", 20)!.start, 19);
  assert.equal(findQuote(t, "llovía", 0)!.start, 0);
});

const sentence = (i: number) => `En la mañana ${i} la casa seguía igual que siempre, con las ventanas cerradas.`;
const BASE = Array.from({ length: 20 }, (_, i) => sentence(i)).join("\n\n"); // ~280 words

test("freshness: same revision is current; a retouch is not; a rewrite or a lost quote is stale", () => {
  const digest = {
    source_revision: 3,
    text_sketch: textSketch(BASE),
    events: [{ quote: "En la mañana 5 la casa" }],
    revelations: [],
    threads: [],
  };
  assert.equal(freshness(digest, { revision: 3, content: "anything" }).status, "current");
  assert.equal(freshness(null, { revision: 0, content: BASE }).status, "missing");

  // A typo corrected in one sentence: a few sequences of three words.
  const retouched = BASE.replace("mañana 2 la casa", "mañana 2 la cassa");
  const t = freshness(digest, { revision: 4, content: retouched });
  assert.equal(t.status, "touched");
  assert.ok(t.change!.fraction < 0.1 && t.change!.newWords <= 3, JSON.stringify(t.change));

  // Spacing, punctuation and image markers are not changes.
  const same = measureChange(digest.text_sketch, BASE.replaceAll(".", ";").replace("\n\n", `\n\n${IMG}\n\n`));
  assert.equal(same.fraction, 0);

  // A quarter of the chapter rewritten.
  let rewritten = BASE;
  for (const i of [1, 2, 3, 4, 6]) rewritten = rewritten.replace(sentence(i), `Juan salió de madrugada hacia el puerto sin despedirse de nadie ${i}.`);
  assert.equal(freshness(digest, { revision: 4, content: rewritten }).status, "stale");

  // A long insertion (more than 300 new words) is substantial even in a long chapter.
  const insert = Array.from({ length: 320 }, (_, i) => `palabra${i}`).join(" ");
  const big = freshness(digest, { revision: 4, content: `${BASE}\n\n${insert}` });
  assert.equal(big.status, "stale");
  assert.ok(big.change!.newWords > 300);

  // A small edit that removes a quote of the digest makes it stale.
  assert.equal(freshness(digest, { revision: 4, content: BASE.replace("mañana 5 la", "mañana cinco la") }).status, "stale");
});

test("freshness: one word in a very short chapter is not a rewrite; thresholds from the environment", () => {
  const short = "Llovía sobre la casa vieja. Nadie habló en toda la cena.";
  assert.equal(measureChange(textSketch(short), `${short} Fin.`).substantial, false);
  process.env.DIGEST_CHANGE_MIN_WORDS = "1";
  process.env.DIGEST_CHANGE_PCT = "5";
  try {
    assert.equal(measureChange(textSketch(short), `${short} Fin.`).substantial, true);
  } finally {
    delete process.env.DIGEST_CHANGE_MIN_WORDS;
    delete process.env.DIGEST_CHANGE_PCT;
  }
});

test("freshness: a long chapter is estimated from its sketch (bottom-k) with small error", () => {
  const long = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" "); // ~4000 shingles
  const sk = textSketch(long);
  assert.equal(sk.h.length, 256);
  assert.equal(sk.n, 3998);
  const unchanged = measureChange(sk, long);
  assert.equal(unchanged.fraction, 0);
  assert.equal(unchanged.substantial, false);
  // Half of it replaced.
  const half = long.split(" ").map((w, i) => (i % 2 ? w : `x${i}`)).join(" ");
  const m = measureChange(sk, half);
  assert.ok(m.fraction > 0.9, String(m.fraction));
  assert.ok(m.substantial);
});

const ctx = { text: TEXT, characterIds: new Set(["juan", "elena"]), threadIds: new Set(["t1"]) };
const valid = {
  summary: "Elena abre la puerta y Juan le pide que no vuelva. Ella recuerda que nunca vio el mar.",
  events: [
    { text: "Juan la echa", characters: ["juan", "desconocido"], quote: "No vuelvas —dijo Juan" },
    { text: "Inventado", characters: [], quote: "una cita que no existe en absoluto" },
    { text: "", quote: "x" },
  ],
  presence: [
    { character: "juan", kind: "present" },
    { character: "elena", kind: "rara" },
    { character: "juan", kind: "mentioned" },
    { character: "nadie", kind: "present" },
  ],
  revelations: [{ text: "Nunca vio el mar", to: "elena", quote: "nunca había visto el mar" }],
  threads: [
    { thread: "t1", change: "advanced", quote: "" },
    { thread: null, title: "El mar", kind: "mystery", change: "opened", quote: "Nunca había visto el mar" },
    { thread: "inexistente", title: "", change: "closed" },
  ],
  notes: "Escena breve.",
};

test("digest schema: unknown ids dropped, invented quotes emptied (never stored), quotes as in the text", () => {
  const d = parseChapterDigest(valid, ctx);
  assert.deepEqual(d.events[0], { text: "Juan la echa", characters: ["juan"], quote: "No vuelvas —dijo   Juan" });
  assert.equal(d.events[1].quote, "", "not in the text: no quote");
  assert.equal(d.events.length, 2, "an event without text is dropped");
  assert.equal(d.unverified, 1);
  assert.deepEqual(d.presence, [
    { character: "juan", kind: "present" },
    { character: "elena", kind: "present" },
  ]);
  assert.equal(d.revelations[0].to, "elena");
  assert.deepEqual(
    d.threads.map((t) => [t.thread, t.title, t.change]),
    [
      ["t1", "", "advanced"],
      [null, "El mar", "opened"],
    ],
  );
});

test("digest schema: a wrong structure is rejected, so the caller retries", () => {
  assert.throws(() => parseChapterDigest([], ctx), SchemaError);
  assert.throws(() => parseChapterDigest({ ...valid, summary: "" }, ctx), SchemaError);
  assert.throws(() => parseChapterDigest({ ...valid, events: "no" }, ctx), SchemaError);
  assert.throws(() => parseNovelDigest({ summary: 3 }), SchemaError);
  assert.equal(parseNovelDigest({ summary: "Un resumen global suficientemente largo." }).summary.length > 20, true);
});

test("structured output: the JSON object inside a reply, fences and all", () => {
  assert.deepEqual(extractJson('Aquí está:\n```json\n{"a": [1, {"b": "}"}]}\n```'), { a: [1, { b: "}" }] });
  assert.throws(() => extractJson("sin json"), InvalidOutput);
  assert.throws(() => extractJson("{roto: }"), InvalidOutput);
});

test("findQuote: italics and separators don't stop a quote from being found", () => {
  const text = "Leyó *Rayuela* entera.\n\n[[separador]]\n\nAl día siguiente volvió.";
  const at = findQuote(text, "Leyó Rayuela entera");
  assert.ok(at);
  assert.equal(text.slice(at.start, at.end), "Leyó *Rayuela* entera");
  assert.ok(findQuote(text, "*Rayuela* entera"));
  assert.equal(findQuote(text, "separador"), null);
});
