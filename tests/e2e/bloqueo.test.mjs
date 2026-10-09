// Bloqueo de capítulos (docs/bloqueo-capitulos.md): un capítulo revisado y bloqueado jamás se
// modifica por accidente, y una propuesta del Asistente preparada para un capítulo jamás se
// inserta en silencio en otro. Lo comprueba el servidor (423) y la base, no sólo la pantalla.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import crypto from "node:crypto";
import { BASE, PASSWORD, STACK, client, login, resetDb, textEditor } from "./helpers.mjs";

const UNO = "Primer capítulo.\n\nÚltimo párrafo del uno.";
const DOS = "Segundo capítulo.\n\nÚltimo párrafo del dos.";
const SCENE_START = "Juan dejó las llaves sobre la mesa.";
let call, browser, novel, ch1, ch2;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chapter = async (id) => (await call(`/api/chapters/${id}`)).data;
async function setText(id, content) {
  const c = await chapter(id);
  if (c.locked) await call(`/api/chapters/${id}`, "PATCH", { locked: false });
  const r = await call(`/api/chapters/${id}`, "PATCH", { content, revision: c.revision });
  assert.equal(r.status, 200);
}

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Bloqueo" })).data.id;
  ch1 = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  ch2 = (await call(`/api/novels/${novel}/chapters`, "POST", {})).data.id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

// ---------------------------------------------------------------------------
// API: persistence and the server's own checks
// ---------------------------------------------------------------------------

test("api: chapters start unlocked; lock and unlock persist and never change the text", async () => {
  await setText(ch1, UNO);
  const outline = (await call(`/api/novels/${novel}`)).data.chapters;
  assert.deepEqual(
    outline.map((c) => c.locked),
    [false, false],
  );
  const before = await chapter(ch1);
  assert.equal(before.locked, false);

  const r = await call(`/api/chapters/${ch1}`, "PATCH", { locked: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.locked, true);
  assert.ok(r.data.locked_at);
  const locked = await chapter(ch1);
  assert.equal(locked.locked, true);
  assert.equal(locked.content, before.content);
  assert.equal(locked.revision, before.revision, "locking doesn't touch the revision");
  assert.equal((await call(`/api/novels/${novel}`)).data.chapters[0].locked, true, "the index shows it");

  const u = await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
  assert.equal(u.data.locked, false);
  assert.equal(u.data.locked_at, null);
  assert.equal((await chapter(ch1)).content, before.content);
});

test("api: a locked chapter refuses every change (423): text, title, trash, AI copy, restore", async () => {
  await setText(ch1, UNO);
  const { revision } = await chapter(ch1);
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: true });

  const attempts = [
    ["texto con su revisión", "PATCH", `/api/chapters/${ch1}`, { content: "Pisado", revision }],
    ["texto vacío (borrar todo)", "PATCH", `/api/chapters/${ch1}`, { content: "", revision }],
    ["título", "PATCH", `/api/chapters/${ch1}`, { title: "Otro título" }],
    ["papelera", "DELETE", `/api/chapters/${ch1}`, undefined],
    ["copia antes de aplicar la IA", "POST", `/api/chapters/${ch1}/versions`, { reason: "ai", content: UNO }],
    ["copia antes de restaurar", "POST", `/api/chapters/${ch1}/versions`, { reason: "restore", content: UNO }],
  ];
  for (const [what, method, path, body] of attempts) {
    const r = await call(path, method, body);
    assert.equal(r.status, 423, what);
    assert.match(r.data.error, /bloqueado/i, what);
  }
  // Unlocking and writing in one request: refused, nothing written, still locked.
  const mixed = await call(`/api/chapters/${ch1}`, "PATCH", { locked: false, content: "Colado", revision });
  assert.equal(mixed.status, 400);

  const after = await chapter(ch1);
  assert.equal(after.content, UNO);
  assert.equal(after.title, "Capítulo 1");
  assert.equal(after.revision, revision);
  assert.equal(after.locked, true);

  // A named version (it changes nothing) and reading are still fine.
  assert.equal((await call(`/api/chapters/${ch1}/versions`, "POST", { reason: "manual", label: "Revisado" })).status, 201);
  // Reordering doesn't change the text: allowed.
  const reorder = await call(`/api/novels/${novel}/chapters`, "PUT", { ids: [ch2, ch1] });
  assert.equal(reorder.status, 200);
  assert.equal(reorder.data.find((c) => c.id === ch1).locked, true);
  await call(`/api/novels/${novel}/chapters`, "PUT", { ids: [ch1, ch2] });

  // Another chapter is untouched by the lock.
  const two = await chapter(ch2);
  assert.equal((await call(`/api/chapters/${ch2}`, "PATCH", { content: DOS, revision: two.revision })).status, 200);

  // Unlocked, the same save goes through (same revision: locking didn't bump it).
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
  assert.equal((await call(`/api/chapters/${ch1}`, "PATCH", { content: "Editado tras desbloquear", revision })).status, 200);
});

test("api: a stale tab (old revision) saving over a chapter locked elsewhere gets 423, not a conflict", async () => {
  await setText(ch1, UNO);
  const stale = await chapter(ch1); // what the other tab loaded
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: true }); // this device locks it
  const r = await call(`/api/chapters/${ch1}`, "PATCH", { content: "Texto de la pestaña vieja", revision: stale.revision });
  assert.equal(r.status, 423);
  assert.equal((await chapter(ch1)).content, UNO);
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
});

test("api: race between saves and the lock: whatever wins, nothing is written after the lock", async () => {
  for (let round = 0; round < 8; round++) {
    await setText(ch1, UNO);
    const { revision } = await chapter(ch1);
    const text = `Guardado de la vuelta ${round}`;
    const [save, lock] = await Promise.all([
      call(`/api/chapters/${ch1}`, "PATCH", { content: text, revision }),
      call(`/api/chapters/${ch1}`, "PATCH", { locked: true }),
    ]);
    assert.equal(lock.status, 200);
    const now = await chapter(ch1);
    assert.equal(now.locked, true);
    if (save.status === 200) assert.equal(now.content, text, "saved before the lock");
    else {
      assert.equal(save.status, 423, "refused after the lock");
      assert.equal(now.content, UNO);
    }
    // A late save of the same tab, after the lock, never lands.
    const late = await call(`/api/chapters/${ch1}`, "PATCH", { content: "Tardío", revision: now.revision });
    assert.equal(late.status, 423);
    assert.equal((await chapter(ch1)).content, now.content);
  }
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
});

/** A row straight into the database (as the server's service role), for data this file doesn't upload. */
async function insertRow(table, row) {
  const key = process.env.E2E_SERVICE_KEY;
  const res = await fetch(`${STACK}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  assert.ok(res.ok, `${table}: ${res.status} ${await res.text()}`);
}

test("api: images of the book placed in a locked chapter can't be changed or deleted", async () => {
  const asset = crypto.randomUUID();
  const image = crypto.randomUUID();
  await insertRow("assets", {
    id: asset, novel_id: novel, status: "ready", file_name: "a.png", original_path: `${novel}/${asset}/o`, original_type: "image/png",
    original_bytes: 10, width: 100, height: 100, sha256: "abc", display_path: `${novel}/${asset}/d`, thumb_path: `${novel}/${asset}/t`, derived_type: "image/webp",
  });
  await insertRow("manuscript_images", { id: image, novel_id: novel, asset_id: asset, alt: "Antes" });
  await setText(ch1, `${UNO}\n\n[[imagen:${image}]]`); // placed in chapter 1 by the save
  await call(`/api/chapters/${ch1}`, "PATCH", { locked: true });

  const patch = await call(`/api/manuscript-images/${image}`, "PATCH", { alt: "Después", caption: "Pie nuevo" });
  assert.equal(patch.status, 423);
  const del = await call(`/api/manuscript-images/${image}`, "DELETE");
  assert.equal(del.status, 423);
  const replace = await call(`/api/manuscript-images/${image}/replace`, "POST", { asset_id: asset, scope: "use" });
  assert.equal(replace.status, 423);
  const list = (await call(`/api/novels/${novel}/manuscript-images`)).data;
  const img = list.find((i) => i.id === image);
  assert.equal(img.alt, "Antes");
  assert.equal(img.chapter_id, ch1);

  await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
  assert.equal((await call(`/api/manuscript-images/${image}`, "PATCH", { alt: "Después" })).status, 200, "unlocked, it changes");
  await setText(ch1, UNO);
});

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

const DEVICES = [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  {
    name: "teléfono",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    mobile: true,
  },
];

async function open(device, { visual = false } = {}) {
  const ctx = await browser.newContext(device.context);
  if (!visual) await textEditor(ctx);
  await ctx.addInitScript((id) => localStorage.setItem(`chapter:${id.novel}`, id.ch1), { novel, ch1 });
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = visual ? page.locator(".visual-text") : page.locator("textarea.editor");
  await editor.waitFor();
  const press = (loc) => (device.mobile ? loc.tap() : loc.click());
  const panel = page.locator("aside.panel");
  const lock = page.locator(".topbar .lock-toggle");
  const nav = page.locator("nav.chapters");
  const goTo = async (n) => {
    if (!(await nav.isVisible())) await press(page.locator(".topbar .chapter-title"));
    await press(nav.locator("li .chapter-name").nth(n - 1));
    await page.locator(".topbar .chapter-title", { hasText: `Capítulo ${n}` }).waitFor();
  };
  const openPanel = async () => {
    if (!(await panel.isVisible())) await press(page.getByRole("button", { name: "Asistente", exact: true }).first());
  };
  const generate = async () => {
    await openPanel();
    await press(panel.getByRole("button", { name: "Escribir escena" }));
    await page.getByPlaceholder(/Qué ocurre en la escena/).fill("Juan vuelve tarde.");
    await press(panel.getByRole("button", { name: "Desarrollar escena" }));
    await panel.getByRole("button", { name: "Insertar al final" }).waitFor();
  };
  return { ctx, page, editor, press, panel, lock, nav, goTo, openPanel, generate };
}

for (const device of DEVICES) {
  test(`${device.name}: bloquear con el candado → no se puede escribir, el índice lo muestra, persiste al recargar; desbloquear es explícito`, async () => {
    await setText(ch1, UNO);
    await setText(ch2, DOS);
    const s = await open(device);
    try {
      assert.equal(await s.lock.getAttribute("aria-pressed"), "false");
      const sizeBefore = await s.editor.evaluate((el) => getComputedStyle(el).fontSize);
      await s.press(s.lock);
      await s.page.locator(".topbar .lock-toggle.on").waitFor();
      assert.match(await s.lock.innerText(), /🔒\s*Revisado/);
      assert.equal(await s.editor.evaluate((el) => el.readOnly), true);
      assert.equal(await s.editor.evaluate((el) => getComputedStyle(el).fontSize), sizeBefore, "the editor keeps its size");
      if (device.mobile) assert.equal(await s.page.evaluate(() => window.visualViewport?.scale ?? 1), 1, "no zoom");
      assert.equal((await chapter(ch1)).locked, true, "saved in the database");

      // Typing does nothing (and says why); the server still has the same text.
      await s.editor.focus();
      await s.page.keyboard.type("XYZ");
      await s.page.keyboard.press("Backspace");
      assert.equal(await s.editor.inputValue(), UNO);
      await s.page.locator(".editor-notice", { hasText: "revisado y bloqueado" }).waitFor();
      // Format buttons are off.
      assert.equal(await s.page.getByRole("button", { name: "Cursiva" }).isDisabled(), true);
      // Selecting still works (for the Consejero and the Asistente's selection).
      await s.editor.evaluate((el) => {
        el.focus();
        el.setSelectionRange(0, 7);
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      });
      assert.equal(await s.editor.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), "Primer ");

      // The index: a lock next to the title, and no Renombrar / Eliminar for it.
      if (!(await s.nav.isVisible())) await s.press(s.page.locator(".topbar .chapter-title"));
      const row = s.nav.locator("li").first();
      await row.locator(".chapter-lock").waitFor();
      assert.equal(await row.getByRole("button", { name: "Renombrar" }).count(), 0);
      assert.equal(await row.getByRole("button", { name: "Eliminar" }).count(), 0);
      assert.equal(await s.nav.locator("li").nth(1).locator(".chapter-lock").count(), 0, "the other chapter is not locked");
      await s.ctx.close();

      // Another session (another device): still locked.
      const t = await open(device);
      await t.page.locator(".topbar .lock-toggle.on").waitFor();
      assert.equal(await t.editor.evaluate((el) => el.readOnly), true);
      // Unlocking asks first; cancelling keeps it locked.
      t.page.once("dialog", (d) => d.dismiss());
      await t.press(t.lock);
      await wait(300);
      assert.equal((await chapter(ch1)).locked, true);
      t.page.once("dialog", (d) => {
        assert.match(d.message(), /Desbloquear «Capítulo 1»/);
        d.accept();
      });
      await t.press(t.lock);
      await t.page.locator(".topbar .lock-toggle:not(.on)").waitFor();
      assert.equal(await t.editor.evaluate((el) => el.readOnly), false);
      assert.equal((await chapter(ch1)).locked, false);
      await t.editor.evaluate((el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)));
      await t.page.keyboard.type(" Más.");
      for (let i = 0; i < 50 && !(await chapter(ch1)).content.endsWith(" Más."); i++) await wait(100);
      assert.ok((await chapter(ch1)).content.endsWith(" Más."), "editable and saved again");
      await t.ctx.close();
    } finally {
      await s.ctx.close().catch(() => {});
    }
  });

  test(`${device.name}: una propuesta del capítulo 1 vista en el capítulo 2 no se inserta; «Volver» la lleva a su capítulo`, async () => {
    await setText(ch1, UNO);
    await setText(ch2, DOS);
    const s = await open(device);
    try {
      await s.generate();
      await s.goTo(2);
      await s.openPanel();
      const guard = s.panel.locator(".target-guard");
      await guard.waitFor();
      assert.match(await guard.innerText(), /Esta propuesta fue preparada para «Capítulo 1», pero ahora estás en «Capítulo 2»/);
      assert.equal(await s.panel.getByRole("button", { name: "Insertar al final" }).isDisabled(), true);
      // «Otra versión» from here would mix chapter 1's request with chapter 2's text: refused too.
      await s.press(s.panel.getByRole("button", { name: "Otra versión" }));
      await s.panel.getByText(/Vuelve a ese capítulo para pedir otra versión/).waitFor();
      assert.equal((await chapter(ch2)).content, DOS);
      assert.equal((await chapter(ch1)).content, UNO);
    } finally {
      await s.ctx.close();
    }
  });

  test(`${device.name}: en su capítulo, la misma propuesta se inserta allí y sólo allí`, async () => {
    await setText(ch1, UNO);
    await setText(ch2, DOS);
    const s = await open(device);
    try {
      await s.generate();
      await s.goTo(2);
      await s.openPanel();
      await s.press(s.panel.getByRole("button", { name: "Volver a «Capítulo 1»" }));
      await s.page.locator(".topbar .chapter-title", { hasText: "Capítulo 1" }).waitFor();
      await s.openPanel();
      assert.equal(await s.panel.locator(".target-guard").count(), 0);
      await s.press(s.panel.getByRole("button", { name: "Insertar al final" }));
      for (let i = 0; i < 60 && !(await chapter(ch1)).content.includes(SCENE_START); i++) await wait(100);
      assert.ok((await chapter(ch1)).content.startsWith(UNO) && (await chapter(ch1)).content.includes(SCENE_START));
      assert.equal((await chapter(ch2)).content, DOS, "chapter 2 untouched");
    } finally {
      await s.ctx.close();
    }
  });
}

test("carrera: cambiar de capítulo mientras se guarda la copia previa → la inserción se detiene, ningún capítulo cambia", async () => {
  await setText(ch1, UNO);
  await setText(ch2, DOS);
  const s = await open(DEVICES[0]);
  try {
    await s.generate();
    // The copy kept before applying takes a while (slow network): the author switches meanwhile.
    let release;
    const held = new Promise((r) => (release = r));
    await s.page.route("**/api/chapters/*/versions", async (route) => {
      await held;
      await route.continue();
    });
    await s.panel.getByRole("button", { name: "Insertar al final" }).click();
    await s.goTo(2);
    release();
    await s.openPanel();
    await s.panel.getByText(/La inserción se ha detenido para evitar modificar el capítulo equivocado/).waitFor();
    await wait(1500); // any autosave would have happened
    assert.equal((await chapter(ch2)).content, DOS, "never in the wrong chapter");
    assert.equal((await chapter(ch1)).content, UNO, "nor in the original, since it was stopped");
    assert.equal(await s.editor.inputValue(), DOS);
  } finally {
    await s.ctx.close();
  }
});

test("propuesta preparada antes de bloquear: no se aplica; con una pestaña desactualizada, el servidor la rechaza", async () => {
  await setText(ch1, UNO);
  await setText(ch2, DOS);
  const s = await open(DEVICES[0]);
  try {
    await s.generate();
    // Locked here: the panel says so and waits.
    await s.lock.click();
    await s.page.locator(".topbar .lock-toggle.on").waitFor();
    await s.panel.locator(".target-guard[data-reason='locked']").waitFor();
    assert.equal(await s.panel.getByRole("button", { name: "Insertar al final" }).isDisabled(), true);
    s.page.once("dialog", (d) => d.accept());
    await s.lock.click();
    await s.page.locator(".topbar .lock-toggle:not(.on)").waitFor();

    // Locked on another device: this tab doesn't know. Insertar → the server refuses the copy (423).
    await call(`/api/chapters/${ch1}`, "PATCH", { locked: true });
    await s.panel.getByRole("button", { name: "Insertar al final" }).click();
    await s.panel.getByText(/bloqueado/).first().waitFor();
    await s.page.locator(".topbar .lock-toggle.on").waitFor(); // this tab now shows it locked
    await wait(1500);
    assert.equal((await chapter(ch1)).content, UNO);
    assert.equal(await s.editor.inputValue(), UNO, "nothing inserted on screen either");
  } finally {
    await s.ctx.close();
    await call(`/api/chapters/${ch1}`, "PATCH", { locked: false });
  }
});

test("pestaña desactualizada: lo escrito en un capítulo que otro dispositivo bloqueó no se guarda, se avisa y se conserva en pantalla", async () => {
  await setText(ch1, UNO);
  const s = await open(DEVICES[0]);
  try {
    await call(`/api/chapters/${ch1}`, "PATCH", { locked: true });
    await s.editor.evaluate((el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)));
    await s.page.keyboard.type(" Escrito tarde.");
    await s.page.locator(".save.locked").waitFor();
    assert.equal((await chapter(ch1)).content, UNO, "the server kept the locked text");
    assert.ok((await s.editor.inputValue()).endsWith(" Escrito tarde."), "the author's text is still on screen");
    await s.page.locator(".topbar .lock-toggle.on").waitFor();
    // Unlocking (explicitly) saves what was refused.
    s.page.once("dialog", (d) => d.accept());
    await s.lock.click();
    for (let i = 0; i < 60 && !(await chapter(ch1)).content.endsWith(" Escrito tarde."); i++) await wait(100);
    assert.ok((await chapter(ch1)).content.endsWith(" Escrito tarde."));
  } finally {
    await s.ctx.close();
  }
});

for (const device of DEVICES) {
  test(`${device.name} · editor visual: bloqueado no es editable, se puede seleccionar y no cambia de tamaño`, async () => {
    await setText(ch1, UNO);
    const s = await open(device, { visual: true });
    try {
      const size = await s.editor.evaluate((el) => getComputedStyle(el).fontSize);
      await s.press(s.lock);
      await s.page.locator(".topbar .lock-toggle.on").waitFor();
      assert.equal(await s.editor.getAttribute("contenteditable"), "false");
      assert.equal(await s.editor.evaluate((el) => getComputedStyle(el).fontSize), size);
      if (device.mobile) assert.equal(await s.page.evaluate(() => window.visualViewport?.scale ?? 1), 1, "no zoom");
      await s.editor.click();
      await s.page.keyboard.type("XYZ");
      await s.page.keyboard.press("Enter");
      await wait(500);
      assert.equal((await s.editor.innerText()).includes("XYZ"), false);
      // A selection reaches the Asistente / Consejero as usual.
      await s.editor.evaluate((el) => {
        const p = el.querySelector("p");
        const r = document.createRange();
        r.selectNodeContents(p);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      });
      await s.openPanel();
      await s.press(s.panel.getByRole("button", { name: "Editar selección" }));
      await s.panel.getByText("Primer capítulo.").first().waitFor();
      assert.equal((await chapter(ch1)).content, UNO);
      // Unlocked, it is editable again.
      s.page.once("dialog", (d) => d.accept());
      await s.press(s.lock);
      await s.page.locator(".topbar .lock-toggle:not(.on)").waitFor();
      assert.equal(await s.editor.getAttribute("contenteditable"), "true");
    } finally {
      await s.ctx.close();
    }
  });
}
