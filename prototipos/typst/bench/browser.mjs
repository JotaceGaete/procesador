// Bench in Chromium (Playwright): the test page served with brotli like a CDN, for 50k/100k/200k
// words. Measures what the page measures, plus the real memory (RSS) of the page's processes.
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "/home/user/procesador/node_modules/playwright/index.mjs";

const DIR = new URL("../../../public/prototipo-typst/", import.meta.url).pathname;
const OUT = process.env.OUT ?? "/tmp/claude-0/-home-user-saas/7226b8d8-cc51-5672-bfec-8a6de4f3993e/scratchpad/bench";
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".otf": "font/otf", ".txt": "text/plain" };
const cache = new Map();
const server = http.createServer((req, res) => {
  const file = path.join(DIR, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  if (!file.startsWith(DIR) || !fs.existsSync(file)) return res.writeHead(404).end();
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  if (!cache.has(file)) cache.set(file, zlib.brotliCompressSync(fs.readFileSync(file), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }));
  res.writeHead(200, { "content-type": type, "content-encoding": "br", "cache-control": "no-store" }).end(cache.get(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL0 = `http://127.0.0.1:${server.address().port}/index.html`;

/** Resident memory (MB) of every Chromium process except the browser and GPU ones. */
function rss() {
  let kb = 0;
  for (const line of execSync("ps -eo rss,args").toString().split("\n")) {
    if (/chrom/i.test(line) && /--type=renderer/.test(line)) kb += Number(line.trim().split(/\s+/)[0]);
  }
  return Math.round(kb / 1024);
}

const browser = await chromium.launch();
const report = { runs: [] };
for (const [words, viewport] of [[50000, { width: 1440, height: 900 }], [100000, { width: 1440, height: 900 }], [200000, { width: 1440, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const before = rss();
  const t = Date.now();
  await page.goto(URL0);
  await page.evaluate((w) => window.__proto.run(w), words);
  const total = Date.now() - t;
  const peak = rss();
  const res = await page.evaluate(() => window.__proto.results);
  const run = res.runs.at(-1);
  // Navigation: render the next spreads (only the visible pages each time).
  const nav = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await page.evaluate(() => window.__proto.go(1));
    nav.push(Date.now() - t0);
  }
  await page.screenshot({ path: `${OUT}/spread-${words}.png` });
  const entry = { words, viewport, init: res.init, run, navigateMs: nav, rssMB: { before, after: peak }, totalMs: total };
  if (words === 200000) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.__proto.pdf())]);
    await dl.saveAs(`${OUT}/book-${words}.pdf`);
    entry.pdf = (await page.evaluate(() => window.__proto.results)).pdf;
    entry.pdfInfo = execSync(`pdfinfo ${OUT}/book-${words}.pdf | grep -E "Pages|Page size"`).toString().trim();
    entry.pdfFonts = execSync(`pdffonts ${OUT}/book-${words}.pdf | tail -n +3`).toString().trim();
  }
  console.log(JSON.stringify(entry));
  report.runs.push(entry);
  await ctx.close();
}
// By chapter, in the browser (50k).
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL0);
  await page.evaluate(() => window.__proto.byChapters(50000));
  report.byChapters = (await page.evaluate(() => window.__proto.results)).byChapters;
  console.log("byChapters", JSON.stringify(report.byChapters));
  await ctx.close();
}
// The by-chapter architecture, 50k / 100k / 200k, each in a fresh page (memory per size).
report.chapterBench = [];
for (const words of [50000, 100000, 200000]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL0);
  const before = rss();
  const r = await page.evaluate((w) => window.__proto.chapterBench(w), words);
  r.rssMB = { before, after: rss() };
  console.log("chapterBench", JSON.stringify(r));
  report.chapterBench.push(r);
  await ctx.close();
}
// A phone-sized single page view.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(URL0);
  await page.evaluate(() => window.__proto.run(50000));
  await page.screenshot({ path: `${OUT}/phone-50000.png` });
  report.phone = (await page.evaluate(() => window.__proto.results)).runs.at(-1);
  console.log("phone", JSON.stringify(report.phone));
  await ctx.close();
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
server.close();
