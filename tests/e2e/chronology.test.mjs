// Cronología (docs/cronologia-edades.md): el tiempo de cada capítulo, la edad calculada en
// cada uno, calendario real o relativo, advertencias que nunca bloquean, la edad en el
// contexto de la IA, y la interfaz en escritorio y teléfono.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BASE, PASSWORD, aiLog, clearAiLog, client, login, resetDb, textEditor } from "./helpers.mjs";

let call, browser, novel, ch, elena, pedro;

before(async () => {
  await resetDb();
  call = client(await login());
  novel = (await call("/api/novels", "POST", { title: "Tiempo" })).data.id;
  ch = [(await call(`/api/novels/${novel}`)).data.chapters[0].id];
  for (let i = 2; i <= 6; i++) ch.push((await call(`/api/novels/${novel}/chapters`, "POST", { title: `Parte ${i}` })).data.id);
  for (let i = 1; i <= 6; i++)
    await call(`/api/chapters/${ch[i - 1]}`, "PATCH", { content: i === 2 ? "Elena y Pedro en el puerto." : `Elena en el capítulo ${i}.`, revision: 0 });
  elena = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Elena", age: "21 años" })).data.id;
  pedro = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: "Pedro" })).data.id;
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
after(async () => browser?.close());

const view = async () => (await call(`/api/novels/${novel}/chronology`)).data;
const ageRow = (v, id) => v.characters.find((c) => c.id === id).ages;
const setTime = (i, body) => call(`/api/chapters/${ch[i - 1]}/time`, "PUT", body);

test("API: 21 en el capítulo 1 (1972), capítulo 6 en 1977 → 26; los capítulos sin fecha heredan, marcados", async () => {
  assert.equal((await call(`/api/memory/characters/${elena}`, "PATCH", { age_anchor: { kind: "age_at", age: 21, at: { chapter_id: ch[0] } } })).status, 200);
  assert.equal((await setTime(1, { when: { date: { year: 1972 } } })).status, 204);
  assert.equal((await setTime(6, { when: { date: { year: 1977 } } })).status, 204);
  const v = await view();
  assert.deepEqual(ageRow(v, elena), ["21 años", "21 años", "21 años", "21 años", "21 años", "26 años"]);
  assert.deepEqual(v.chapters.map((c) => [c.time, c.estimated]), [
    ["1972", false],
    ["1972", true],
    ["1972", true],
    ["1972", true],
    ["1972", true],
    ["1977", false],
  ]);
  // The free note is untouched.
  assert.equal((await call(`/api/novels/${novel}`)).data.memory.characters.find((c) => c.id === elena).age, "21 años");
});

test("API: calendario relativo y «cinco años después»: el mismo resultado sin fechas reales", async () => {
  assert.equal((await call(`/api/novels/${novel}/chronology`, "PATCH", { calendar: "relative" })).status, 204);
  await setTime(1, { when: { date: { year: 0 } } });
  await setTime(6, { when: { after: { years: 5 } }, label: "cinco años después" });
  const v = await view();
  assert.equal(v.calendar, "relative");
  assert.deepEqual([v.chapters[0].time, v.chapters[5].time], ["Año 0", "Año 5"]);
  assert.equal(ageRow(v, elena)[5], "26 años");
  assert.equal(v.chapters[5].mark.label, "cinco años después");
});

test("API: lo inválido se rechaza con un mensaje claro; un capítulo de otra novela, también", async () => {
  const bad = async (body) => (await call(`/api/memory/characters/${elena}`, "PATCH", body)).data.error;
  assert.match(await bad({ age_anchor: { kind: "birth", date: { year: 1971, month: 2, day: 29 } } }), /Día inválido/);
  assert.match(await bad({ age_anchor: { kind: "age_at", age: -1, at: { chapter_id: ch[0] } } }), /Edad inválida/);
  const other = (await call("/api/novels", "POST", { title: "Otra" })).data.id;
  const otherCh = (await call(`/api/novels/${other}`)).data.chapters[0].id;
  assert.match(await bad({ age_anchor: { kind: "age_at", age: 3, at: { chapter_id: otherCh } } }), /no es de esta novela/);
  assert.equal((await setTime(2, { when: { after: {} } })).status, 400);
  assert.equal((await call(`/api/novels/${novel}/chronology`, "PATCH", { calendar: "lunar" })).status, 400);
  await call(`/api/novels/${other}`, "DELETE");
});

test("API: advertencias que no bloquean, se descartan y vuelven si cambian los datos", async () => {
  await call(`/api/novels/${novel}/chronology`, "PATCH", { calendar: "real" });
  await setTime(1, { when: { date: { year: 1972 } } });
  await setTime(6, { when: { date: { year: 1977 } } });
  await call(`/api/memory/characters/${pedro}`, "PATCH", { age_anchor: { kind: "birth", date: { year: 1990 } } });
  let v = await view();
  const w = v.warnings.find((x) => x.key === `unborn:${pedro}`);
  assert.equal(w.level, "error");
  assert.match(w.message, /Pedro aparece en «Capítulo 2: Parte 2», antes de nacer/);
  // Nothing is blocked: the chapter still saves.
  const live = (await call(`/api/chapters/${ch[1]}`)).data;
  assert.equal((await call(`/api/chapters/${ch[1]}`, "PATCH", { content: `${live.content} Más.`, revision: live.revision })).status, 200);
  // "Es intencionado": dismissed while its data is the same.
  await call(`/api/novels/${novel}/chronology`, "PATCH", { dismiss: { key: w.key, fingerprint: w.fingerprint } });
  v = await view();
  assert.ok(v.warnings.find((x) => x.key === w.key).dismissed);
  await call(`/api/memory/characters/${pedro}`, "PATCH", { age_anchor: { kind: "birth", date: { year: 1991 } } });
  v = await view();
  assert.ok(!v.warnings.find((x) => x.key === w.key).dismissed, "the data changed: it comes back");
});

test("API: la IA recibe la edad de este punto y el tiempo del capítulo; Consistencia, las advertencias", async () => {
  await clearAiLog();
  const content = "Elena mira el mar.";
  await call("/api/assist", "POST", {
    novelId: novel,
    chapterId: ch[5],
    content,
    mode: "scene",
    argument: "Elena vuelve.",
    cursor: content.length,
    provider: "anthropic",
  });
  const system = (await aiLog())[0].body.system.map((b) => b.text).join("\n");
  assert.match(system, /## Tiempo del relato\nEn este punto: 1977\./);
  assert.match(system, /### Elena\nEdad en este punto de la historia: 26 años \(21 en el capítulo 1\)/);
  assert.doesNotMatch(system, /Edad: 21 años/);
  const dry = (
    await call("/api/assist", "POST", { novelId: novel, chapterId: ch[5], content, mode: "scene", argument: "Elena vuelve.", cursor: content.length, dryRun: true })
  ).data;
  assert.ok(dry.sections.some((s) => s.id === "time" && s.label === "Tiempo del relato: 1977"));
  assert.match(dry.sections.find((s) => s.id === "characters").items[0].detail, /^Edad en este punto: 26 años/);

  await clearAiLog();
  const text = "Elena y Pedro en el puerto. Más.";
  await call("/api/assist", "POST", {
    novelId: novel,
    chapterId: ch[1],
    content: text,
    mode: "edit",
    action: "consistencia",
    selectionStart: 0,
    selectionEnd: text.length,
    provider: "anthropic",
  });
  const prompt = (await aiLog())[0].body.messages[0].content;
  assert.match(prompt, /<cronologia>\n- Pedro aparece en «Capítulo 2: Parte 2», antes de nacer\./);
});

test("API: duplicar la novela conserva la cronología", async () => {
  const copy = (await call(`/api/novels/${novel}/duplicate`, "POST", { title: "Tiempo (copia)" })).data.id;
  const v = (await call(`/api/novels/${copy}/chronology`)).data;
  const e = v.characters.find((c) => c.name === "Elena");
  assert.equal(e.ages[5], "26 años");
  assert.equal(v.chapters[5].time, "1977");
  await call(`/api/novels/${copy}`, "DELETE");
});

// ---------------------------------------------------------------- interface

const DEVICES = [
  { name: "escritorio", context: { viewport: { width: 1280, height: 900 } }, mobile: false },
  {
    name: "teléfono",
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    mobile: true,
  },
];

for (const device of DEVICES) {
  test(`${device.name}: definir la edad en la ficha, fechar capítulos en la Cronología y ver la edad cambiar`, async () => {
    // A fresh character and chapters without times.
    for (const id of ch) await call(`/api/chapters/${id}/time`, "DELETE");
    const marta = (await call(`/api/novels/${novel}/memory/characters`, "POST", { name: `Marta ${device.name}` })).data.id;
    const ctx = await browser.newContext(device.context);
    await textEditor(ctx);
    await ctx.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
    await ctx.addInitScript(([n, c]) => localStorage.setItem(`chapter:${n}`, c), [novel, ch[1]]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => assert.fail(`page error: ${e.message}`));
    await page.goto(`${BASE}/novela/${novel}`);
    await page.locator("textarea.editor").waitFor();
    const press = (loc) => (device.mobile ? loc.tap() : loc.click());

    // The file: 30 years old in chapter 1.
    await press(page.getByRole("button", { name: "Memoria" }));
    await press(page.getByRole("dialog").getByText(`Marta ${device.name}`));
    const form = page.getByRole("dialog");
    await form.getByLabel("Qué se sabe de su edad").selectOption("age_chapter");
    await form.getByLabel("Años que tenía").fill("30");
    await form.getByLabel("Capítulo", { exact: true }).selectOption({ index: 0 });
    await press(form.getByRole("button", { name: "Guardar" }));
    await form.getByText(`Marta ${device.name}`).first().waitFor();
    // The name shows at once; the save may still be on its way.
    const anchor = async () => (await call(`/api/novels/${novel}`)).data.memory.characters.find((c) => c.id === marta).age_anchor;
    for (let i = 0; i < 50 && !(await anchor()); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await anchor(), {
      kind: "age_at",
      age: 30,
      at: { chapter_id: ch[0] },
    });
    await page.keyboard.press("Escape");

    // The Cronología: chapter 1 in 1980, chapter 2 «3 años después».
    if (!(await page.locator("nav.chapters").isVisible())) await press(page.locator(".topbar .chapter-title"));
    await press(page.getByRole("button", { name: /^Cronología/ }));
    const chrono = page.getByRole("dialog", { name: "Cronología" });
    await press(chrono.getByRole("button", { name: /Tiempo de Capítulo 1:/ }));
    await chrono.getByLabel("Año", { exact: true }).fill("1980");
    await press(chrono.getByRole("button", { name: "Guardar" }));
    await press(chrono.getByRole("button", { name: /Tiempo de Capítulo 2: Parte 2:/ }));
    await chrono.getByLabel("Tiempo del capítulo").selectOption("after");
    await chrono.getByLabel("años", { exact: true }).fill("3");
    await press(chrono.getByRole("button", { name: "Guardar" }));
    await chrono.getByText(/3 años después · 1983/).waitFor();
    const col = await chrono.locator("thead th").allInnerTexts();
    const idx = col.indexOf(`Marta ${device.name}`);
    assert.ok(idx > 1);
    const row = (i) => chrono.locator("tbody tr").nth(i).locator("th, td").nth(idx);
    assert.equal(await row(0).innerText(), "30 años");
    assert.equal(await row(1).innerText(), "33 años");
    assert.equal(await row(2).innerText(), "33 años", "chapter 3 inherits");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll");

    // A warning never blocks, and can be dismissed.
    const warnings = chrono.getByRole("region", { name: "Advertencias de tiempo" });
    const before = await warnings.locator("li.warning:not(.muted)").count();
    if (before) {
      await press(warnings.getByRole("button", { name: "Es intencionado" }).first());
      await page.waitForFunction((n) => document.querySelectorAll(".chrono-warnings li.warning:not(.muted)").length === n - 1, before);
    }
    await page.keyboard.press("Escape");

    // The file shows the age in the open chapter (chapter 2: 33).
    await press(page.getByRole("button", { name: "Memoria" }));
    await press(page.getByRole("dialog").getByText(`Marta ${device.name}`));
    await page.getByRole("dialog").getByText("En este capítulo: 33 años").waitFor();
    await ctx.close();
  });
}
