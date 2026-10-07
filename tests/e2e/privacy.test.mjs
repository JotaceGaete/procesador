// Privacidad (docs/privacidad.md): Procesador's own lock, sessions revoked for real, and
// protected novels. The server decides; these tests hit every route in each state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, client, login, rest, resetDb, sessionId, textEditor } from "./helpers.mjs";
import { ROUTES, routeBody, routeUrl } from "./routes.mjs";

const SECRET_TEXT = "TEXTO-SECRETO-DE-LA-NOVELA";
let browser;

before(async () => {
  await resetDb();
  await rest("credential_attempts?key=not.is.null", "DELETE");
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
});
after(async () => {
  await rest("credential_attempts?key=not.is.null", "DELETE");
  await rest("app_settings?id=eq.true", "PATCH", { app_idle_minutes: 15 });
  await browser?.close();
});

/** A novel with one of everything a route can name, all with a recognizable text. */
async function fixture(call, title = "Novela con todo") {
  const novel = (await call("/api/novels", "POST", { title })).data.id;
  const chapter = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  const saved = await call(`/api/chapters/${chapter}`, "PATCH", { content: `${SECRET_TEXT} uno dos tres.`, revision: 0 });
  assert.equal(saved.status, 200);
  const character = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", secrets: SECRET_TEXT })).data.id;
  const version = (await call(`/api/chapters/${chapter}/versions`, "POST", { reason: "manual", content: SECRET_TEXT })).data.id;
  const [asset] = await rest("assets", "POST", {
    novel_id: novel,
    status: "ready",
    file_name: "a.png",
    original_path: `${novel}/a/original.png`,
    original_type: "image/png",
    original_bytes: 10,
    width: 10,
    height: 10,
    sha256: "x",
    display_path: `${novel}/a/display.webp`,
    thumb_path: `${novel}/a/thumb.webp`,
    derived_type: "image/webp",
  });
  const [characterImage] = await rest("character_images", "POST", { novel_id: novel, character_id: character, asset_id: asset.id });
  const [manuscriptImage] = await rest("manuscript_images", "POST", { novel_id: novel, asset_id: asset.id, chapter_id: chapter });
  const [thread] = await rest("story_threads", "POST", { novel_id: novel, title: SECRET_TEXT });
  const [conversation] = await rest("advisor_conversations", "POST", { novel_id: novel, title: SECRET_TEXT });
  const [message] = await rest("advisor_messages", "POST", { novel_id: novel, conversation_id: conversation.id, role: "advisor", content: SECRET_TEXT });
  const [observation] = await rest("advisor_observations", "POST", { novel_id: novel, message_id: message.id, kind: "problem", title: SECRET_TEXT });
  return {
    novel,
    chapter,
    character,
    memory: character,
    version,
    asset: asset.id,
    assetVersion: asset.version,
    characterImage: characterImage.id,
    manuscriptImage: manuscriptImage.id,
    thread: thread.id,
    conversation: conversation.id,
    observation: observation.id,
  };
}

/** Hits a route with a body that would change something; returns { status, data }. */
async function hit(call, route, ids) {
  const url = routeUrl(route, ids);
  return call(url, route.method, route.method === "GET" ? undefined : routeBody(route, ids));
}

/** What the novel has, to prove nothing changed while it was locked. */
async function snapshot(novel) {
  const tables = ["novels", "chapters", "characters", "facts", "chapter_versions", "assets", "character_images", "manuscript_images", "story_threads", "advisor_conversations", "advisor_observations", "time_marks"];
  const out = {};
  for (const t of tables) out[t] = JSON.stringify(await rest(`${t}?${t === "novels" ? "id" : "novel_id"}=eq.${novel}&order=id`));
  out.novelCount = (await rest("novels?select=id")).length;
  return out;
}

// ---------------------------------------------------------------------------
// Procesador's lock
// ---------------------------------------------------------------------------

test("Procesador locked: every route but the session's answers 423, and nothing changes", async () => {
  const cookie = await login();
  const call = client(cookie);
  const ids = await fixture(call);
  const before = await snapshot(ids.novel);

  const lock = await call("/api/session/lock", "POST");
  assert.equal(lock.status, 200);
  assert.equal(lock.data.app.locked, true);

  for (const route of ROUTES.filter((r) => r.scope !== "open")) {
    const res = await hit(call, route, ids);
    if (route.route === "session") {
      assert.equal(res.status, 200);
      assert.equal(res.data.app.locked, true);
    } else if (route.route === "session/lock") {
      assert.equal(res.status, 200);
    } else if (route.route === "session/unlock") {
      assert.equal(res.status, 401, "no password, no unlock");
    } else {
      assert.equal(res.status, 423, `${route.method} ${route.route}`);
      assert.equal(res.data.code, "app_locked", `${route.method} ${route.route}`);
      assert.ok(!JSON.stringify(res.data).includes(SECRET_TEXT));
    }
  }
  assert.deepEqual(await snapshot(ids.novel), before, "nothing was read into a change or written");

  // A wrong password doesn't open it; the right one does.
  const wrong = await call("/api/session/unlock", "POST", { password: "no" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.code, "wrong_credential");
  assert.equal((await call(`/api/chapters/${ids.chapter}`)).status, 423);
  const ok = await call("/api/session/unlock", "POST", { password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.app.locked, false);
  assert.ok(ok.data.app.remainingMs > 14 * 60_000);
  const chapter = await call(`/api/chapters/${ids.chapter}`);
  assert.equal(chapter.status, 200);
  assert.match(chapter.data.content, new RegExp(SECRET_TEXT));
  await rest("credential_attempts?key=not.is.null", "DELETE");
});

test("inactivity: past the idle time (and its margin) the server locks the session by itself", async () => {
  const cookie = await login();
  const call = client(cookie);
  const sid = sessionId(cookie);
  const status = await call("/api/session");
  assert.equal(status.data.app.idleMinutes, 15, "15 minutes by default");

  // Reading without typing: the browser's ping keeps it open.
  await rest(`app_sessions?id=eq.${sid}`, "PATCH", { last_activity_at: new Date(Date.now() - 14 * 60_000).toISOString() });
  assert.equal((await call("/api/session/ping", "POST", {})).status, 200);
  assert.ok((await call("/api/session")).data.app.remainingMs > 14 * 60_000, "the ping counted as activity");

  // The status doesn't count as activity.
  await rest(`app_sessions?id=eq.${sid}`, "PATCH", { last_activity_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  await call("/api/session");
  assert.ok((await call("/api/session")).data.app.remainingMs < 6 * 60_000);

  await rest(`app_sessions?id=eq.${sid}`, "PATCH", { last_activity_at: new Date(Date.now() - 18 * 60_000).toISOString() });
  const res = await call("/api/novels");
  assert.equal(res.status, 423);
  assert.equal(res.data.code, "app_locked");
  assert.equal((await call("/api/session")).data.app.locked, true);
});

test("the idle time is a setting: 15, 30, 60, 120 or 240 minutes", async () => {
  const call = client(await login());
  assert.equal((await call("/api/settings")).data.appIdleMinutes, 15);
  assert.equal((await call("/api/settings", "PATCH", { appIdleMinutes: 45 })).status, 400);
  assert.equal((await call("/api/settings", "PATCH", { appIdleMinutes: 60 })).data.appIdleMinutes, 60);
  assert.equal((await call("/api/session")).data.app.idleMinutes, 60);
  await call("/api/settings", "PATCH", { appIdleMinutes: 15 });
});

test("logout revokes the session on the server: a copy of the cookie stops working", async () => {
  const cookie = await login();
  const call = client(cookie);
  assert.equal((await call("/api/novels")).status, 200);
  await fetch(`${BASE}/api/logout`, { method: "POST", headers: { cookie } });
  assert.equal((await call("/api/novels")).status, 401);
  assert.equal((await call("/api/session")).status, 401);
  assert.ok((await rest(`app_sessions?id=eq.${sessionId(cookie)}`))[0].revoked_at);
});

test("too many wrong passwords: a growing wait, for logins and unlocking alike", async () => {
  await rest("credential_attempts?key=not.is.null", "DELETE");
  const tryLogin = (password) =>
    fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 4; i++) assert.equal((await tryLogin("mal")).status, 401);
  const fifth = await tryLogin("mal");
  assert.equal(fifth.status, 429);
  assert.match((await fifth.json()).error, /Vuelve a intentarlo en (29|30) s\./);
  assert.equal((await tryLogin(PASSWORD)).status, 429, "even the right one waits");
  await rest("credential_attempts?key=not.is.null", "DELETE");
  assert.equal((await tryLogin(PASSWORD)).status, 200);
});

test("browser: «Bloquear» unmounts the novel and asks for the password; unlocking brings it back", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Bloqueo en el navegador" })).data.id;
  const chapter = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapter}`, "PATCH", { content: `${SECRET_TEXT} en pantalla.`, revision: 0 });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  // Something typed and not saved yet: locking saves it first.
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Añadido justo antes.");
  // «Bloquear Procesador» lives in the chapter list (the top bar has no room for it).
  if (!(await page.locator("nav.chapters").isVisible())) await page.locator(".topbar .chapter-title").click();
  await page.getByRole("button", { name: "Bloquear Procesador" }).click();
  await page.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT), "the text left the page");
  assert.match((await call(`/api/chapters/${chapter}`)).data.content, /Añadido justo antes\./, "saved before locking");

  // Reloading or going straight to the URL doesn't get past it.
  await page.goto(`${BASE}/novela/${novel}`);
  await page.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT));

  await page.getByPlaceholder("Contraseña").fill("no");
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await page.getByRole("alert").filter({ hasText: "Contraseña incorrecta" }).waitFor();
  await page.getByPlaceholder("Contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await editor.waitFor();
  assert.match(await editor.inputValue(), new RegExp(SECRET_TEXT));
  await rest("credential_attempts?key=not.is.null", "DELETE");

  // Ctrl+Shift+L locks too; a second tab of the same session follows.
  const other = await ctx.newPage();
  await other.goto(`${BASE}/`);
  await other.getByRole("heading", { name: "Biblioteca" }).waitFor();
  await page.keyboard.press("Control+Shift+L");
  await page.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  await other.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  await ctx.close();
});

test("browser: past the idle time the open page locks on its return, without any request of its own", async () => {
  const cookie = await login();
  const call = client(cookie);
  const novel = (await call("/api/novels", "POST", { title: "Inactiva" })).data.id;
  const chapter = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapter}`, "PATCH", { content: `${SECRET_TEXT} quieto.`, revision: 0 });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await textEditor(ctx);
  const page = await ctx.newPage();
  await ctx.addCookies([{ name: "procesador_session", value: cookie.split("=")[1], url: BASE }]);
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await rest(`app_sessions?id=eq.${sessionId(cookie)}`, "PATCH", { last_activity_at: new Date(Date.now() - 20 * 60_000).toISOString() });
  // The phone comes back from the app switcher.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT));
  await ctx.close();
});
