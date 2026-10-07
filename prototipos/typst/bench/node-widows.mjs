import fs from "node:fs";
import { nativeCompiler } from "./node-lib.mjs";
import { novel } from "../src/novel.mjs";
const P = process.argv[2];
const { c, compile } = nativeCompiler();
for (const widows of [true, false]) {
  const doc = compile(novel(50000, { layout: { widows } }));
  fs.writeFileSync(`${P}/widows-${widows}.pdf`, c.pdf(doc));
}
