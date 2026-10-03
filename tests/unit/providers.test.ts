import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error -- plain ESM helper shared with the E2E stack
import { handleAI } from "../mock-ai.mjs";

const log: { provider: string; body: Record<string, any> }[] = [];
let server: http.Server;
type Providers = typeof import("@/lib/ai/providers");
let providers: Providers;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handleAI(req, res, body, log) || (res.writeHead(404), res.end()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "test-a",
    ANTHROPIC_BASE_URL: `${base}/anthropic`,
    OPENAI_API_KEY: "test-o",
    OPENAI_BASE_URL: `${base}/openai`,
    XAI_API_KEY: "test-x",
    XAI_BASE_URL: `${base}/xai`,
  });
  providers = await import("@/lib/ai/providers");
});
after(() => server.close());

async function collect(
  id: "anthropic" | "openai" | "xai",
  req: { instructions?: string; manuscript?: string | null; role?: "write" | "advise" | "digest" } = {},
) {
  const events: { type: string; text?: string; [k: string]: unknown }[] = [];
  const stream = providers.getProvider(id)!.stream({
    instructions: req.instructions ?? "INSTRUCCIONES",
    manuscript: req.manuscript ?? null,
    project: "GUIA Y MEMORIA",
    prompt: "TAREA",
    signal: new AbortController().signal,
    role: req.role,
  });
  for await (const e of stream) events.push(e as (typeof events)[number]);
  return { events, text: events.map((e) => e.text ?? "").join(""), sent: log.at(-1)!.body };
}

test("all three providers are configured from the environment", () => {
  assert.deepEqual(providers.availableProviders(), ["anthropic", "openai", "xai"]);
  process.env.AI_PROVIDER = "openai";
  assert.equal(providers.defaultProvider(), "openai");
  delete process.env.AI_PROVIDER;
});

test("Claude: streams text; manuscript in its own cached block", async () => {
  const plain = await collect("anthropic");
  assert.match(plain.text, /<reescritura>/);
  assert.equal(plain.sent.model, "claude-opus-5-5");
  assert.equal(plain.sent.output_config.effort, "medium");
  assert.equal(plain.sent.system.length, 2);
  assert.ok(!JSON.stringify(plain.sent.system).includes("cache_control"));
  assert.equal(plain.sent.messages[0].content, "TAREA");
  const withNovel = await collect("anthropic", { manuscript: "NOVELA" });
  assert.equal(withNovel.sent.system[1].text, "NOVELA");
  assert.deepEqual(withNovel.sent.system[1].cache_control, { type: "ephemeral" });
});

test("GPT (Responses API): instructions + input, streamed text", async () => {
  const { text, sent } = await collect("openai");
  assert.match(text, /<reescritura>Texto propuesto/);
  assert.equal(sent.model, "gpt-5.5");
  assert.equal(sent.stream, true);
  assert.equal(sent.input, "TAREA");
  assert.ok(sent.instructions.startsWith("INSTRUCCIONES") && sent.instructions.includes("GUIA Y MEMORIA"));
});

test("Grok: system + user messages, streamed text", async () => {
  const { text, sent } = await collect("xai");
  assert.match(text, /<reescritura>/);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[1].content, "TAREA");
});

test("refusals become a 'refusal' event on every provider", async () => {
  for (const id of ["anthropic", "openai", "xai"] as const) {
    const { events } = await collect(id, { instructions: "REFUSE-ME" });
    assert.equal(events.at(-1)?.type, "refusal", id);
  }
});

test("every provider reports real usage (input includes cached), before a refusal", async () => {
  for (const id of ["anthropic", "openai", "xai"] as const) {
    const { events } = await collect(id);
    const u = events.find((e) => e.type === "usage");
    assert.ok(u, id);
    assert.equal(u.input, 1200, id);
    assert.equal(u.cached, 1000, id);
    assert.equal(u.output, 30, id);
    assert.equal(u.costUsd, null, `${id}: sin AI_PRICES no hay costo`);
    const refused = await collect(id, { instructions: "REFUSE-ME" });
    assert.deepEqual(refused.events.slice(-2).map((e) => e.type), ["usage", "refusal"], id);
  }
  assert.equal(log.at(-1)!.body.stream_options.include_usage, true);
});

test("roles pick their own model, falling back to the writing one; prices give a cost", async () => {
  const models = await import("@/lib/ai/models");
  assert.equal(models.modelFor("anthropic", "advise"), "claude-opus-5-5");
  process.env.ANTHROPIC_MODEL_ADVISE = "modelo-consejero";
  process.env.OPENAI_MODEL_DIGEST = "modelo-barato";
  process.env.AI_PRICES = JSON.stringify({ "modelo-consejero": { input: 10, cached: 1, output: 50 } });
  try {
    assert.equal(models.modelFor("anthropic", "advise"), "modelo-consejero");
    assert.equal(models.modelFor("anthropic", "digest"), "claude-opus-5-5");
    assert.equal(models.modelFor("openai", "digest"), "modelo-barato");
    assert.equal(models.modelFor("openai"), "gpt-5.5");
    const { events, sent } = await collect("anthropic", { role: "advise" });
    assert.equal(sent.model, "modelo-consejero");
    const u = events.find((e) => e.type === "usage")!;
    // 200 fresh × 10 + 1000 cached × 1 + 30 out × 50, per million.
    assert.ok(Math.abs((u.costUsd as number) - 4500 / 1e6) < 1e-12);
    process.env.AI_PRICES = "not json";
    assert.equal(models.costUsd("modelo-consejero", 1, 0, 1), null);
  } finally {
    delete process.env.ANTHROPIC_MODEL_ADVISE;
    delete process.env.OPENAI_MODEL_DIGEST;
    delete process.env.AI_PRICES;
  }
  assert.equal(models.confirmTokens(), 150_000);
  process.env.AI_CONFIRM_TOKENS = "5000";
  assert.equal(models.confirmTokens(), 5000);
  delete process.env.AI_CONFIRM_TOKENS;
});

test("a rejected key gives a readable error", async () => {
  process.env.XAI_API_KEY = "wrong";
  await assert.rejects(collect("xai"), (e) => providers.getProvider("xai")!.describeError(e).includes("API key"));
  process.env.XAI_API_KEY = "test-x";
});

test("an aborted request stops the upstream call", async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = providers
    .getProvider("anthropic")!
    .stream({ instructions: "x", manuscript: null, project: "y", prompt: "z", signal: controller.signal });
  await assert.rejects(stream.next());
});
