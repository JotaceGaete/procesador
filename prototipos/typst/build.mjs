// Builds the test page into public/prototipo-typst (app.js + index.html). The WASM files are not
// committed: locally they are copied to vendor/ (ignored); deployed, the page loads them from jsDelivr.
import { build } from "esbuild";
import fs from "node:fs";
const OUT = new URL("../../public/prototipo-typst/", import.meta.url).pathname;
await build({
  entryPoints: [new URL("src/app.mjs", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  target: "es2020",
  minify: true,
  outfile: `${OUT}app.js`,
  loader: { ".typ": "text" },
  logLevel: "warning",
});
fs.copyFileSync(new URL("src/index.html", import.meta.url).pathname, `${OUT}index.html`);
if (process.argv.includes("--vendor")) {
  fs.mkdirSync(`${OUT}vendor`, { recursive: true });
  for (const f of ["typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm", "typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm"])
    fs.copyFileSync(new URL(`node_modules/@myriaddreamin/${f}`, import.meta.url).pathname, `${OUT}vendor/${f.split("/").pop()}`);
}
console.log("built", fs.statSync(`${OUT}app.js`).size, "bytes");
