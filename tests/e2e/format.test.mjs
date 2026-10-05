// Formato del texto (docs/formato-texto.md): cursivas *así* y separadores de escena.
// Ctrl/⌘+I and the bar's buttons in the editor, the reading view, what the models receive
// (`* * *`, never the marker) and what comes back from them (separators, no bold).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, events, login, resetDb } from "./helpers.mjs";

const SEP = "[[separador]]";
let call, browser, novel, chapterId;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Formato" })).data.id;
  chapterId = (await call(`/api/novels/${novel}`)).data.chapters[0].id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

async function setText(content) {
  const { revision } = (await call(`/api/chapters/${chapterId}`)).data;
  assert.equal((await call(`/api/chapters/${chapterId}`, "PATCH", { content, revision })).status, 200);
}

async function open(context = { viewport: { width: 1280, height: 900 } }) {
  const ctx = await browser.newContext(context);
  await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
  await page.goto(`${BASE}/novela/${novel}`);
  const editor = page.locator("textarea.editor");
  await editor.waitFor();
  const select = (start, end = start) =>
    editor.evaluate(
      (el, [s, e]) => {
        el.focus();
        el.setSelectionRange(s, e);
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      },
      [start, end],
    );
  return { ctx, page, editor, select };
}

const saved = async (expected) => {
  for (let i = 0; i < 50; i++) {
    if ((await call(`/api/chapters/${chapterId}`)).data.content === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await call(`/api/chapters/${chapterId}`)).data.content, expected, "saved");
};

test("API: the models read separators as * * * and italics as they are, never the marker", async () => {
  const content = `*Uno*.\n\n${SEP}\n\nDos.`;
  await clearAiLog();
  const scene = await call("/api/assist", "POST", {
    novelId: novel,
    chapterId,
    content,
    mode: "scene",
    argument: "Sigue.",
    cursor: content.length,
    provider: "anthropic",
  });
  assert.ok(events(scene.data).some((e) => e.type === "text"));
  const edit = await call("/api/assist", "POST", {
    novelId: novel,
    chapterId,
    content,
    mode: "edit",
    action: "redaccion",
    selectionStart: 0,
    selectionEnd: content.length,
    provider: "anthropic",
  });
  assert.ok(events(edit.data).some((e) => e.type === "text"));
  const sent = await aiLog();
  assert.equal(sent.length, 2);
  for (const r of sent) {
    const all = JSON.stringify(r.body);
    assert.ok(!all.includes("[[separador"), "no marker reaches a model");
    assert.ok(r.body.messages[0].content.includes("*Uno*.\n\n* * *\n\nDos."), "italics kept, separator as * * *");
    assert.match(r.body.system.map((b) => b.text).join("\n"), /Formato del manuscrito/);
  }
});

test("editor: Ctrl/⌘+I toggles italics, the bar's buttons too; the separator is a block", async () => {
  await setText("Leyó Rayuela entera.\n\nOtra escena.");
  const { ctx, page, editor, select } = await open();

  await select(5, 12); // "Rayuela"
  await page.keyboard.press("ControlOrMeta+i");
  assert.equal(await editor.inputValue(), "Leyó *Rayuela* entera.\n\nOtra escena.");
  await page.keyboard.press("ControlOrMeta+i");
  assert.equal(await editor.inputValue(), "Leyó Rayuela entera.\n\nOtra escena.");
  // Undo is the editor's own.
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(await editor.inputValue(), "Leyó *Rayuela* entera.\n\nOtra escena.");

  // The bar's Cursiva keeps the selection of the text (the button doesn't take the focus).
  await select(0, 4);
  await page.getByRole("button", { name: "Cursiva" }).click();
  assert.equal(await editor.inputValue(), "*Leyó* *Rayuela* entera.\n\nOtra escena.");

  // Separador de escena, after the first paragraph: its own paragraph.
  await select("*Leyó* *Rayuela* entera.".length);
  await page.getByRole("button", { name: "Separador de escena" }).click();
  assert.equal(await editor.inputValue(), `*Leyó* *Rayuela* entera.\n\n${SEP}\n\nOtra escena.`);
  // Typing on its line starts a new paragraph below it: the marker never breaks.
  await page.keyboard.type("X");
  assert.equal(await editor.inputValue(), `*Leyó* *Rayuela* entera.\n\n${SEP}\n\nX\n\nOtra escena.`);
  await saved(`*Leyó* *Rayuela* entera.\n\n${SEP}\n\nX\n\nOtra escena.`);

  // Lectura: real italics and a scene break; no asterisks, no marker.
  await page.getByRole("button", { name: "Lectura", exact: true }).click();
  const reading = page.locator("article.reading");
  await reading.waitFor();
  assert.deepEqual(await reading.locator("em").allTextContents(), ["Leyó", "Rayuela"]);
  assert.equal(await reading.locator("hr.scene-break").count(), 1);
  const shown = await reading.innerText();
  assert.ok(!shown.includes("[[") && !shown.includes("*Rayuela*"), shown);
  assert.ok(await page.getByRole("button", { name: "Cursiva" }).isDisabled(), "no formatting while reading");
  await ctx.close();
});

test("assistant: a scene's * * * becomes a separator and its bold italics; a rewrite keeps both", async () => {
  await setText("Uno.");
  const { ctx, page, editor, select } = await open();
  const panel = page.locator("aside.panel");
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().click();

  await select(4);
  await panel.getByRole("button", { name: "Escribir escena" }).click();
  await page.getByPlaceholder(/Qué ocurre en la escena/).fill("ESCENA-FORMATO");
  await panel.getByRole("button", { name: "Desarrollar escena" }).click();
  await panel.getByRole("button", { name: "Insertar al final" }).click();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  assert.equal(await editor.inputValue(), `Uno.\n\nLeyó *Rayuela* de un tirón.\n\n${SEP}\n\nAl día siguiente dijo *nunca*.`);

  // A rewrite of text with italics and a separator: the model sees * * *, the manuscript gets the marker back.
  const text = `*Uno* MANTEN-FORMATO.\n\n${SEP}\n\nDos.`;
  await setText(text);
  await page.reload();
  await editor.waitFor();
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).first().click();
  await panel.getByRole("button", { name: "Editar selección" }).click();
  await select(0, text.length);
  await panel.getByRole("button", { name: "Proponer cambios" }).click();
  await panel.getByRole("button", { name: "Reemplazar selección" }).click();
  await page.locator("section.result").waitFor({ state: "detached" }); // Applying waits for the copy of the current text (docs/asistente-contexto.md §9).
  assert.equal(await editor.inputValue(), `*Uno* reescrito.\n\n${SEP}\n\nDos reescrito.`);
  await ctx.close();
});

test("teléfono: Cursiva and Separador are in the bar and work by touch", async () => {
  await setText("Hola mundo.");
  const { ctx, page, editor, select } = await open({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  await select(5, 10);
  await page.getByRole("button", { name: "Cursiva" }).tap();
  assert.equal(await editor.inputValue(), "Hola *mundo*.");
  await select("Hola *mundo*.".length);
  await page.getByRole("button", { name: "Separador de escena" }).tap();
  assert.equal(await editor.inputValue(), `Hola *mundo*.\n\n${SEP}`);
  await ctx.close();
});

// Lectura as a novel's page (src/lib/presentation.ts). The text is typed the ways a real chapter
// is: some paragraphs after one Enter, some after a blank line, Windows line endings, and lines
// that look blank but hold invisible characters left by pasting (zero-width space, BOM, soft
// hyphen). However it was typed, consecutive paragraphs follow the rhythm of the lines; only the
// scene break opens space.
const NARRATION_1 =
  "Llegamos al puerto cuando ya no quedaba nadie en el muelle, y el viento traía olor a sal, a gasoil y a redes mojadas que alguien había dejado secar sobre las piedras desde la mañana.";
const NARRATION_2 =
  "Lorena se quedó mirando el agua un largo rato, como si esperara que el barco volviera a aparecer detrás del espigón, aunque las dos sabíamos que no iba a volver esa noche ni la siguiente.";
const PARAS = [
  ["n", NARRATION_1],
  ["n", NARRATION_2],
  ["d", "—Siempre dices lo mismo —dije."],
  ["d", "—Porque siempre pasa lo mismo."],
  ["d", "—¿Y si esta vez no?"],
  ["d", "—Esta vez tampoco —contestó, sin mirarme."],
  ["n", "Lorena me miró de costado."],
];
const AFTER = "A la mañana siguiente el barco ya no estaba, y nadie en el pueblo supo decir a qué hora había salido.";
const CHAPTER =
  `${PARAS[0][1]}\n${PARAS[1][1]}\n\n${PARAS[2][1]}\r\n\r\n${PARAS[3][1]}\n​\n${PARAS[4][1]}\n${PARAS[5][1]}\n﻿­\n\n${PARAS[6][1]}` +
  `\n\n${SEP}\n\n${AFTER}`;

/** Each paragraph's line boxes (as the browser lays them out) and its computed box. */
const measure = (reading) =>
  reading.locator("p").evaluateAll((ps) =>
    ps.map((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const tops = [];
      for (const r of range.getClientRects()) if (r.height > 0 && !tops.some((t) => Math.abs(t - r.top) < 3)) tops.push(r.top);
      tops.sort((a, b) => a - b);
      const cs = getComputedStyle(p);
      return {
        text: p.textContent,
        lines: tops,
        lineHeight: parseFloat(cs.lineHeight),
        fontSize: parseFloat(cs.fontSize),
        indent: parseFloat(cs.textIndent),
        box: `${cs.marginTop} ${cs.marginBottom} ${cs.paddingTop} ${cs.paddingBottom} ${cs.whiteSpace}`,
        brs: p.querySelectorAll("br").length,
      };
    }),
  );

for (const device of [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } } },
  { name: "teléfono", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
]) {
  test(`Lectura (${device.name}): consecutive paragraphs keep the line rhythm, however they were typed; only the scene break opens space`, async () => {
    await call(`/api/chapters/${chapterId}`, "PATCH", { title: "El muelle" });
    await setText(CHAPTER);
    const { ctx, page } = await open(device.context);
    await page.getByRole("button", { name: "Lectura", exact: true }).click();
    const reading = page.locator("article.reading");
    await reading.waitFor();
    assert.equal(await reading.locator(".reading-number").innerText(), "CAPÍTULO 1");
    assert.equal(await reading.locator("h2").innerText(), "El muelle");

    const ps = await measure(reading);
    // Structure: one paragraph per visible line, nothing empty, no <br>, no extra nodes.
    assert.deepEqual(ps.map((p) => p.text), [...PARAS.map(([, t]) => t), AFTER], "blank and invisible lines make no paragraph");
    assert.deepEqual(await reading.evaluate((a) => [...a.children].map((e) => e.tagName)), ["HEADER", ...PARAS.map(() => "P"), "HR", "P"]);
    for (const p of ps) {
      assert.equal(p.box, "0px 0px 0px 0px normal", `no margin, padding or pre-wrap on «${p.text.slice(0, 30)}»`);
      assert.equal(p.brs, 0);
      assert.ok(p.lineHeight / p.fontSize >= 1.45 && p.lineHeight / p.fontSize <= 1.7, `comfortable leading ${p.lineHeight / p.fontSize}`);
    }
    assert.deepEqual(ps.map((p) => p.indent > 0), [false, true, true, true, true, true, true, false], "indent, but not after the heading or the break");

    const lh = ps[0].lineHeight;
    // The measurement itself: two lines inside one narrative paragraph are one line-height apart.
    assert.ok(ps[0].lines.length >= 2, "the narration wraps");
    assert.ok(Math.abs(ps[0].lines[1] - ps[0].lines[0] - lh) <= 1, `line step inside a paragraph: ${ps[0].lines[1] - ps[0].lines[0]} vs ${lh}`);

    // From the last line of a paragraph to the first of the next: the same step, no empty line.
    const step = (i) => ps[i + 1].lines[0] - ps[i].lines.at(-1);
    const kind = (i) => (i < PARAS.length ? PARAS[i][0] : "n");
    const seen = new Set();
    for (let i = 0; i < PARAS.length - 1; i++) {
      const pair = `${kind(i) === "n" ? "narración" : "diálogo"} → ${kind(i + 1) === "n" ? "narración" : "diálogo"}`;
      seen.add(pair);
      assert.ok(Math.abs(step(i) - lh) <= 1, `${pair} (${i}→${i + 1}): ${step(i).toFixed(1)}px, a line is ${lh}px`);
    }
    assert.deepEqual([...seen].sort(), ["diálogo → diálogo", "diálogo → narración", "narración → diálogo", "narración → narración"]);

    // Paragraph → [[separador]] → paragraph: deliberate space, with the ornament between.
    const across = step(PARAS.length - 1);
    assert.ok(across >= 2.5 * lh, `scene break: ${across.toFixed(1)}px, at least 2.5 lines (${(2.5 * lh).toFixed(1)}px)`);
    const hr = reading.locator("hr.scene-break");
    assert.match(await hr.evaluate((el) => getComputedStyle(el, "::after").content), /\* \* \*/);
    const hrBox = await hr.boundingBox();
    const lastBefore = ps[PARAS.length - 1].lines.at(-1);
    assert.ok(hrBox.y > lastBefore + lh * 0.9 && hrBox.y + hrBox.height < ps.at(-1).lines[0], "the ornament sits in the space");

    // A comfortable measure: about 65 characters, never wider than the screen.
    const width = await reading.locator("p").first().evaluate((p) => p.getBoundingClientRect().width / parseFloat(getComputedStyle(p).fontSize));
    assert.ok(width <= 35, `column of ${width.toFixed(1)}em`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    if (process.env.E2E_SHOTS) await reading.screenshot({ path: `${process.env.E2E_SHOTS}/lectura-${device.name}.png` });
    await ctx.close();
  });
}
