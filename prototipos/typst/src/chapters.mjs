// PROTOTIPO (Fase 0): ¿se puede componer y guardar en caché capítulo a capítulo sin perder la
// numeración global, las páginas en blanco del inicio a la derecha, el índice ni la paridad?
//
// Cada capítulo se compone solo, sabiendo en qué página (impresa) empieza. Como el ancho de la
// caja de texto es igual en páginas pares e impares, su composición no depende de la paridad: lo
// que cambia es dónde cae. La numeración global, las páginas en blanco y el índice se calculan
// fuera, sumando. Los preliminares se componen al final, con el índice ya conocido.
//
// `compileMap(book)` compila un libro y devuelve su <pagemap> (src/book.typ).

export async function composeByChapters(book, compileMap) {
  const right = book.layout.chapterStart === "right";
  const chapters = [];
  let start = 1; // número impreso de la página donde empieza el siguiente capítulo
  let blanks = 0;
  for (const c of book.chapters) {
    if (right && start % 2 === 0) {
      start++; // página en blanco: el capítulo abre en una derecha (impar)
      blanks++;
    }
    const m = await compileMap({ ...book, front: false, chapters: [c], firstPage: start });
    // Un capítulo que empieza en página par (sólo si no se exige la derecha) lleva una página
    // previa vacía para que su paridad física sea la del libro: se descarta.
    const dummy = !right && start % 2 === 0 ? 1 : 0;
    const pages = m.last - dummy;
    chapters.push({ n: c.n, start, pages, paragraphs: m.paragraphs.map(([id, p]) => [id, start + p - 1 - dummy]) });
    start += pages;
  }
  const toc = chapters.map((c, i) => ({ n: c.n, title: book.chapters[i].title, page: c.start }));
  const front = await compileMap({ ...book, chapters: [], toc });
  // El primer capítulo abre en la primera página impar tras los preliminares.
  const frontPages = front.last % 2 === 0 ? front.last : front.last + 1;
  return { chapters, toc, frontPages, blanks, total: frontPages + start - 1 };
}

/** Compares the by-chapter result with the whole book compiled at once (its <pagemap>). */
export function compareWithWhole(byChapter, whole) {
  const F = whole.chapters[0].page - 1; // páginas físicas antes del cuerpo
  const problems = [];
  if (F !== byChapter.frontPages) problems.push(`preliminares: ${byChapter.frontPages} por capítulos, ${F} en el libro entero`);
  const wholeStart = new Map(whole.chapters.map((c) => [c.n, c.page - F]));
  for (const c of byChapter.chapters) {
    if (wholeStart.get(c.n) !== c.start) problems.push(`capítulo ${c.n}: empieza en ${c.start} por capítulos, ${wholeStart.get(c.n)} en el libro entero`);
  }
  const wholePara = new Map(whole.paragraphs.map(([id, p]) => [id, p - F]));
  let differ = 0;
  for (const c of byChapter.chapters) for (const [id, p] of c.paragraphs) if (wholePara.get(id) !== p) differ++;
  if (differ) {
    const which = [];
    for (const c of byChapter.chapters) for (const [id, p] of c.paragraphs) if (wholePara.get(id) !== p) which.push(`${id}: ${p} / ${wholePara.get(id)}`);
    problems.push(`${differ} párrafos en otra página (${which.slice(0, 5).join("; ")})`);
  }
  const wholeTotal = whole.last;
  if (byChapter.total !== wholeTotal) problems.push(`total: ${byChapter.total} por capítulos, ${wholeTotal} en el libro entero`);
  return { ok: problems.length === 0, problems, paragraphs: whole.paragraphs.length };
}
