# Imágenes del manuscrito (Prioridad 2b)

> Estado: **implementada (Prioridad 2b).** La exportación (PDF, EPUB, DOCX) queda fuera: este modelo deja los datos listos para ella.
> Usa la [arquitectura común de archivos](archivos.md), ya implementada con la galería de Personajes. No es un editor gráfico: una imagen se comporta como un bloque más del capítulo, igual que un párrafo.

## Qué es

Una imagen insertada a propósito en un punto concreto de un capítulo (mapa, fotografía, ilustración, documento, recorte) que **forma parte del contenido editorial del libro**. Debe sobrevivir a la edición del texto, a los guardados, a duplicar la novela y a las exportaciones futuras: **PDF maquetado para impresión, EPUB y DOCX**.

Cada imagen del manuscrito tiene:

| Campo | Para qué |
|---|---|
| Archivo original | **La fuente de máxima calidad** para imprimir y exportar. Se conserva intacto (ver `assets`). |
| Derivados (≤ 2048 px y miniatura) | Sólo para la interfaz. **Nunca** determinan la calidad publicada. |
| Posición | Dónde va dentro del capítulo. |
| Texto alternativo | Accesibilidad y EPUB. Se pide al insertar, sin bloquear si se deja vacío. |
| Decorativa | Marca explícita de imagen sin contenido informativo: entonces el texto alternativo vacío es correcto. |
| Pie (opcional) | Texto bajo la imagen en el libro. |
| Crédito (opcional) | "Archivo Nacional, 1972". |
| Disposición | En el texto, o en página propia (un mapa o una lámina). |
| Alineación y ancho | Centrada, izquierda o derecha; 25, 50, 75 o 100 % de la caja de texto. |
| Reemplazar / eliminar | Cambiar el archivo sin perder posición ni textos, o quitarla. |

## Revisión para publicación

Lo revisado, y lo que cambia respecto a la versión anterior de este diseño:

| Tema | Decisión |
|---|---|
| **Fuente de calidad** | El original en `assets`, intacto: sin recomprimir, recortar ni quitar metadatos. Conserva su perfil de color ICC, que la impresión puede necesitar. Los derivados de 2048 px son sólo de interfaz. |
| **Versiones para exportar** | Cada exportación genera las suyas **a partir del original**, nunca de los derivados de interfaz. Por ejemplo: PNG o JPEG de alta calidad para DOCX, que no acepta AVIF y sólo admite WebP en versiones recientes de Word; tamaño adecuado para EPUB, que no admite AVIF; conversión de color para imprenta si hace falta. Se guardarán como versiones de exportación del archivo, sin tocar el original. Esto queda para la exportación; el modelo no lo impide. |
| **Orientación de fotos** (corrección) | Hoy `width` y `height` se leen de la cabecera tal como están guardadas, sin aplicar la etiqueta EXIF de orientación. En una foto vertical de móvil quedan intercambiadas. 2b lee esa etiqueta, guarda `orientation` y guarda las dimensiones tal como se ve la imagen. Lo necesitan la maquetación (proporción) y el cálculo de resolución. Se aplica a todas las imágenes, también a las de la galería. |
| **Tamaño** | Siempre relativo a la caja de texto (`width_pct`), nunca en píxeles ni centímetros. El mismo dato sirve para EPUB (CSS en %), PDF (ancho de caja × %) y DOCX (ancho de página útil × %). |
| **Disposición** (nuevo) | `layout`: `inline` (en el flujo) o `page` (página propia, típico de mapas y láminas). En EPUB, un bloque con salto antes y después; en PDF y DOCX, una página. Se decide ahora para no tener que deducirlo después. |
| **Alineación** | `center`, `left` y `right`. Se elimina `full`, que repetía el 100 % de ancho. En EPUB de pantalla estrecha, una imagen flotante puede pasar a centrada al exportar; es una decisión de la exportación, no del dato. |
| **Accesibilidad** (nuevo) | `decorative`: con ella, un texto alternativo vacío es intencionado. La exportación EPUB avisará de imágenes no decorativas sin texto alternativo. |
| **Numeración** | No se guarda "Figura 3". Si el libro la usa, sale del orden de capítulos y marcadores al exportar, y lo mismo una lista de ilustraciones. |
| **Pie y crédito** | Texto plano. La exportación lo escapa. Formato rico (cursivas en el pie) llegaría con el formato del manuscrito, no antes. |
| **Resolución** | Aviso, nunca bloqueo, calculado con el **original**. La caja de referencia es de 12 cm hasta que existan los ajustes de libro (formato de página), y entonces se calcula con la caja real. |
| **Formatos** | Por ahora JPEG, PNG, WebP y AVIF. TIFF (escaneos), PDF y SVG (mapas e ilustraciones vectoriales) necesitan procesar en el servidor para generar derivados; ampliar el `check` de `original_type` basta para admitirlos después. **Límite:** 50 MB por original (máximo del plan gratuito de Supabase). Para escaneos mayores harían falta un plan superior y subida reanudable (TUS); el diseño de subida firmada no cambia. |
| **Reemplazar** | Igual que en la galería, ya implementado: otro archivo y repuntar *sólo esta imagen* o *todos sus usos*. El marcador, sus textos y su posición no cambian, así que la revisión del capítulo tampoco. |
| **Duplicar novela** (corrección) | El texto copiado contiene los ids de los marcadores de la novela original. `duplicate_novel` debe reescribirlos en el contenido copiado con los ids nuevos de `manuscript_images`. |

## Formato del manuscrito: el marcador

El editor es un `<textarea>` de texto plano. Esa sencillez sostiene cosas probadas:

- autoguardado con revisiones y conflictos entre pestañas;
- deshacer, incluido el de *Reemplazar* e *Insertar escena*;
- retomar cursor y scroll;
- capítulos de 1 MB.

La imagen se representa como **un párrafo marcador**:

```
La casa estaba al final del camino de ripio.

[[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]]

Al llegar, Erika dejó el bolso en la escalera.
```

Es una **representación interna y transitoria**. Lo duradero es el modelo, que tiene dos partes:

- la **secuencia de bloques** del capítulo: párrafos, e imágenes referidas por el id de `manuscript_images`;
- los **datos de cada imagen**, en su tabla.

Un editor de bloques futuro (por ejemplo ProseMirror/TipTap) dibujaría cada marcador como un bloque visual de imagen y lo seguiría guardando igual. No hace falta migrar datos ni se rompen capítulos existentes.

Reglas del formato, documentadas en `src/lib/manuscript.ts`, que leen tanto el editor como la futura exportación:

1. Un marcador es `[[imagen:<uuid>]]` **solo en su propia línea** (se ignoran espacios alrededor). El editor lo inserta siempre como párrafo propio, con líneas en blanco antes y después.
2. Un marcador dentro de un párrafo con texto no es una imagen: el editor lo señala ("marcador dentro de un párrafo") y la exportación lo trata como texto.
3. La sintaxis `[[…]]` queda reservada para bloques futuros del formato, como un separador de escena `[[separador]]`.

Los datos (pie, texto alternativo, disposición, archivo) no están en el texto. Cambiarlos no toca el capítulo, no cambia su revisión y no provoca conflictos.

## Modelo de datos

```sql
create table if not exists public.manuscript_images (
  id          uuid primary key default gen_random_uuid(),   -- el id del marcador
  novel_id    uuid not null references public.novels(id) on delete cascade,
  asset_id    uuid not null,
  -- Dónde está el marcador según el último guardado. Lo mantiene el servidor; null = sin colocar.
  chapter_id  uuid,
  alt         text not null default '',
  decorative  boolean not null default false,
  caption     text not null default '',
  credit      text not null default '',
  layout      text not null default 'inline' check (layout in ('inline', 'page')),
  align       text not null default 'center' check (align in ('center', 'left', 'right')),
  width_pct   integer not null default 100 check (width_pct in (25, 50, 75, 100)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, novel_id),
  -- Sin cascada: el archivo no se puede borrar mientras esta imagen exista, colocada o no.
  foreign key (asset_id, novel_id) references public.assets(id, novel_id),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (chapter_id)
);

alter table public.assets add column if not exists orientation smallint not null default 1 check (orientation between 1 and 8);
```

- **`chapter_id` es un índice derivado.** La verdad es el texto. Al guardar un capítulo, el servidor lee sus marcadores y actualiza `chapter_id` en la misma petición. Sirve para listar las imágenes de un capítulo y para detectar las **sin colocar**.
- **Uso de archivo.** `manuscript_images` es otra tabla de uso de `assets`, como `character_images`. Se añade a:
  - `asset_in_use`;
  - `replace_asset_uses`, para que *todos sus usos* incluya el manuscrito;
  - `assetUses`;
  - `duplicate_novel`.

  Una imagen **sin colocar sigue siendo un uso**: quitarla del texto nunca borra el archivo.

## Comportamiento con el texto

- **Guardar nunca falla por una imagen.** Un marcador con un id desconocido o de otra novela se guarda tal cual y se muestra como "imagen no encontrada".
- **Borrar el marcador no borra la imagen.** Pasa a *sin colocar*. Desde el panel del capítulo se puede volver a insertar o eliminar definitivamente, y sólo entonces el archivo se borra, si no tiene otros usos. Con `Ctrl/⌘+Z` vuelve sola.
- **El mismo marcador dos veces:** aviso ("Esta imagen aparece dos veces"). Para una segunda imagen independiente con el mismo archivo está *Duplicar imagen*, que crea otra fila y reutiliza el archivo, sin copiarlo.
- **Mover un marcador a otro capítulo** actualiza `chapter_id` en el siguiente guardado.
- **Recuento de palabras:** los marcadores no cuentan, ni en el editor ni en `word_count()`.
- **Eliminar un capítulo:** sus imágenes pasan a *sin colocar*. La confirmación lo dice.
- **Una imagen sin colocar no se exporta,** y la exportación lo advierte.

## Editor

Sin convertir Procesador en Word:

1. **Insertar.**
   - Botón *Imagen* en la barra del capítulo, que también funciona al pegar o arrastrar un archivo sobre el editor.
   - Inserta el marcador en su propio párrafo en el cursor (lógica de `insertAtCursor`, con deshacer).
   - La subida sigue en segundo plano, con la detección de repetidos de `archivos.md`.
   - **Desde una galería**, *Insertar en el capítulo* usa el mismo archivo, sin subirlo de nuevo.
2. **Tarjeta del bloque.**
   - Al situar el cursor sobre un marcador aparece, en el margen o en la hoja inferior en móvil, una tarjeta con:
     - la miniatura;
     - el texto alternativo, la casilla *Decorativa*, el pie y el crédito;
     - la disposición, la alineación y el ancho;
     - el aviso de resolución;
     - *Reemplazar archivo*, *Descargar original*, *Duplicar* y *Quitar del capítulo*.
   - La misma tarjeta se abre desde el panel **Imágenes del capítulo**, que también lista las *sin colocar* de la novela.
3. **Vista de lectura.**
   - Un conmutador *Texto / Lectura*. *Lectura* muestra el capítulo maquetado de forma sencilla y sin edición: párrafos e imágenes con su pie, crédito, disposición, alineación y ancho, usando el derivado de interfaz.
   - Al tocar una imagen se abre su tarjeta.

En modo *Texto* el marcador se ve como texto; es la contrapartida de conservar el editor actual. La tarjeta, el panel y la vista de lectura lo compensan.

## Asistente (IA)

- Ninguna imagen, archivo ni metadato se envía a ningún modelo, salvo esta línea neutra.
- En el contexto (`context.ts`), cada marcador se sustituye por `[Imagen: {texto alternativo o pie}]`.
- **Las reescrituras no pueden perder imágenes.**
  - Si la selección contiene marcadores, se envían como `[IMAGEN 1]`, `[IMAGEN 2]` con la instrucción de conservarlos, y al aplicar se restauran los marcadores reales.
  - Si a la propuesta le falta alguno, *Reemplazar* avisa ("La propuesta quitó una imagen") y ofrece aplicarla y volver a colocarla al final del fragmento. Nunca se aplica a ciegas.
- *Insertar escena* no se ve afectado.

## Preparado para exportar (sin implementar la exportación)

Lo que una exportación necesitará y dónde está:

| Necesita | Dónde |
|---|---|
| Orden de capítulos | `chapters.position` |
| Orden y posición de cada imagen | El texto del capítulo, con las reglas del marcador |
| Archivo de máxima calidad | `assets.original_path`, intacto, con su orientación (`orientation`) |
| Proporción real | `width` y `height` ya orientados |
| Texto alternativo, decorativa, pie y crédito | `manuscript_images` |
| Disposición, alineación y ancho relativo | `manuscript_images` |
| Avisos previos | Sin colocar, sin texto alternativo, resolución insuficiente para el formato de página |

**Destinos previstos:**

- **EPUB:** `<figure>` con `alt` y `figcaption` (y `role` para las decorativas), en JPEG o PNG generado desde el original.
- **PDF de imprenta:** el original, o una conversión de color, al ancho de caja × %, con salto de página para `page`.
- **DOCX:** el original convertido a un formato que Word acepte, con el ancho en unidades de página.

Nada de esto exige decidir hoy formato de página, tipografía ni motor de maquetación.

## API

| Ruta | Hace |
|---|---|
| Subida común (`archivos.md`) con `use: { kind: "manuscript", alt, caption, … }` | Crea la fila de `manuscript_images` y devuelve su id para el marcador. Con un archivo repetido, lo reutiliza. |
| `POST /api/novels/{id}/manuscript-images` | Crea una imagen del manuscrito con un archivo que la novela ya tiene (desde una galería, o al detectar un repetido). |
| `PATCH /api/manuscript-images/{id}` | Texto alternativo, decorativa, pie, crédito, disposición, alineación, ancho. |
| `POST /api/manuscript-images/{id}/duplicate` | Otra imagen con el mismo archivo y un id nuevo. |
| `POST /api/manuscript-images/{id}/replace` | Otro archivo, sólo aquí o en todos sus usos (como la galería). |
| `DELETE /api/manuscript-images/{id}` | Eliminar definitivamente. El cliente quita su marcador, con deshacer. El archivo se borra si no tiene otros usos. |
| `PATCH /api/chapters/{id}` (existente) | Además de guardar el texto, sincroniza `chapter_id` de los marcadores presentes y libera los que desaparecieron. |
| `GET /api/novels/{id}` (existente) | Incluye `manuscriptImages`, separado de `memory`. |

## Pruebas previstas

- **Unitarias:**
  - formato del marcador: párrafo propio, dentro de un párrafo, id inválido, repetido, al principio y al final;
  - recuento de palabras sin marcadores;
  - sustitución y restauración en la IA;
  - resolución efectiva;
  - lectura de la orientación EXIF.
- **API:**
  - insertar, guardar y ver `chapter_id`;
  - quitar el marcador y ver la imagen sin colocar, con el archivo conservado;
  - mover a otro capítulo;
  - reemplazar sin cambiar la revisión del capítulo;
  - reemplazar en todos los usos, incluyendo galería y manuscrito;
  - borrar un capítulo y ver sus imágenes sin colocar;
  - eliminar definitivamente;
  - aislamiento entre novelas;
  - **duplicar novela con marcadores reescritos**;
  - insertar desde una galería sin copiar el archivo;
  - una foto vertical con su orientación y dimensiones correctas.
- **IA:**
  - el contexto lleva `[Imagen: …]` y nada más;
  - una propuesta que pierde un marcador no se aplica sin aviso.
- **UI:**
  - insertar con el botón, pegando y arrastrando;
  - deshacer;
  - la tarjeta al situar el cursor;
  - el panel de imágenes del capítulo y las sin colocar;
  - la vista de lectura con disposición, alineación y ancho;
  - móvil.

## Comportamiento del editor (implementado)

- **Escribir sobre la línea de una imagen** no rompe el marcador: el texto empieza un párrafo nuevo debajo de la imagen. Se intercepta `beforeinput`, así que funciona también con teclados de móvil y dictado.
- **Al insertar,** el marcador entra en el cursor al instante y la imagen se sube en segundo plano. El servidor la coloca en su capítulo al terminar, sin esperar a otro guardado.
- **Las opciones de la tarjeta** (decorativa, disposición, alineación, ancho) se ven al momento y se guardan en segundo plano. Si el guardado falla, vuelven a su valor.
- **Imágenes existentes en la base de datos:** las subidas antes de 2b tienen `orientation = 1` y sus dimensiones sin orientar. Si alguna foto vertical aparece apaisada, basta con reemplazar su archivo para que se lea su orientación.

## Orden de implementación propuesto

1. **Base:**
   - `manuscript_images`;
   - orientación EXIF (también para la galería);
   - formato del marcador (`src/lib/manuscript.ts`) y `word_count`;
   - `duplicate_novel` con reescritura de marcadores;
   - API y sincronización al guardar.
2. **Editor:** insertar (botón, pegar, arrastrar), tarjeta del bloque, panel de imágenes del capítulo y sin colocar.
3. **IA:** marcadores en el contexto y protección en las reescrituras.
4. **Vista de lectura y aviso de resolución.**
5. **Desde la galería:** *Insertar en el capítulo*.

La exportación (PDF, EPUB, DOCX) queda fuera de 2b.
