// "Desarrollar escena" means dramatizing, not summarizing: the same literary base for every
// model, a length range (a target, not a quota), a short reminder only for Grok, and, when a
// Media/Larga scene comes out well below what was asked, a discreet "Ampliar" that is never
// automatic and develops the same scene (desktop and phone).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb, textEditor } from "./helpers.mjs";

const SHORT = "Juan dejó las llaves sobre la mesa. Elena no levantó la vista.\n\n—¿Café? —dijo él.";
let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Extensión" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapterId}`, "PATCH", { content: "Uno.\n\nDos.", revision: 0 });
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const scene = (provider, extra = {}) =>
  call("/api/assist", "POST", {
    novelId: novel,
    chapterId,
    content: "Uno.\n\nDos.",
    cursor: 4,
    provider,
    mode: "scene",
    argument: "Juan y Elena discuten en la cocina.",
    length: "media",
    ...extra,
  });
/** System and user text as each provider receives them. */
function parts(entry) {
  const b = entry.body;
  // Claude gets the same text in separate blocks (for caching); joined as the others receive it.
  if (entry.provider === "anthropic") return { system: b.system.map((x) => x.text).join("\n\n"), user: b.messages[0].content };
  if (entry.provider === "openai") return { system: b.instructions, user: b.input };
  return { system: b.messages[0].content, user: b.messages[1].content };
}

test("los tres modelos reciben la misma base literaria y el rango; sólo Grok la nota", async () => {
  const seen = {};
  for (const provider of ["anthropic", "openai", "xai"]) {
    await clearAiLog();
    const r = await scene(provider);
    assert.ok(events(r.data).some((e) => e.type === "text"), provider);
    const entry = (await aiLog())[0];
    assert.equal(entry.provider, provider);
    seen[provider] = parts(entry);
  }
  for (const [provider, { system, user }] of Object.entries(seen)) {
    assert.match(system, /Desarrollar una escena es dramatizarla, no resumirla/, provider);
    assert.match(system, /Contención no es brevedad/, provider);
    assert.match(user, /Extensión: alrededor de 800–1\.000 palabras \(media\)\./, provider);
    assert.match(user, /Escribe la escena completa, desarrollada: alrededor de 800–1\.000 palabras\. Es una orientación, no una cuota/, provider);
  }
  assert.equal(seen.anthropic.system, seen.openai.system, "GPT and Claude: the same instructions, word for word");
  assert.equal(seen.anthropic.user, seen.openai.user, "GPT and Claude: the same task");
  // Grok: the same base plus its block (with the Marta/Juan example), and a one-line reminder.
  const block = /\n\nEscenificar, no resumir:\n[\s\S]*sin levantar la vista\.»/;
  assert.match(seen.xai.system, block);
  assert.match(seen.xai.system, /Resumen \(no\): «Marta estaba nerviosa y le pidió a Juan que se fuera\.»/);
  assert.doesNotMatch(seen.openai.system, /Escenificar, no resumir|Marta estaba nerviosa/);
  assert.match(seen.xai.user, /Recuerda: no copies las frases del argumento; escenifícalas momento a momento, hasta alrededor de 800–1\.000 palabras\./);
  assert.doesNotMatch(seen.openai.user, /Recuerda: no copies/);
  // Those are Grok's only differences.
  const common = seen.openai.system.split("\n\n# Guía Maestra")[0];
  assert.ok(seen.xai.system.startsWith(`${common}\n\nEscenificar, no resumir:`), "the block goes right after the common base");
  assert.equal(seen.xai.system.replace(block, ""), seen.openai.system);
  assert.equal(seen.xai.user.replace(/\n\nRecuerda: no copies[^\n]*/, ""), seen.openai.user);
});

test("Ampliar (API): la escena escrita va como borrador, con el mismo contexto", async () => {
  await clearAiLog();
  const r = await scene("xai", { expand: SHORT });
  assert.ok(events(r.data).some((e) => e.type === "text" && e.text.includes("ESCENA-AMPLIADA")));
  const { user } = parts((await aiLog())[0]);
  assert.ok(user.includes(`<borrador>\n${SHORT}\n</borrador>`));
  assert.match(user, /Conserva todo lo que ocurre, en el mismo orden/);
  assert.match(user, /No añadas acontecimientos nuevos para ganar extensión/);
  assert.match(user, /<argumento>\nJuan y Elena discuten en la cocina\.\n<\/argumento>/);
  assert.doesNotMatch(user, /Recuerda: no copies/, "the widening task says it already");
  // The block stays in Grok's system prompt when widening too.
  assert.match(parts((await aiLog())[0]).system, /Escenificar, no resumir:/);
});
