/**
 * EPUB 3, reflowable (docs/exportacion.md): one XHTML file per chapter, a table of contents,
 * front matter, the images with their alternative text, caption and credit, and an optional
 * cover. Pure: the caller gives the image files already as PNG or JPEG (EPUB core media).
 */
import type { ZipEntry } from "../zip";
import type { Span } from "../manuscript";
import { defaultCopyright, type BookBlock, type BookModel } from "./model";
import type { PreparedImage } from "./docx";

const enc = new TextEncoder();
const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const inline = (spans: Span[]) =>
  spans.map((s) => (s.italic ? `<em>${lines(s.text)}</em>` : lines(s.text))).join("");
const lines = (t: string) => t.split("\n").map(x).join("<br/>");
const paras = (t: string, cls: string) =>
  t
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => `<p class="${cls}">${lines(p.trim())}</p>`)
    .join("\n");

const CSS = `body { margin: 0 5%; font-family: serif; line-height: 1.5; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
p.first, h1 + p, h2 + p { text-indent: 0; }
.chapter-number { text-align: center; text-transform: uppercase; letter-spacing: 0.1em; margin: 3em 0 0.5em; font-size: 0.9em; text-indent: 0; }
h1 { text-align: center; font-weight: normal; font-size: 1.5em; margin: 0 0 2em; }
.scene-break { text-align: center; text-indent: 0; margin: 1.2em 0; }
figure { margin: 1.5em auto; text-align: center; page-break-inside: avoid; }
figure.page { page-break-before: always; page-break-after: always; }
figure.align-left { margin-left: 0; }
figure.align-right { margin-right: 0; }
figure img { max-width: 100%; height: auto; }
figcaption { font-size: 0.9em; font-style: italic; text-indent: 0; text-align: center; margin-top: 0.4em; }
figcaption .credit { display: block; font-style: normal; font-size: 0.85em; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { margin-bottom: 0.3em; }
.title-page p { text-indent: 0; text-align: center; }
.subtitle { font-style: italic; }
.author { margin-top: 2em; }
.copyright p, .dedication p, .epigraph p { text-indent: 0; text-align: left; }
.copyright { margin-top: 50%; font-size: 0.85em; }
.dedication { margin-top: 30%; text-align: right; font-style: italic; }
.dedication p { text-align: right; }
.epigraph { margin: 30% 10% 0; font-style: italic; }
.epigraph .source { text-align: right; font-style: normal; margin-top: 0.5em; }
.cover { text-align: center; margin: 0; }
.cover img { max-width: 100%; max-height: 100%; }
`;

export function epub(model: BookModel, images: Map<string, PreparedImage>, now = new Date()): ZipEntry[] {
  const meta = model.meta;
  const lang = meta.language;
  const page = (title: string, body: string, type = "") =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${x(lang)}" lang="${x(lang)}">\n<head><meta charset="utf-8"/><title>${x(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body${type ? ` epub:type="${type}"` : ""}>\n${body}\n</body>\n</html>\n`;

  const files: ZipEntry[] = [];
  const manifest: string[] = [];
  const spine: string[] = [];
  const add = (id: string, href: string, type: string, content: string | Uint8Array, opts: { spine?: boolean; props?: string } = {}) => {
    files.push({ name: `OEBPS/${href}`, data: typeof content === "string" ? enc.encode(content) : content });
    manifest.push(`<item id="${id}" href="${href}" media-type="${type}"${opts.props ? ` properties="${opts.props}"` : ""}/>`);
    if (opts.spine) spine.push(`<itemref idref="${id}"/>`);
  };

  // Images, each once.
  const href = new Map<string, string>();
  let n = 0;
  for (const f of model.files) {
    const img = images.get(f.id);
    if (!img) continue;
    const name = `images/image${++n}.${img.ext === "png" ? "png" : "jpg"}`;
    href.set(f.id, name);
    add(`img${n}`, name, img.ext === "png" ? "image/png" : "image/jpeg", img.bytes, model.cover?.id === f.id ? { props: "cover-image" } : {});
  }
  add("css", "style.css", "text/css", CSS);

  const coverHref = model.cover ? href.get(model.cover.id) : undefined;
  if (coverHref)
    add("cover", "cover.xhtml", "application/xhtml+xml", page(model.title, `<section class="cover" epub:type="cover"><img src="${coverHref}" alt="${x(`Portada de ${model.title}`)}"/></section>`), { spine: true });
  add(
    "title",
    "title.xhtml",
    "application/xhtml+xml",
    page(
      model.title,
      `<section class="title-page" epub:type="titlepage"><h1>${x(model.title)}</h1>${meta.subtitle ? `<p class="subtitle">${x(meta.subtitle)}</p>` : ""}${meta.author ? `<p class="author">${x(meta.author)}</p>` : ""}${meta.publisher ? `<p class="publisher">${x(meta.publisher)}</p>` : ""}</section>`,
      "frontmatter",
    ),
    { spine: true },
  );
  add(
    "copyright",
    "copyright.xhtml",
    "application/xhtml+xml",
    page("Créditos", `<section class="copyright" epub:type="copyright-page">${paras(meta.copyright.trim() || defaultCopyright(model.title, meta), "")}</section>`, "frontmatter"),
    { spine: true },
  );
  if (meta.dedication.trim())
    add("dedication", "dedication.xhtml", "application/xhtml+xml", page("Dedicatoria", `<section class="dedication" epub:type="dedication">${paras(meta.dedication.trim(), "")}</section>`, "frontmatter"), { spine: true });
  if (meta.epigraph.trim())
    add(
      "epigraph",
      "epigraph.xhtml",
      "application/xhtml+xml",
      page(
        "Epígrafe",
        `<section class="epigraph" epub:type="epigraph">${paras(meta.epigraph.trim(), "")}${meta.epigraphSource.trim() ? `<p class="source">— ${x(meta.epigraphSource.trim())}</p>` : ""}</section>`,
        "frontmatter",
      ),
      { spine: true },
    );

  const block = (b: BookBlock) => {
    if (b.kind === "para") return `<p${b.first ? ' class="first"' : ""}>${inline(b.spans)}</p>`;
    if (b.kind === "break") return `<p class="scene-break" role="separator" aria-label="Cambio de escena">* * *</p>`;
    const src = href.get(b.file.id);
    if (!src) return "";
    const { image } = b;
    const width = image.layout === "page" ? 100 : image.width_pct;
    const alt = image.decorative ? "" : image.alt.trim() || image.caption.trim();
    const caption =
      image.caption.trim() || image.credit.trim()
        ? `<figcaption>${x(image.caption.trim())}${image.credit.trim() ? `<span class="credit">${x(image.credit.trim())}</span>` : ""}</figcaption>`
        : "";
    return `<figure class="${image.layout === "page" ? "page " : ""}align-${image.align}" style="width: ${width}%"><img src="${src}" alt="${x(alt)}"${image.decorative ? ' role="presentation"' : ""}/>${caption}</figure>`;
  };

  const toc: string[] = [];
  model.chapters.forEach((c, i) => {
    const file = `chapter-${String(i + 1).padStart(3, "0")}.xhtml`;
    const heading = c.title ? `<p class="chapter-number">${x(c.number)}</p><h1>${x(c.title)}</h1>` : `<h1>${x(c.number)}</h1>`;
    add(`ch${i + 1}`, file, "application/xhtml+xml", page(c.heading, `<section epub:type="chapter" role="doc-chapter">${heading}\n${c.blocks.map(block).join("\n")}</section>`, "bodymatter"), { spine: true });
    toc.push(`<li><a href="${file}">${x(c.heading)}</a></li>`);
  });
  add(
    "nav",
    "nav.xhtml",
    "application/xhtml+xml",
    page("Índice", `<nav epub:type="toc" id="toc" role="doc-toc"><h1>Índice</h1><ol>${toc.join("")}</ol></nav>`),
    { props: "nav" },
  );

  const identifier = meta.isbn ? `urn:isbn:${meta.isbn.replace(/-/g, "")}` : `urn:uuid:${model.id}`;
  const modified = now.toISOString().replace(/\.\d+Z$/, "Z");
  const opf =
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${x(lang)}">\n` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<dc:identifier id="bookid">${x(identifier)}</dc:identifier>\n<dc:title>${x(model.title)}</dc:title>\n<dc:language>${x(lang)}</dc:language>\n` +
    (meta.author ? `<dc:creator>${x(meta.author)}</dc:creator>\n` : "") +
    (meta.publisher ? `<dc:publisher>${x(meta.publisher)}</dc:publisher>\n` : "") +
    (meta.year ? `<dc:date>${x(meta.year)}</dc:date>\n` : "") +
    `<meta property="dcterms:modified">${modified}</meta>\n` +
    (coverHref ? `<meta name="cover" content="img${[...href.keys()].indexOf(model.cover!.id) + 1}"/>\n` : "") +
    `</metadata>\n<manifest>\n${manifest.join("\n")}\n</manifest>\n<spine>\n${spine.join("\n")}\n</spine>\n</package>\n`;

  return [
    // The mimetype goes first and uncompressed (the ZIP writer never compresses).
    { name: "mimetype", data: enc.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`,
      ),
    },
    { name: "OEBPS/content.opf", data: enc.encode(opf) },
    ...files,
  ];
}
