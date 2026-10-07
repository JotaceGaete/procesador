// Step-by-step check of the test page in Chromium, with a small novel and the page's log.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "/home/user/procesador/node_modules/playwright/index.mjs";

const DIR = new URL("../../../public/prototipo-typst/", import.meta.url).pathname;
const server = http.createServer((req, res) => {
  const file = path.join(DIR, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const type = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" }[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => console.log("console:", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
const words = Number(process.argv[2] ?? 5000);
const r = await Promise.race([
  page.evaluate((w) => window.__proto.run(w).then(() => window.__proto.results), words),
  new Promise((res) => setTimeout(() => res("TIMEOUT"), 90000)),
]);
console.log(JSON.stringify(r).slice(0, 1500));
console.log(await page.locator("#log").innerText());
await browser.close();
server.close();
