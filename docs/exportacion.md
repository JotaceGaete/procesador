# Exportación editorial

Fase 4 del plan profesional. La novela sale de Procesador como **manuscrito para envío**
(DOCX), como **libro maquetado** (DOCX con el tamaño de página del libro impreso) y como
**libro electrónico** (EPUB 3). Todo se genera en el navegador a partir del manuscrito guardado
y de los archivos originales de las imágenes; el servidor sólo guarda los datos del libro.

## 1. Dónde está

Ventana de la novela → pestaña **Libro** (en el teléfono, desde la lista de capítulos:
*Novela, copia y exportación*). Tiene tres partes:

1. **Portadilla y créditos:** autor o autora, subtítulo, editorial o sello, ISBN, año, idioma,
   página de créditos (si se deja vacía se genera una: título, © año autor, editorial, ISBN,
   «Reservados todos los derechos»), dedicatoria, epígrafe y su autor, y la portada del EPUB
   (una imagen de la novela).
2. **Página del libro impreso** (sólo para *DOCX · Libro*): tamaño de página (6 × 9 in de KDP,
   5,5 × 8,5, 5 × 8, A5, 15 × 23 cm, carta, A4), los cuatro márgenes (interior = lomo), cuerpo de
   letra, sangría y cornisa.
3. **Exportar:** el resumen (capítulos, palabras, imágenes), las comprobaciones y los tres botones.

Los datos se guardan con *Guardar*, junto con el resto de la novela. Las exportaciones usan lo
que hay en la pestaña en ese momento (aunque no se haya guardado) y el texto **guardado** de
cada capítulo, leído de nuevo al pulsar el botón.

## 2. Formatos

| | Manuscrito (DOCX) | Libro (DOCX) | EPUB 3 |
|---|---|---|---|
| Para | editoriales, agencias, concursos | revisar el libro y pasarlo a PDF | tiendas y lectores electrónicos |
| Página | A4 (carta si el libro es carta), márgenes de 2,54 cm | la elegida, márgenes en espejo | fluida |
| Letra | Times New Roman 12, doble espacio | Georgia, cuerpo elegido, 1,25 | la del lector |
| Primera página | autor, título a un tercio, subtítulo, «≈ N palabras» | portadilla | portada (si hay), portadilla |
| Preliminares | — | créditos, dedicatoria, epígrafe | créditos, dedicatoria, epígrafe |
| Cabecera | «Apellido / TÍTULO / página» (no en la primera) | cornisa: autor en pares, título en impares; ni en preliminares ni en la página que abre capítulo | — |
| Números de página | en la cabecera | al pie, desde el primer capítulo | — |
| Capítulos | página nueva, a un tercio; «Capítulo N» y su título | página nueva (sección propia); «CAPÍTULO N» y su título | un archivo por capítulo; índice |
| Separador | `#` | `* * *` | `* * *` (`role="separator"`) |
| Párrafos | todos con sangría | sangría salvo tras título, separador o imagen; justificado | igual que el libro |

Comunes a los tres:

- **Cursivas** como cursiva real (`*así*` → `<w:i/>` / `<em>`); los saltos de línea dentro de un
  párrafo se conservan (y en DOCX no estiran la línea justificada anterior).
- **Imágenes** con su tamaño respecto de la caja de texto (`width_pct`), alineación, pie y crédito;
  las de página completa en su propia página. Texto alternativo en DOCX (`descr`) y en EPUB
  (`alt`; las decorativas, `alt=""` y `role="presentation"`). Sólo las colocadas en el texto.
- El **título del capítulo** es el del autor; el que pone la app por defecto («Capítulo 3») no se
  repite debajo de «Capítulo 3».
- Nombre del archivo en ASCII («La cancion del puerto - libro.epub»), porque Chromium descarta
  los nombres con tildes.

EPUB: identificador `urn:isbn:…` si hay ISBN, si no `urn:uuid:` con el id de la novela (estable
entre exportaciones); `dc:title`, `dc:creator`, `dc:publisher`, `dc:date`, `dc:language`,
`dcterms:modified`; portada con `properties="cover-image"` (y `meta name="cover"` para lectores
EPUB 2); `nav.xhtml` con el índice. El `mimetype` va primero y sin comprimir.

## 3. Imágenes

Se descarga el **original** de cada archivo usado (`/api/assets/{id}/original?v=`), una vez
aunque aparezca varias veces:

- JPEG o PNG sin rotación EXIF: tal cual, byte a byte.
- WebP, AVIF, o una foto con orientación EXIF (Word no la aplica): se dibuja derecha en un
  lienzo; un PNG sigue siendo PNG, lo demás pasa a JPEG (calidad 0,92) sobre blanco.

Si un archivo no se puede leer, la exportación sigue sin él y lo dice («Descargado, pero sin…»).

## 4. Comprobaciones (nunca bloquean)

Antes de exportar se listan, y se exporta igual:

- imagen sin texto alternativo (afecta al EPUB);
- imagen que en ese tamaño de página se imprimiría por debajo de 200 ppp;
- imagen que ya no existe (se omite); imágenes sin colocar (no se exportan);
- marcador de imagen dentro de un párrafo (sale como texto); capítulo vacío;
- ISBN con dígito de control incorrecto o longitud imposible (ISBN-13 e ISBN-10);
- falta el autor; la portada elegida ya no existe.

## 5. Datos

`novels.book` (`jsonb`, por defecto `{}`), validado siempre por `cleanBook` (`src/lib/book.ts`):
textos con longitud máxima, idioma BCP 47 (si no, `es`), ISBN sólo cifras, guiones y X, año
sólo cifras, portada sólo si es un UUID, tamaño de página de la lista, márgenes 5–60 mm, cuerpo
8–16 pt, sangría 0–20 mm. Lo que no se reconoce se descarta. La lectura (`getNovel`) también
pasa por `cleanBook`, así que una novela antigua recibe un libro completo vacío.

`duplicate_novel` copia `book`; si la portada es un archivo de la novela, la copia apunta a su
propio archivo copiado (si no, queda sin portada). La copia de seguridad incluye `book`.

**REQUIERE ACTUALIZAR SUPABASE: SÍ** — ejecutar `supabase/schema.sql` completo (idempotente;
añade la columna y la nueva versión de `duplicate_novel`). `supabase/verificar.sql` señala la
columna y la función anteriores si faltan.

## 6. Código

| Archivo | Qué hace |
|---|---|
| `src/lib/book.ts` | Tipos, tamaños de página, valores por defecto, `cleanBook`, `isbnProblem` |
| `src/lib/export/model.ts` | El libro como lo ven los exportadores (capítulos en bloques, imágenes usadas, portada, palabras) y las comprobaciones |
| `src/lib/export/docx.ts` | OOXML a mano: estilos con nombre (Cuerpo, Título, Número de capítulo, Pie…), secciones, cabeceras, imágenes en línea |
| `src/lib/export/epub.ts` | EPUB 3: OPF, navegación, XHTML por capítulo, CSS |
| `src/lib/export/prepare.ts` | En el navegador: originales a PNG/JPEG derechos; nombre del archivo |
| `src/components/BookExport.tsx` | La pestaña *Libro* |

Puro todo salvo `prepare.ts` y el componente: las pruebas unitarias generan los tres formatos sin
navegador. Los estilos con nombre permiten retocar el DOCX en Word o LibreOffice cambiando un
estilo, no párrafo a párrafo.

## 7. Verificación

- `tests/unit/export.test.ts`: validación de datos, ISBN, modelo y comprobaciones, XML bien
  formado en cada parte, página, márgenes, secciones sin cornisa donde un libro no la lleva,
  cursivas, escapes, imágenes y su tamaño, manuscrito A4/carta, sin página en blanco tras una
  imagen de página completa al final de un capítulo, OPF, índice y figuras del EPUB.
- `tests/e2e/export.test.mjs`: API (validación, copia de seguridad), pestaña *Libro* en el
  navegador (ISBN erróneo avisado, comprobaciones, las tres descargas abiertas y revisadas, WebP
  convertido a JPEG, PNG byte a byte, guardar), duplicar con portada, teléfono.
  Con `E2E_EXPORT_DIR=/carpeta` guarda las descargas para revisarlas.
- Comprobado a mano durante el desarrollo: **epubcheck 5.1.0** sin errores ni avisos; los dos
  DOCX abren en **LibreOffice** y se convierten a PDF con su tamaño (432 × 648 pt para 6 × 9 in;
  A4) y su maquetación; `python-docx` lee estilos, cabeceras, márgenes e imágenes.

## 8. Fuera de esta fase

- **PDF para imprenta (KDP, IngramSpark):** necesita un motor de composición en el servidor
  (partición silábica, viudas y huérfanas, fuentes incrustadas, sangrado, PDF/X). Mientras
  tanto, *DOCX · Libro* ya tiene el tamaño de página y los márgenes de KDP y se exporta a PDF
  desde Word o LibreOffice. Registrado en [deuda](deuda.md).
- Cubierta completa (contracubierta y lomo), índice en el DOCX, notas al pie, partes («Primera
  parte»), versalitas en el arranque de capítulo, capitulares.
