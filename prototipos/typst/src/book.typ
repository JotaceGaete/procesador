// PROTOTIPO (Fase 0, descartable): el libro de Procesador compuesto con Typst.
// Lee los datos de /book.json (src/novel.mjs describe su forma). El texto del autor llega
// siempre como datos (cadenas), nunca como marcado: no se interpreta nada de lo que escribe.

#let book = json("/book.json")
#let L = book.layout
#let mm = 1mm

// ---------------------------------------------------------------- página y texto
#let first-page = book.at("firstPage", default: 1)
#set document(title: book.title, author: book.author)
#set text(font: "Libertinus Serif", size: L.fontSize * 1pt, lang: "es", region: "cl", hyphenate: true)
// Novela: sin espacio entre párrafos (spacing = leading), sangría salvo tras título, separador o imagen.
// Viudas y huérfanas: Typst las evita por defecto (coste 100 %); `widows: false` sólo para la
// prueba de control (demostrar que la comprobación las detecta).
#set text(costs: if L.at("widows", default: true) { (widow: 100%, orphan: 100%) } else { (widow: 0%, orphan: 0%) })
#set par(justify: true, leading: L.leading * 1em, spacing: L.leading * 1em, first-line-indent: L.indent * mm)
#set footnote.entry(separator: line(length: 25%, stroke: 0.4pt), gap: 0.4em, clearance: 0.9em)
#show footnote.entry: set text(size: 0.82em)
#show footnote.entry: set par(first-line-indent: 0pt, justify: true)

// Marcas invisibles: inicio y fin de cada sección (para saber qué páginas quedan en blanco),
// inicio de capítulo (cornisa, número, índice) y comienzo del cuerpo (numeración arábiga).
#let mark(value, name) = [#metadata(value)#label(name)]

// Páginas «silenciosas» (sin cornisa ni número): preliminares, la que abre un capítulo, las que
// quedan en blanco antes de un capítulo y las de imagen completa. Un estado que se pone en
// «silencio» al terminar una sección y vuelve a «normal» tras el título de cada capítulo: la
// cornisa de una página lee el estado al principio de esa página. (Antes cada página consultaba
// el documento entero: 4,7 de 7,4 s con 200.000 palabras.)
#let quiet = state("quiet", true)
// La página física donde abre el último capítulo (el pie de esa página ya ve «normal»).
#let opening = state("opening", 0)

#set page(
  width: L.width * mm,
  height: L.height * mm,
  margin: (inside: L.margins.inside * mm, outside: L.margins.outside * mm, top: L.margins.top * mm, bottom: L.margins.bottom * mm),
  binding: left,
  header-ascent: 40%,
  footer-descent: 40%,
  header: context {
    let p = here().page()
    if not L.runningHead or quiet.get() { return }
    set text(size: 0.78em, tracking: 0.08em)
    // Página par (izquierda): autor; impar (derecha): título. Por paridad física.
    if calc.even(p) { align(left, smallcaps(book.author)) } else { align(right, smallcaps(book.title)) }
  },
  footer: context {
    let p = here().page()
    if quiet.get() or opening.get() == p { return }
    set text(size: 0.85em)
    // El número en el lado exterior.
    let n = counter(page).display("1")
    if calc.even(p) { align(left, n) } else { align(right, n) }
  },
)

// ---------------------------------------------------------------- bloques
#let spans(s) = for x in s {
  let (kind, value) = (x.at(0), x.at(1))
  if kind == "i" { emph(value) } else if kind == "n" { footnote(value) } else { value }
}

#let scene-break = block(sticky: true, above: 1.1em, below: 1.1em, width: 100%, align(center, [\*#h(1.2em)\*#h(1.2em)\*]))

#let figure-block(b) = {
  let path = "/img/" + b.src + ".png"
  let foot = {
    if b.caption != "" { text(size: 0.88em, style: "italic", b.caption) }
    if b.credit != "" { linebreak(); text(size: 0.78em, b.credit) }
  }
  if b.page {
    // Imagen de página completa: su propia página, sin cornisa ni número.
    page(header: none, footer: none, {
      mark(b.id, "full-page")
      align(center + horizon, block(width: 100%, height: 100%, {
        align(center, image(path, height: 88%, fit: "contain"))
        v(0.6em)
        align(center, par(first-line-indent: 0pt, justify: false, foot))
      }))
    })
  } else {
    // En línea: con su pie, nunca separada de él; si no cabe, pasa a la página siguiente (y deja
    // hueco), o, con `floatImages`, flota arriba o abajo de la página más cercana y el texto llena
    // el hueco (el orden texto/imagen deja de ser exacto).
    let fig = block(breakable: false, above: 1.2em, below: 1.2em, width: 100%, {
      mark(b.id, "img")
      let al = if b.align == "left" { left } else if b.align == "right" { right } else { center }
      // Ancho pedido sobre la caja de texto, pero nunca más alto que el 75 % de la caja (para que
      // quepa con su pie): calculado con las proporciones del archivo, sin medir nada.
      let box-w = L.width - L.margins.inside - L.margins.outside
      let box-h = L.height - L.margins.top - L.margins.bottom
      let w = box-w * b.width / 100
      let h = w * b.px.at(1) / b.px.at(0)
      if h > box-h * 0.75 { w = box-h * 0.75 * b.px.at(0) / b.px.at(1) }
      align(al, image(path, width: w * mm))
      v(0.45em)
      align(center, par(first-line-indent: 0pt, justify: false, foot))
    })
    if L.at("floatImages", default: false) { place(auto, float: true, clearance: 1.2em, fig) } else { fig }
  }
}

#let chapter(c, first) = {
  // El cuerpo abre siempre en una página derecha (el capítulo 1); los demás, según la opción.
  if c.n == 1 or L.chapterStart == "right" { pagebreak(weak: true, to: "odd") } else { pagebreak(weak: true) }
  // Notas numeradas por capítulo: así un capítulo se compone igual solo que dentro del libro
  // (un «12» es más ancho que un «1» y cambiaría los cortes de línea).
  counter(footnote).update(0)
  // El cuerpo empieza con el primer capítulo: numeración arábiga desde `first-page`.
  if first { counter(page).update(first-page); mark("b", "body-start") }
  mark("s", "sec-start")
  mark((n: c.n, title: c.title), "chapter-start")
  context opening.update(here().page())
  v(L.height * mm * 0.18)
  align(center, text(size: 0.8em, tracking: 0.15em, upper("Capítulo " + str(c.n))))
  if c.title != "" {
    v(0.5em)
    align(center, text(size: 1.45em, c.title))
  }
  v(2.6em)
  quiet.update(false)
  for b in c.blocks {
    if b.k == "p" {
      // Primer párrafo tras título, separador o imagen: sin sangría.
      if b.first { par(first-line-indent: 0pt, [#mark(b.id, "pm")#spans(b.s)]) } else { par([#mark(b.id, "pm")#spans(b.s)]) }
    } else if b.k == "break" {
      scene-break
    } else if b.k == "img" {
      figure-block(b)
    }
  }
  mark("e", "sec-end")
  quiet.update(true)
}

// ---------------------------------------------------------------- preliminares
#let front-page(body, to: "odd") = {
  pagebreak(weak: true, to: to)
  mark("s", "sec-start")
  body
  mark("e", "sec-end")
}

#if book.front {
  // Portadilla (1), portada (3), créditos (4, al dorso), dedicatoria (5), epígrafe (7), índice (9).
  page[#mark("s", "sec-start")#v(28%)#align(center, text(size: 1.6em, book.title))#mark("e", "sec-end")]
  front-page({
    v(18%)
    align(center, text(size: 2.2em, book.title))
    align(center, text(size: 1.2em, style: "italic", book.subtitle))
    v(12%)
    align(center, text(size: 1.15em, book.author))
    v(1fr)
    align(center, text(size: 0.95em, book.publisher))
  })
  front-page(to: "even", {
    v(1fr)
    set text(size: 0.8em)
    set par(first-line-indent: 0pt, justify: false)
    [#book.title. #book.subtitle \ © #book.year #book.author \ Edición: #book.publisher \ Reservados todos los derechos.]
  })
  front-page(align(right, block(width: 70%, { v(22%); set par(first-line-indent: 0pt); emph(book.dedication) })))
  front-page({
    v(22%)
    align(right, block(width: 70%, {
      set par(first-line-indent: 0pt, justify: false)
      emph(book.epigraph)
      linebreak()
      align(right, text(size: 0.9em, "— " + book.epigraphSource))
    }))
  })
  front-page({
    v(12%)
    align(center, text(size: 1.1em, tracking: 0.12em, upper("Índice")))
    v(2em)
    set par(first-line-indent: 0pt, justify: false)
    // El índice: dado desde fuera (composición por capítulos) o leído del propio documento.
    let row(e) = [#("Capítulo " + str(e.n) + if e.title != "" { ": " + e.title } else { "" }) #box(width: 1fr, repeat[.]) #str(e.page) \ ]
    if book.at("toc", default: none) != none {
      for e in book.toc { row(e) }
    } else {
      context for m in query(label("chapter-start")) {
        row((n: m.value.n, title: m.value.title, page: counter(page).at(m.location()).first()))
      }
    }
  })
}

// Componer un solo capítulo que empieza en una página par: una página previa vacía (descartada
// por quien llama) para que la paridad física sea la del libro entero.
#if not book.front and calc.even(first-page) and L.chapterStart != "right" {
  page[#mark("s", "sec-start")#mark("e", "sec-end")]
}

#for (i, c) in book.chapters.enumerate() { chapter(c, i == 0) }

// ---------------------------------------------------------------- mapa para la aplicación
// Párrafo → página (física y número impreso), inicio de cada capítulo, imágenes y páginas en blanco.
#context [#metadata((
  paragraphs: query(label("pm")).map(m => (m.value, m.location().page())),
  chapters: query(label("chapter-start")).map(m => (n: m.value.n, page: m.location().page(), number: counter(page).at(m.location()).first())),
  images: (query(label("img")) + query(label("full-page"))).map(m => (m.value, m.location().page())),
  total: counter(page).final().first(),
  last: here().page(),
))<pagemap>]
