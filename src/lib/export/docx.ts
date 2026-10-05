/**
 * DOCX, editable in Word, LibreOffice or Google Docs (docs/exportacion.md). Two layouts:
 *
 *   - "manuscript": the standard submission format. A4 (or letter), 12 pt Times New Roman,
 *     double spacing, 2,5 cm margins, indented paragraphs, each chapter on a new page a third
 *     down, "#" for scene breaks, and "Author / TÍTULO / page" in the header.
 *   - "book": the book's page (trim size, mirrored margins, font size, indent from the
 *     book's layout), title page, copyright page, dedication and epigraph, each chapter on a
 *     new page, running heads (author / title) and page numbers.
 *
 * Images go at their size relative to the text block, with caption and credit. Pure: the
 * caller gives the image files already as PNG or JPEG.
 */
import type { ZipEntry } from "../zip";
import { defaultCopyright, type BookBlock, type BookModel, type ExportFile } from "./model";
import { trimOf } from "../book";
import type { Span } from "../manuscript";

export type DocxLayout = "manuscript" | "book";

export interface PreparedImage {
  bytes: Uint8Array;
  ext: "png" | "jpeg";
  /** As seen (orientation applied). */
  width: number;
  height: number;
}

const enc = new TextEncoder();
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const twips = (mm: number) => Math.round((mm / 25.4) * 1440);
const EMU_PER_MM = 36000;

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** Runs of text: italics, and line breaks inside a paragraph. */
function runs(spans: Span[], extra = ""): string {
  return spans
    .map((s) =>
      s.text
        .split("\n")
        .map((line, i) => `<w:r>${s.italic || extra ? `<w:rPr>${s.italic ? "<w:i/>" : ""}${extra}</w:rPr>` : ""}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`)
        .join(""),
    )
    .join("");
}
const plain = (text: string): Span[] => [{ text, italic: false }];
const para = (style: string, content: string, pPr = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pPr}</w:pPr>${content}</w:p>`;
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

export function docx(model: BookModel, layout: DocxLayout, images: Map<string, PreparedImage>): ZipEntry[] {
  const meta = model.meta;
  const manuscript = layout === "manuscript";
  const trim = manuscript ? (meta.layout.trim === "letter" ? { width: 215.9, height: 279.4 } : { width: 210, height: 297 }) : trimOf(meta);
  const m = manuscript ? { top: 25.4, bottom: 25.4, inside: 25.4, outside: 25.4 } : meta.layout.margins;
  const textWidthMm = trim.width - m.inside - m.outside;
  const textHeightMm = trim.height - m.top - m.bottom - 15;

  // ---- images: one relationship and one media file per file
  const rels: string[] = [];
  const media: ZipEntry[] = [];
  const relOf = new Map<string, string>();
  let n = 0;
  for (const f of model.files) {
    const img = images.get(f.id);
    if (!img) continue;
    n++;
    const rid = `rIdImg${n}`;
    relOf.set(f.id, rid);
    media.push({ name: `word/media/image${n}.${img.ext}`, data: img.bytes });
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${n}.${img.ext}"/>`);
  }
  let drawingId = 0;
  const picture = (file: ExportFile, widthPct: number, alt: string) => {
    const img = images.get(file.id);
    const rid = relOf.get(file.id);
    if (!img || !rid) return "";
    let w = (textWidthMm * widthPct) / 100;
    let h = (w * img.height) / img.width;
    if (h > textHeightMm) {
      w = (w * textHeightMm) / h;
      h = textHeightMm;
    }
    const cx = Math.round(w * EMU_PER_MM);
    const cy = Math.round(h * EMU_PER_MM);
    const id = ++drawingId;
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Imagen ${id}" descr="${xml(alt)}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}" descr="${xml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  };

  const block = (b: BookBlock, last: boolean): string => {
    // No indent after a heading, a scene break or an image (the manuscript indents every paragraph).
    if (b.kind === "para") return para(b.first ? "BodyFirst" : "Body", runs(b.spans));
    if (b.kind === "break") return para("SceneBreak", runs(plain(manuscript ? "#" : "* * *")));
    const { image, file } = b;
    const page = image.layout === "page";
    const jc = image.align === "left" ? "left" : image.align === "right" ? "right" : "center";
    const alt = image.decorative ? "" : image.alt;
    const out = [
      para("Figure", picture(file, page ? 100 : image.width_pct, alt), `${page ? "<w:pageBreakBefore/>" : ""}<w:jc w:val="${jc}"/>`),
    ];
    if (image.caption.trim()) out.push(para("Caption", runs(plain(image.caption.trim()))));
    if (image.credit.trim()) out.push(para("Credit", runs(plain(image.credit.trim()))));
    // Not after the chapter's last block: the next chapter already starts a page.
    if (page && !last) out.push(pageBreak);
    return out.join("");
  };

  // ---- body
  const body: string[] = [];
  const surname = meta.author.trim().split(/\s+/).at(-1) ?? "";
  if (manuscript) {
    // Title page: contact block left blank for the author, the title a third down, the length.
    body.push(para("Normal", runs(plain(meta.author || ""))));
    body.push(para("Title", runs(plain(model.title)), '<w:spacing w:before="4320"/>'));
    if (meta.subtitle) body.push(para("Subtitle", runs(plain(meta.subtitle))));
    if (meta.author) body.push(para("Author", runs(plain(meta.author))));
    body.push(para("Author", runs(plain(`≈ ${roundWords(model.words)} palabras`))));
  } else {
    body.push(para("Title", runs(plain(model.title)), '<w:spacing w:before="3600"/>'));
    if (meta.subtitle) body.push(para("Subtitle", runs(plain(meta.subtitle))));
    if (meta.author) body.push(para("Author", runs(plain(meta.author))));
    if (meta.publisher) body.push(para("Author", runs(plain(meta.publisher)), '<w:spacing w:before="2880"/>'));
    body.push(pageBreak);
    body.push(para("Copyright", runs(plain(meta.copyright.trim() || defaultCopyright(model.title, meta))), '<w:spacing w:before="6000"/>'));
    if (meta.dedication.trim()) {
      body.push(pageBreak);
      body.push(para("Dedication", runs(plain(meta.dedication.trim())), '<w:spacing w:before="3600"/>'));
    }
    if (meta.epigraph.trim()) {
      body.push(pageBreak);
      body.push(para("Epigraph", runs(plain(meta.epigraph.trim())), '<w:spacing w:before="3600"/>'));
      if (meta.epigraphSource.trim()) body.push(para("EpigraphSource", runs(plain(`— ${meta.epigraphSource.trim()}`))));
    }
  }
  // The book has one section for the front matter (no running heads, no page numbers) and one
  // per chapter, so that the chapter's opening page goes without running head (a "first page"
  // header) but with its number. The manuscript is a single section: every page but the title
  // page carries the "Author / TÍTULO / page" header.
  const pgSz = `<w:pgSz w:w="${twips(trim.width)}" w:h="${twips(trim.height)}"/>`;
  const pgMar = `<w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.outside)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.inside)}" w:header="${twips(Math.max(8, m.top / 2))}" w:footer="${twips(Math.max(8, m.bottom / 2))}" w:gutter="0"/>`;
  const refs = (h: [string, string, string], f: [string, string, string]) =>
    (["default", "even", "first"] as const).map((t, i) => `<w:headerReference w:type="${t}" r:id="rId${h[i]}"/>`).join("") +
    (["default", "even", "first"] as const).map((t, i) => `<w:footerReference w:type="${t}" r:id="rId${f[i]}"/>`).join("");
  const sectPr = (references: string) => `<w:sectPr>${references}${pgSz}${pgMar}<w:titlePg/></w:sectPr>`;
  const frontSect = sectPr(refs(["HeaderFirst", "HeaderFirst", "HeaderFirst"], ["FooterBlank", "FooterBlank", "FooterBlank"]));
  const chapterSect = manuscript
    ? sectPr(refs(["HeaderOdd", "HeaderOdd", "HeaderFirst"], ["FooterBlank", "FooterBlank", "FooterBlank"]))
    : sectPr(refs(["HeaderOdd", meta.layout.runningHead ? "HeaderEven" : "HeaderOdd", "HeaderFirst"], ["Footer", "Footer", "Footer"]));
  const endSection = (s: string) => `<w:p><w:pPr>${s}</w:pPr></w:p>`;

  if (!manuscript) body.push(endSection(frontSect));
  model.chapters.forEach((c, ci) => {
    body.push(para("ChapterNumber", runs(plain(c.number)), manuscript ? "<w:pageBreakBefore/>" : ""));
    if (c.title) body.push(para("Heading1", runs(plain(c.title))));
    else body.push(para("Heading1", "", '<w:spacing w:before="0" w:after="240"/>'));
    c.blocks.forEach((b, i) => body.push(block(b, i === c.blocks.length - 1)));
    if (!manuscript && ci < model.chapters.length - 1) body.push(endSection(chapterSect));
  });

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body.join("")}${chapterSect}</w:body></w:document>`;

  // ---- headers and footers
  const headerXml = (content: string, tag: "hdr" | "ftr") =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${tag} ${NS}>${content}</w:${tag}>`;
  const pageField = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const headerOdd = manuscript
    ? para("Header", `${runs(plain(`${surname ? `${surname} / ` : ""}${model.title.toUpperCase()} / `))}${pageField}`, '<w:jc w:val="right"/>')
    : meta.layout.runningHead
      ? para("Header", runs(plain(model.title)), '<w:jc w:val="right"/>')
      : para("Header", "");
  const headerEven = para("Header", runs(plain(meta.author || model.title)), '<w:jc w:val="left"/>');
  const footer = manuscript ? para("Footer", "") : para("Footer", pageField, '<w:jc w:val="center"/>');

  const font = manuscript ? "Times New Roman" : "Georgia";
  const size = manuscript ? 24 : Math.round(meta.layout.fontSize * 2);
  const line = manuscript ? 480 : 300;
  const indent = manuscript ? 720 : twips(meta.layout.indent);
  const lang = meta.language;
  const style = (id: string, name: string, pPr: string, rPr = "", extra = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"${id === "Normal" ? ' w:default="1"' : ""}><w:name w:val="${name}"/>${id !== "Normal" ? '<w:basedOn w:val="Normal"/>' : ""}${extra}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="${lang}"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="0" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    style("Normal", "Normal", "") +
    style("Body", "Cuerpo", `<w:ind w:firstLine="${indent}"/><w:jc w:val="${manuscript ? "left" : "both"}"/>`) +
    style("BodyFirst", "Cuerpo, primer párrafo", `<w:jc w:val="${manuscript ? "left" : "both"}"/>${manuscript ? `<w:ind w:firstLine="${indent}"/>` : ""}`) +
    style("Title", "Title", '<w:jc w:val="center"/><w:spacing w:after="240"/>', `<w:sz w:val="${size + 16}"/><w:szCs w:val="${size + 16}"/>`) +
    style("Subtitle", "Subtitle", '<w:jc w:val="center"/><w:spacing w:after="240"/>', "<w:i/>") +
    style("Author", "Autor", '<w:jc w:val="center"/><w:spacing w:before="240"/>') +
    style("ChapterNumber", "Número de capítulo", `<w:keepNext/><w:jc w:val="center"/><w:spacing w:before="${manuscript ? 4320 : 2400}" w:after="120"/>`, manuscript ? "" : "<w:caps/>") +
    style("Heading1", "heading 1", '<w:keepNext/><w:jc w:val="center"/><w:spacing w:after="480"/><w:outlineLvl w:val="0"/>', `<w:sz w:val="${size + 8}"/><w:szCs w:val="${size + 8}"/>`, '<w:next w:val="BodyFirst"/>') +
    style("SceneBreak", "Separador de escena", '<w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/>') +
    style("Figure", "Imagen", '<w:keepNext/><w:spacing w:before="240" w:after="120"/>') +
    style("Caption", "Caption", '<w:keepNext/><w:jc w:val="center"/><w:spacing w:after="60"/>', `<w:i/><w:sz w:val="${size - 2}"/>`) +
    style("Credit", "Crédito", '<w:jc w:val="center"/><w:spacing w:after="240"/>', `<w:sz w:val="${size - 4}"/>`) +
    style("Copyright", "Página de créditos", '<w:spacing w:after="120"/>', `<w:sz w:val="${size - 4}"/>`) +
    style("Dedication", "Dedicatoria", '<w:jc w:val="right"/>', "<w:i/>") +
    style("Epigraph", "Epígrafe", '<w:ind w:left="1440"/><w:jc w:val="left"/>', "<w:i/>") +
    style("EpigraphSource", "Fuente del epígrafe", '<w:jc w:val="right"/><w:spacing w:before="120"/>') +
    style("Header", "header", "", `<w:sz w:val="${size - 4}"/>`) +
    style("Footer", "footer", "", `<w:sz w:val="${size - 4}"/>`) +
    `</w:styles>`;

  const settings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    (!manuscript ? "<w:mirrorMargins/>" : "") +
    (!manuscript && meta.layout.runningHead ? "<w:evenAndOddHeaders/>" : "") +
    `<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
    // A line break inside a justified paragraph doesn't stretch the line before it.
    `<w:compat><w:doNotExpandShiftReturn/></w:compat></w:settings>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
    ["HeaderOdd", "HeaderEven", "HeaderFirst"].map((h) => `<Relationship Id="rId${h}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${h.toLowerCase()}.xml"/>`).join("") +
    ["Footer", "FooterBlank"].map((h) => `<Relationship Id="rId${h}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${h.toLowerCase()}.xml"/>`).join("") +
    rels.join("") +
    `</Relationships>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xml(model.title)}</dc:title><dc:creator>${xml(meta.author)}</dc:creator><dc:language>${xml(lang)}</dc:language>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Procesador</Application></Properties>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
    ["headerodd", "headereven", "headerfirst"].map((h) => `<Override PartName="/word/${h}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`).join("") +
    ["footer", "footerblank"].map((h) => `<Override PartName="/word/${h}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`).join("") +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

  const file = (name: string, s: string): ZipEntry => ({ name, data: enc.encode(s) });
  return [
    file("[Content_Types].xml", types),
    file("_rels/.rels", rootRels),
    file("docProps/core.xml", core),
    file("docProps/app.xml", app),
    file("word/document.xml", document),
    file("word/styles.xml", styles),
    file("word/settings.xml", settings),
    file("word/_rels/document.xml.rels", docRels),
    file("word/headerodd.xml", headerXml(headerOdd, "hdr")),
    file("word/headereven.xml", headerXml(headerEven, "hdr")),
    file("word/headerfirst.xml", headerXml(para("Header", ""), "hdr")),
    file("word/footer.xml", headerXml(footer, "ftr")),
    file("word/footerblank.xml", headerXml(para("Footer", ""), "ftr")),
    ...media,
  ];
}

function roundWords(n: number) {
  const r = n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100;
  // "85.000", also for four digits (toLocaleString("es") leaves "1000").
  return String(r).replace(/\B(?=(\d{3})+$)/g, ".");
}
