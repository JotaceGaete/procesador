import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOOK, cleanBook, isbnProblem, trimOf } from "@/lib/book";
import { bookModel, type ExportSource } from "@/lib/export/model";
import { docx } from "@/lib/export/docx";
import { epub } from "@/lib/export/epub";
import { exportName } from "@/lib/export/prepare";
import { zip, type ZipEntry } from "@/lib/zip";
import { FILE, FILE2, SOURCE, model, prepared } from "./export-sample";

const dec = new TextDecoder();
const text = (entries: ZipEntry[], name: string) => {
  const e = entries.find((x) => x.name === name);
  assert.ok(e, `${name} exists`);
  return dec.decode(e.data);
};

/** Well-formed XML: every tag closed in order, no bare "<" or "&" in text or attributes. */
function assertWellFormed(xml: string, name: string) {
  const stack: string[] = [];
  const re = /<\?[^>]*\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+);[^"<&]*)*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g;
  for (const m of xml.matchAll(re)) {
    if (m[0] === "<" || m[0] === "&") assert.fail(`${name}: bare "${m[0]}" at ${m.index}: ${xml.slice(m.index - 30, m.index + 30)}`);
    if (!m[2]) continue;
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: </${m[2]}> closes the right element`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], `${name}: everything closed`);
}

test("cleanBook: anything becomes a complete, valid book; values are clamped", () => {
  assert.deepEqual(cleanBook(null), DEFAULT_BOOK);
  assert.deepEqual(cleanBook("x"), DEFAULT_BOOK);
  const b = cleanBook({
    author: "Ana",
    language: "no es un idioma",
    isbn: "978-84 376<0494>7",
    year: "año 2026",
    coverAssetId: "../../etc",
    extra: "fuera",
    layout: { trim: "gigante", fontSize: 40, indent: -3, runningHead: "sí", margins: { top: 1, inside: "x", outside: 25 } },
  });
  assert.equal(b.author, "Ana");
  assert.equal(b.language, "es");
  assert.equal(b.isbn, "978-8437604947");
  assert.equal(b.year, "2026");
  assert.equal(b.coverAssetId, null);
  assert.ok(!("extra" in b));
  assert.deepEqual(b.layout, { trim: "6x9", fontSize: 16, indent: 0, runningHead: true, margins: { top: 5, bottom: 20, inside: 22, outside: 25 } });
  assert.equal(cleanBook({ language: "es-CL" }).language, "es-CL");
  assert.equal(trimOf(cleanBook({ layout: { trim: "a5" } })).width, 148);
});

test("isbnProblem: check digits of ISBN-13 and ISBN-10", () => {
  assert.equal(isbnProblem(""), null);
  assert.equal(isbnProblem("978-84-376-0494-7"), null);
  assert.match(isbnProblem("978-84-376-0494-8") ?? "", /dígito de control/);
  assert.equal(isbnProblem("84-376-0494-X"), null);
  assert.match(isbnProblem("84-376-0494-1") ?? "", /ISBN-10/);
  assert.match(isbnProblem("12345") ?? "", /13 cifras/);
});

test("bookModel: chapters, paragraphs, italics, images and the checks", () => {
  const m = model();
  assert.deepEqual(
    m.chapters.map((c) => [c.number, c.title, c.heading]),
    [
      ["Capítulo 1", "La llegada", "Capítulo 1: La llegada"],
      ["Capítulo 2", "", "Capítulo 2"],
    ],
    "a default title («Capítulo 2») isn't repeated as the chapter's own",
  );
  const kinds = m.chapters[0].blocks.map((b) => (b.kind === "para" ? `p${b.first ? "1" : ""}` : b.kind));
  assert.deepEqual(kinds, ["p1", "p", "p", "break", "p1", "image", "p1"], "no indent after a heading, a scene break or an image; each line is a paragraph");
  const first = m.chapters[0].blocks[0];
  assert.ok(first.kind === "para" && first.spans.some((s) => s.italic && s.text === "Rayuela"));
  assert.deepEqual(m.files.map((f) => f.id).sort(), [FILE, FILE2].sort());
  assert.equal(m.cover?.id, FILE);
  assert.ok(m.words > 20 && m.words < 40);
  const messages = m.checks.map((c) => c.message).join("\n");
  assert.match(messages, /«mapa\.png» no tiene texto alternativo/);
  assert.match(messages, /«mapa\.png» se imprimiría a \d+ ppp/, "300 px across the whole page is too little for print");
  assert.doesNotMatch(messages, /ISBN|autor|portada/, "valid ISBN, author and cover");
});

test("bookModel: missing images, unplaced ones, stray markers, empty chapters and a bad ISBN are flagged, never fatal", () => {
  const src: ExportSource = {
    ...SOURCE,
    novel: { ...SOURCE.novel, book: { isbn: "978-84-376-0494-8", coverAssetId: "99999999-9999-4999-8999-999999999999" } },
    chapters: [
      { id: "c1", title: "", content: "Hola [[imagen:00000000-0000-4000-8000-000000000000]] adiós.\n\n[[imagen:11111111-0000-4000-8000-000000000000]]" },
      { id: "c2", title: "", content: "" },
    ],
  };
  const m = bookModel(src);
  const messages = m.checks.map((c) => c.message).join("\n");
  assert.match(messages, /una imagen ya no existe/);
  assert.match(messages, /marcador de imagen dentro de un párrafo/);
  assert.match(messages, /Capítulo 2 está vacío/);
  assert.match(messages, /2 imágenes sin colocar/);
  assert.match(messages, /dígito de control/);
  assert.match(messages, /Falta el nombre del autor/);
  assert.match(messages, /portada ya no existe/);
  assert.equal(m.chapters.length, 2);
});

test("docx (libro): well-formed parts, the trim size, mirrored margins, sections without running heads where a book has none", () => {
  const files = docx(model(), "book", prepared());
  for (const f of files) if (f.name.endsWith(".xml") || f.name.endsWith(".rels")) assertWellFormed(dec.decode(f.data), f.name);
  const doc = text(files, "word/document.xml");
  // 6 × 9 in = 8640 × 12960 twips; inside 22 mm, outside 16 mm.
  assert.match(doc, /<w:pgSz w:w="8640" w:h="12960"\/>/);
  assert.match(doc, /w:right="907" [^>]*w:left="1247"/);
  assert.match(text(files, "word/settings.xml"), /<w:mirrorMargins\/>.*<w:evenAndOddHeaders\/>.*<w:doNotExpandShiftReturn\/>/);
  // Front matter + one section per chapter.
  assert.equal(doc.match(/<w:sectPr>/g)?.length, 3);
  const [front] = doc.split("</w:sectPr>");
  assert.doesNotMatch(front, /rIdHeaderOdd|rIdHeaderEven|rIdFooter"/, "no running head or page number in the front matter");
  assert.match(doc, /Todo puerto es una despedida/);
  assert.match(doc, /ISBN: 978-84-376-0494-7/);
  assert.match(doc, /<w:i\/><\/w:rPr><w:t xml:space="preserve">Rayuela<\/w:t>/);
  assert.match(doc, /de un tirón &amp; sin &lt;prisa&gt;\./);
  assert.match(doc, /<w:pStyle w:val="Body"\/><\/w:pPr><w:r><w:t xml:space="preserve">con un salto de línea\.<\/w:t>/, "a line of its own is a paragraph");
  assert.doesNotMatch(doc.slice(doc.indexOf("Capítulo 1")), /<w:br\/>/, "no line breaks in the chapters");
  assert.match(doc, /\* \* \*/);
  assert.equal(doc.match(/<wp:inline /g)?.length, 2);
  assert.match(doc, /descr="El puerto al amanecer"/);
  assert.match(text(files, "word/headerodd.xml"), /La casa del puerto/);
  assert.match(text(files, "word/headereven.xml"), /Ana Pérez/);
  assert.deepEqual(
    files.filter((f) => f.name.startsWith("word/media/")).map((f) => f.name),
    ["word/media/image1.png", "word/media/image2.png"],
  );
  // The inline image at 50 % of the text block (152.4 - 22 - 16 = 114.4 mm → 57.2 mm).
  assert.match(doc, /<wp:extent cx="2059200" cy="1544400"\/>/);
});

test("docx (manuscrito): submission format, whatever the book's page", () => {
  const files = docx(model(), "manuscript", prepared());
  for (const f of files) if (f.name.endsWith(".xml")) assertWellFormed(dec.decode(f.data), f.name);
  const doc = text(files, "word/document.xml");
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/, "A4");
  assert.equal(doc.match(/<w:sectPr>/g)?.length, 1);
  assert.match(doc, /≈ 30 palabras/);
  assert.match(doc, /<w:t xml:space="preserve">#<\/w:t>/, "scene break");
  assert.doesNotMatch(doc, /ISBN/);
  assert.match(text(files, "word/headerodd.xml"), /Pérez \/ LA CASA DEL PUERTO \/ <\/w:t>.*PAGE/);
  const styles = text(files, "word/styles.xml");
  assert.match(styles, /Times New Roman/);
  assert.match(styles, /w:line="480"/, "double spacing");
  const letter = docx(bookModel({ ...SOURCE, novel: { ...SOURCE.novel, book: { layout: { trim: "letter" } } } }), "manuscript", prepared());
  assert.match(text(letter, "word/document.xml"), /<w:pgSz w:w="12240" w:h="15840"\/>/, "letter when the author chose letter");
});

test("docx: a full-page image at the end of a chapter doesn't leave a blank page", () => {
  const src: ExportSource = { ...SOURCE, chapters: [{ ...SOURCE.chapters[1], content: "Mapa.\n\n[[imagen:00000000-1111-4222-8333-444444444444]]" }, SOURCE.chapters[0]] };
  for (const layout of ["book", "manuscript"] as const) {
    const doc = text(docx(bookModel(src), layout, prepared()), "word/document.xml");
    assert.doesNotMatch(doc.slice(doc.indexOf("Capítulo 1")), /<w:br w:type="page"\/>/, layout);
  }
});

test("epub: package, metadata, cover, navigation and accessible figures", () => {
  const files = epub(model(), prepared(), new Date("2026-10-05T12:00:00.123Z"));
  assert.equal(files[0].name, "mimetype");
  assert.equal(dec.decode(files[0].data), "application/epub+zip");
  for (const f of files) if (/\.(xml|opf|xhtml)$/.test(f.name)) assertWellFormed(dec.decode(f.data), f.name);
  const opf = text(files, "OEBPS/content.opf");
  assert.match(opf, /<dc:identifier id="bookid">urn:isbn:9788437604947<\/dc:identifier>/);
  assert.match(opf, /<dc:language>es<\/dc:language>/);
  assert.match(opf, /<dc:creator>Ana Pérez<\/dc:creator>/);
  assert.match(opf, /<meta property="dcterms:modified">2026-10-05T12:00:00Z<\/meta>/);
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /properties="nav"/);
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.deepEqual(spine, ["cover", "title", "copyright", "dedication", "epigraph", "ch1", "ch2"]);
  const nav = text(files, "OEBPS/nav.xhtml");
  assert.deepEqual([...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [
    ["chapter-001.xhtml", "Capítulo 1: La llegada"],
    ["chapter-002.xhtml", "Capítulo 2"],
  ]);
  const ch1 = text(files, "OEBPS/chapter-001.xhtml");
  assert.match(ch1, /<em>Rayuela<\/em> de un tirón &amp; sin &lt;prisa&gt;\./);
  assert.match(ch1, /<p>Segundo párrafo,<\/p>\n<p>con un salto de línea\.<\/p>/);
  assert.match(ch1, /<img src="images\/image1\.png" alt="El puerto al amanecer"\/><figcaption>El puerto<span class="credit">Foto: Archivo<\/span><\/figcaption>/);
  assert.match(ch1, /role="separator"/);
  assert.match(text(files, "OEBPS/chapter-002.xhtml"), /<figure class="page align-center"/);
  // Without ISBN, a stable identifier from the novel.
  const plain = epub(bookModel({ ...SOURCE, novel: { ...SOURCE.novel, book: {} } }), prepared());
  assert.match(text(plain, "OEBPS/content.opf"), /urn:uuid:11111111-1111-4111-8111-111111111111/);
  assert.ok(!plain.some((f) => f.name.endsWith("cover.xhtml")), "no cover page without a cover");
  // The ZIP the browser downloads starts with the uncompressed mimetype, as readers expect.
  const bytes = Buffer.concat(zip(files));
  assert.equal(dec.decode(bytes.slice(30, 38)), "mimetype");
  assert.equal(bytes[8] | (bytes[9] << 8), 0, "stored");
});

test("exportName: ASCII, so the browser keeps it", () => {
  assert.equal(exportName("La canción: «otoño»", "libro", "epub"), "La cancion «otono» - libro.epub".replace(/«|»/g, "-"));
  assert.equal(exportName("", "manuscrito", "docx"), "sin título - manuscrito.docx".replace("í", "i"));
});
