// Procesador's icon (docs/icono.md): a «P» whose stem ends in a fountain-pen nib, cream on
// oxblood. One drawing, every size the browsers and phones ask for:
//
//   src/app/icon.svg          tab favicon (Chrome, Firefox, Edge); simplifies itself when
//                             small: no breather hole below 40 px, no slit below 20 px
//   src/app/favicon.ico       16, 32 and 48 px, for Safari and anything that asks /favicon.ico
//   src/app/apple-icon.png    180 px, full bleed (iOS rounds the corners itself)
//   public/icons/icon-192.png, icon-512.png            shortcuts (manifest)
//   public/icons/icon-maskable-512.png                 Android, inside the 80 % safe zone
//
// Run with `npm run icons` after changing the drawing; the files are committed.
import fs from "node:fs";
import { chromium } from "playwright";

const OXBLOOD = "#6b2a2a";
const CREAM = "#f6efe3";

// On a 64 × 64 grid. The stem (18–29.5) narrows into the nib's point at the bottom.
const LETTER =
  "M18 7 H35.5 C46.5 7 52.5 13.8 52.5 23 C52.5 32.2 46.5 39 35.5 39 H29.5 V40 C31.5 44 31 50 24 58.5 L23.75 58.8 L23.5 58.5 C16.5 50 16 44 18 40 Z " +
  "M29.5 16.5 V29.5 H34.5 C39 29.5 41.5 27 41.5 23 C41.5 19 39 16.5 34.5 16.5 Z";
const glyph = (transform) =>
  `<g transform="${transform}">` +
  `<path fill="${CREAM}" fill-rule="evenodd" d="${LETTER}"/>` +
  `<path class="slit" d="M23.75 57 V47.5" stroke="${OXBLOOD}" stroke-width="2.2" stroke-linecap="round"/>` +
  `<circle class="hole" cx="23.75" cy="45.5" r="2.4" fill="${OXBLOOD}"/>` +
  `</g>`;
// Small sizes (below 40 px): no breather hole, and the slit runs up to where it was.
// At favicon size (16 px) the slit would be a third of a pixel: only the nib's outline stays.
const SMALL =
  `<style>@media (max-width: 40px) { .hole { display: none } .slit { d: path("M23.75 57 V44"); stroke-width: 2.4px } }` +
  `@media (max-width: 20px) { .slit { display: none } }</style>`;

const svg = ({ rounded = true, scale = 1, small = true } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  (small ? SMALL : "") +
  `<rect width="64" height="64"${rounded ? ' rx="14"' : ""} fill="${OXBLOOD}"/>` +
  // Optically centred (the bowl weighs more than the stem), then scaled about the centre.
  glyph(`translate(32 32) scale(${scale}) translate(-34.5 -32)`) +
  `</svg>\n`;

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(source, size) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.locator("img").evaluate((img) => img.decode());
  return page.locator("img").screenshot({ omitBackground: true });
}

/** An .ico holding PNG images (supported everywhere since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const write = (path, data) => {
  fs.mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });
  fs.writeFileSync(path, data);
  console.log(`${path} (${data.length} B)`);
};

write("src/app/icon.svg", svg());
const small = [];
for (const size of [16, 32, 48]) small.push({ size, data: await png(svg(), size) });
write("src/app/favicon.ico", ico(small));
write("src/app/apple-icon.png", await png(svg({ rounded: false, scale: 0.88 }), 180));
write("public/icons/icon-192.png", await png(svg(), 192));
write("public/icons/icon-512.png", await png(svg(), 512));
write("public/icons/icon-maskable-512.png", await png(svg({ rounded: false, scale: 0.7 }), 512));
await browser.close();
