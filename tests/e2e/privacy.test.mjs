// Privacidad (docs/privacidad.md): Procesador's own lock, sessions revoked for real, and
// protected novels. The server decides; these tests hit every route in each state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, png, rest, resetDb, sessionId, textEditor } from "./helpers.mjs";
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
  const tables = ["novels", "chapters", "characters", "facts", "chapter_versions", "assets", "character_images", "manuscript_images", "story_threads", "advisor_conversations", "advisor_observations", "time_marks", "novel_protection"];
  const out = {};
  for (const t of tables) {
    const order = t === "novel_protection" ? "novel_id" : "id";
    out[t] = JSON.stringify(await rest(`${t}?${t === "novels" ? "id" : "novel_id"}=eq.${novel}&order=${order}`));
  }
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

// ---------------------------------------------------------------------------
// Protected novels
// ---------------------------------------------------------------------------

const PIN = "246810";
const ALLOWED_WHILE_LOCKED = new Set(["novels/[id]/unlock", "novels/[id]/lock", "novels/[id]/protection/recover"]);
const protectNovel = (call, novel, extra = {}) => call(`/api/novels/${novel}/protection`, "PUT", { kind: "pin", secret: PIN, ...extra });
const lockNovel = (call, novel) => call(`/api/novels/${novel}/lock`, "POST");
const unlockNovel = (call, novel, secret = PIN) => call(`/api/novels/${novel}/unlock`, "POST", { secret });
const clearAttempts = () => rest("credential_attempts?key=not.is.null", "DELETE");

test("protected and locked: every route that names the novel or any of its elements answers 423, and nothing changes", async () => {
  const cookie = await login();
  const call = client(cookie);
  const ids = await fixture(call, "Novela protegida");
  const other = (await call("/api/novels", "POST", { title: "Otra, sin proteger" })).data.id;
  const set = await protectNovel(call, ids.novel);
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.novel.protected, true);
  assert.equal(set.data.novel.locked, false, "the author who protects it stays inside");
  assert.equal(set.data.novel.idleMinutes, 15, "15 minutes by default");
  assert.equal((await lockNovel(call, ids.novel)).status, 200);
  const before = await snapshot(ids.novel);
  await clearAiLog();

  const novelRoutes = ROUTES.filter((r) => !["open", "session"].includes(r.scope));
  assert.ok(novelRoutes.length > 55);
  for (const route of novelRoutes) {
    const res = await hit(call, route, ids);
    const name = `${route.method} ${route.route}`;
    assert.ok(!JSON.stringify(res.data ?? "").includes(SECRET_TEXT), `${name}: nothing of the novel`);
    if (ALLOWED_WHILE_LOCKED.has(route.route)) continue;
    assert.equal(res.status, 423, name);
    assert.equal(res.data.code, "novel_locked", name);
    assert.deepEqual(res.data.novel, { id: ids.novel, title: "Novela protegida", kind: "pin" }, name);
  }
  assert.deepEqual(await snapshot(ids.novel), before, "nothing read into a change, written, copied or deleted");
  assert.equal((await aiLog()).length, 0, "no AI call");
  assert.equal((await call(`/api/session?novelId=${ids.novel}`)).data.novel.locked, true, "still locked after all of it");

  // The library tells it's there, not what it has.
  const lib = (await call("/api/novels")).data;
  const row = lib.find((n) => n.id === ids.novel);
  assert.deepEqual(
    { title: row.title, chapters: row.chapters, words: row.words, protected: row.protected, locked: row.locked },
    { title: "Novela protegida", chapters: null, words: null, protected: true, locked: true },
  );
  // Another novel of the same session is untouched.
  assert.equal((await call(`/api/novels/${other}`)).status, 200);
  assert.equal(lib.find((n) => n.id === other).protected, false);

  // The PIN, then everything again.
  const wrong = await unlockNovel(call, ids.novel, "135791");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, "PIN incorrecto");
  const ok = await unlockNovel(call, ids.novel);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.novel.locked, false);
  assert.match((await call(`/api/chapters/${ids.chapter}`)).data.content, new RegExp(SECRET_TEXT));
  assert.equal((await call("/api/novels")).data.find((n) => n.id === ids.novel).words, 4);
  await clearAttempts();
});

test("the PIN is never stored: only a salted scrypt hash, nowhere else in the database", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Hash" })).data.id;
  await protectNovel(call, novel);
  const [row] = await rest(`novel_protection?novel_id=eq.${novel}`);
  assert.match(row.secret_hash, /^scrypt\$ln=17,r=8,p=1\$/);
  assert.ok(!JSON.stringify(row).includes(PIN));
  for (const t of ["novels", "app_sessions", "novel_unlocks", "credential_attempts", "app_settings"]) {
    assert.ok(!JSON.stringify(await rest(t)).includes(PIN), t);
  }
  assert.equal((await call(`/api/novels/${novel}/protection`, "PUT", { kind: "pin", secret: "123" })).status, 400, "6 digits at least");
});

test("unlocking is per session, and «Bloquear novela» revokes it for real", async () => {
  const a = client(await login());
  const bCookie = await login();
  const b = client(bCookie);
  const novel = (await a("/api/novels", "POST", { title: "Por sesión" })).data.id;
  await protectNovel(a, novel);
  assert.equal((await a(`/api/novels/${novel}`)).status, 200, "open where it was protected");
  assert.equal((await b(`/api/novels/${novel}`)).status, 423, "locked in any other session");
  await unlockNovel(b, novel);
  assert.equal((await b(`/api/novels/${novel}`)).status, 200);
  await lockNovel(b, novel);
  assert.equal((await b(`/api/novels/${novel}`)).status, 423);
  assert.equal((await rest(`novel_unlocks?session_id=eq.${sessionId(bCookie)}`)).length, 0, "the unlock row is gone");
  assert.equal((await a(`/api/novels/${novel}`)).status, 200, "other sessions keep theirs");
});

test("locking Procesador, or logging out, locks its novels again", async () => {
  const cookie = await login();
  const call = client(cookie);
  const novel = (await call("/api/novels", "POST", { title: "Con Procesador" })).data.id;
  await protectNovel(call, novel);
  await call("/api/session/lock", "POST");
  await call("/api/session/unlock", "POST", { password: PASSWORD });
  assert.equal((await call(`/api/novels/${novel}`)).status, 423, "after unlocking Procesador, the PIN again");

  // Inactivity of Procesador does the same.
  await unlockNovel(call, novel);
  await rest(`app_sessions?id=eq.${sessionId(cookie)}`, "PATCH", { last_activity_at: new Date(Date.now() - 20 * 60_000).toISOString() });
  assert.equal((await call("/api/novels")).status, 423);
  assert.equal((await rest(`novel_unlocks?session_id=eq.${sessionId(cookie)}`)).length, 0);

  const c2 = await login();
  const call2 = client(c2);
  await unlockNovel(call2, novel);
  await fetch(`${BASE}/api/logout`, { method: "POST", headers: { cookie: c2 } });
  assert.equal((await rest(`novel_unlocks?session_id=eq.${sessionId(c2)}`)).length, 0);
});

test("inactivity: 15 minutes by default, 5, 15, 30 or 60; never more than 8 hours in a row", async () => {
  const cookie = await login();
  const call = client(cookie);
  const sid = sessionId(cookie);
  const novel = (await call("/api/novels", "POST", { title: "Inactiva" })).data.id;
  await protectNovel(call, novel);
  const age = (minutes) => rest(`novel_unlocks?session_id=eq.${sid}&novel_id=eq.${novel}`, "PATCH", { last_activity_at: new Date(Date.now() - minutes * 60_000).toISOString() });

  await age(14);
  const ping = await call("/api/session/ping", "POST", { novelId: novel });
  assert.equal(ping.data.novel.locked, false);
  assert.ok(ping.data.novel.remainingMs > 14 * 60_000, "the ping counted for the novel");
  await age(18);
  assert.equal((await call(`/api/chapters/${(await rest(`chapters?novel_id=eq.${novel}`))[0].id}`)).status, 423);

  await unlockNovel(call, novel);
  assert.equal((await call(`/api/novels/${novel}/protection`, "PATCH", { idleMinutes: 45 })).status, 400);
  assert.equal((await call(`/api/novels/${novel}/protection`, "PATCH", { idleMinutes: 5 })).data.novel.idleMinutes, 5);
  await age(8);
  assert.equal((await call(`/api/novels/${novel}`)).status, 423, "5 minutes (+2 of margin)");

  await unlockNovel(call, novel);
  await call(`/api/novels/${novel}/protection`, "PATCH", { idleMinutes: 60 });
  await rest(`novel_unlocks?session_id=eq.${sid}&novel_id=eq.${novel}`, "PATCH", { absolute_expires_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await call(`/api/novels/${novel}`)).status, 423, "8 hours at most");
});

test("«Ocultar título en la biblioteca»: the library and the lock screen say only «Novela protegida»", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Título secreto" })).data.id;
  await protectNovel(call, novel, { hideTitle: true });
  let row = (await call("/api/novels")).data.find((n) => n.id === novel);
  assert.equal(row.title, null, "hidden even while unlocked");
  assert.equal(row.title_hidden, true);
  await lockNovel(call, novel);
  row = (await call("/api/novels")).data.find((n) => n.id === novel);
  assert.equal(row.title, null);
  const res = await call(`/api/novels/${novel}`);
  assert.equal(res.status, 423);
  assert.equal(res.data.novel.title, null);
  assert.ok(!JSON.stringify(res.data).includes("Título secreto"));
  assert.ok(!JSON.stringify((await call(`/api/session?novelId=${novel}`)).data).includes("Título secreto"));
});

test("changing the PIN needs the current one and ends every other unlock; removing it too", async () => {
  const a = client(await login());
  const b = client(await login());
  const novel = (await a("/api/novels", "POST", { title: "Cambiar PIN" })).data.id;
  await protectNovel(a, novel);
  await unlockNovel(b, novel);
  assert.equal((await a(`/api/novels/${novel}/protection`, "PUT", { kind: "pin", secret: "135790", currentSecret: "000000" })).status, 401);
  const changed = await a(`/api/novels/${novel}/protection`, "PUT", { kind: "password", secret: "una frase larga", currentSecret: PIN });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.novel.kind, "password");
  assert.equal((await a(`/api/novels/${novel}`)).status, 200, "still open here");
  assert.equal((await b(`/api/novels/${novel}`)).status, 423, "the other session's unlock is gone");
  assert.equal((await unlockNovel(b, novel, PIN)).data.error, "Contraseña incorrecta", "the old PIN no longer opens it");
  assert.equal((await unlockNovel(b, novel, "una frase larga")).status, 200);

  assert.equal((await a(`/api/novels/${novel}/protection`, "DELETE", { secret: PIN })).status, 401);
  const removed = await a(`/api/novels/${novel}/protection`, "DELETE", { secret: "una frase larga" });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.novel.protected, false);
  const c = client(await login());
  assert.equal((await c(`/api/novels/${novel}`)).status, 200, "open to any session");
  await clearAttempts();
});

test("«Olvidé el PIN»: Procesador's password removes the protection or sets a new PIN", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Recuperar" })).data.id;
  await protectNovel(call, novel);
  await lockNovel(call, novel);
  const recover = (json) => call(`/api/novels/${novel}/protection/recover`, "POST", json);
  assert.equal((await recover({ appPassword: "no", action: "reset", kind: "pin", secret: "112233" })).status, 401);
  assert.equal((await call(`/api/novels/${novel}`)).status, 423);
  const reset = await recover({ appPassword: PASSWORD, action: "reset", kind: "pin", secret: "112233" });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.novel.locked, false);
  await lockNovel(call, novel);
  assert.equal((await unlockNovel(call, novel, PIN)).status, 401, "the forgotten PIN is gone");
  assert.equal((await unlockNovel(call, novel, "112233")).status, 200);
  await lockNovel(call, novel);
  const removed = await recover({ appPassword: PASSWORD, action: "remove" });
  assert.equal(removed.data.novel.protected, false);
  assert.equal((await call(`/api/novels/${novel}`)).status, 200);
  await clearAttempts();
});

test("too many wrong PINs: a growing wait for that novel", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Fuerza bruta" })).data.id;
  await protectNovel(call, novel);
  await lockNovel(call, novel);
  for (let i = 0; i < 4; i++) assert.equal((await unlockNovel(call, novel, "000000")).status, 401);
  const fifth = await unlockNovel(call, novel, "000000");
  assert.equal(fifth.status, 429);
  assert.equal((await unlockNovel(call, novel)).status, 429, "even the right PIN waits");
  await clearAttempts();
  assert.equal((await unlockNovel(call, novel)).status, 200);
});

test("duplicating a protected novel: the copy is born protected with the same PIN, and locked", async () => {
  const a = client(await login());
  const novel = (await a("/api/novels", "POST", { title: "Original protegida" })).data.id;
  await protectNovel(a, novel, { hideTitle: true, idleMinutes: 30 });
  const copy = (await a(`/api/novels/${novel}/duplicate`, "POST")).data.id;
  assert.ok(copy);
  const [p] = await rest(`novel_protection?novel_id=eq.${copy}`);
  assert.equal(p.idle_minutes, 30);
  assert.equal(p.hide_title, true);
  assert.equal((await a(`/api/novels/${copy}`)).status, 423, "locked, even in the session that copied it");
  assert.equal((await unlockNovel(a, copy)).status, 200, "same PIN");
});

test("images of a protected novel are never kept by the browser's cache; locking clears it", async () => {
  const cookie = await login();
  const call = client(cookie);
  const novel = (await call("/api/novels", "POST", { title: "Con imágenes" })).data.id;
  const character = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Ana" })).data.id;
  const original = png(40, 30);
  const start = await call(`/api/novels/${novel}/assets`, "POST", { file_name: "a.png", type: "image/png", bytes: original.length });
  await fetch(start.data.upload_url, { method: "PUT", headers: { "content-type": "image/png" }, body: original });
  const form = new FormData();
  form.append("display", new Blob([png(20, 15)]), "display.png");
  form.append("thumb", new Blob([png(10, 8)]), "thumb.png");
  form.append("use", JSON.stringify({ kind: "character", character_id: character }));
  assert.equal((await fetch(`${BASE}/api/assets/${start.data.asset_id}/complete`, { method: "POST", headers: { cookie }, body: form })).status, 201);
  const thumb = () => fetch(`${BASE}/api/assets/${start.data.asset_id}/thumb?v=1`, { headers: { cookie } });

  assert.match((await thumb()).headers.get("cache-control"), /max-age=600/, "an open novel's images may be cached a while");
  await protectNovel(call, novel);
  const res = await thumb();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const locked = await lockNovel(call, novel);
  assert.equal(locked.status, 200);
  assert.equal((await fetch(`${BASE}/api/novels/${novel}/lock`, { method: "POST", headers: { cookie } })).headers.get("clear-site-data"), '"cache"');
  assert.equal((await thumb()).status, 423);
});

test("browser: a protected novel by its URL shows the lock screen, never its text; the PIN opens it; «Bloquear novela» closes it", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Diario" })).data.id;
  const chapter = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapter}`, "PATCH", { content: `${SECRET_TEXT} del diario.`, revision: 0 });
  await protectNovel(call, novel);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await textEditor(ctx);
  // A scene argument left in this browser before the novel was protected.
  await ctx.addInitScript(([id, text]) => localStorage.getItem("seeded") || (localStorage.setItem(`argument:${id}`, text), localStorage.setItem("seeded", "1")), [novel, SECRET_TEXT]);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));

  await page.goto(`${BASE}/`);
  const row = page.locator(".novel-list li", { hasText: "Diario" });
  await row.getByText("Protegida").waitFor();
  assert.equal(await page.evaluate((id) => localStorage.getItem(`argument:${id}`), novel), null, "the library forgets what it kept of a protected novel");

  await page.goto(`${BASE}/novela/${novel}`);
  await page.getByRole("heading", { name: "Diario" }).waitFor();
  const pin = page.getByPlaceholder("PIN");
  assert.equal(await pin.getAttribute("inputmode"), "numeric", "the phone's number pad");
  assert.ok(!(await page.content()).includes(SECRET_TEXT));
  await pin.fill("000000");
  await page.getByRole("button", { name: "Desbloquear" }).tap();
  await page.getByRole("alert").filter({ hasText: "PIN incorrecto" }).waitFor();
  await pin.fill(PIN);
  await page.getByRole("button", { name: "Desbloquear" }).tap();
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  assert.match(await editor.inputValue(), new RegExp(SECRET_TEXT));

  // A scene argument typed now stays in memory only.
  if (!(await page.locator(".panel").isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().tap();
  await page.getByRole("button", { name: "Escribir escena" }).tap();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill(`${SECRET_TEXT} argumento`);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate((id) => localStorage.getItem(`argument:${id}`), novel), null, "never written to localStorage");
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(SECRET_TEXT));

  await page.keyboard.press("Escape");
  if (await page.locator(".panel").isVisible()) await page.locator(".panel").getByRole("button", { name: /Cerrar|Ocultar/ }).first().tap().catch(() => {});
  await page.locator(".topbar .chapter-title").tap();
  await page.getByRole("button", { name: "Bloquear novela" }).tap();
  await page.getByRole("heading", { name: "Diario" }).waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT), "unmounted: text, proposals and undo history are gone");
  assert.equal((await call(`/api/session?novelId=${novel}`)).status, 200);
  await page.goBack();
  await page.goForward();
  await page.getByPlaceholder("PIN").waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT));
  await ctx.close();
  await clearAttempts();
});

test("browser: protecting from «Novela → Protección»; Procesador's lock on top of it asks for both again", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Proteger desde la app" })).data.id;
  const chapter = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  await call(`/api/chapters/${chapter}`, "PATCH", { content: `${SECRET_TEXT} aquí.`, revision: 0 });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/novela/${novel}`);
  await page.locator("textarea.editor").waitFor();
  await page.locator(".topbar .title").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Protección" }).click();
  await dialog.getByLabel("PIN", { exact: true }).fill(PIN);
  await dialog.getByLabel("Repítelo").fill(PIN);
  assert.equal(await dialog.getByLabel(/Bloquear al cambiar de pestaña/).isChecked(), false, "off by default");
  await dialog.getByRole("button", { name: "Proteger esta novela" }).click();
  await dialog.getByText(/Protegida con PIN/).waitFor();
  assert.equal((await rest(`novel_protection?novel_id=eq.${novel}`)).length, 1);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+L");
  await page.getByRole("heading", { name: "Procesador bloqueado" }).waitFor();
  await page.getByPlaceholder("Contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await page.getByPlaceholder("PIN").waitFor();
  assert.ok(!(await page.content()).includes(SECRET_TEXT));
  await page.getByPlaceholder("PIN").fill(PIN);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await page.locator("textarea.editor").waitFor();
  await ctx.close();
});

test("browser: leaving the tab or the app locks the novel only if the author chose so (off by default)", async () => {
  const call = client(await login());
  const novel = (await call("/api/novels", "POST", { title: "Al salir" })).data.id;
  await protectNovel(call, novel);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await textEditor(ctx);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  await page.getByPlaceholder("PIN").fill(PIN);
  await page.getByRole("button", { name: "Desbloquear" }).tap();
  await page.locator("textarea.editor").waitFor();
  const leaveAndReturn = () =>
    page.evaluate(async () => {
      const set = (v) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
      set("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 1500));
      set("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

  // Off: switching apps for a moment doesn't ask for the PIN again.
  await leaveAndReturn();
  await page.waitForTimeout(500);
  assert.ok(await page.locator("textarea.editor").isVisible());

  // On: it locks as soon as the page is hidden.
  assert.equal((await call(`/api/novels/${novel}/protection`, "PATCH", { lockOnHide: true })).data.novel.lockOnHide, true);
  await page.reload();
  await page.locator("textarea.editor").waitFor();
  await leaveAndReturn();
  await page.getByPlaceholder("PIN").waitFor();
  await ctx.close();
});
