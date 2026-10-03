# Imágenes del manuscrito

> Estado: **diseño, pendiente de aprobación. Sin implementar.**
> Usa la [arquitectura común de archivos](archivos.md). No es un editor gráfico: una imagen se comporta como un bloque más del capítulo, igual que un párrafo.

## Qué es

Una imagen insertada a propósito en un punto concreto de un capítulo (mapa, fotografía, ilustración, documento, recorte) que **forma parte del libro**. Debe sobrevivir a la edición del texto, a los guardados, a duplicar la novela y a una futura exportación.

Cada imagen del manuscrito tiene:

| Campo | Para qué |
|---|---|
| Archivo original | Publicación o impresión. Se conserva siempre (ver `assets`). |
| Derivados | Mostrarla en la app (≤ 2048 px y miniatura). |
| Posición | Dónde va dentro del capítulo. |
| Texto alternativo | Accesibilidad y libro electrónico. Se pide al insertar, sin bloquear si se deja vacío. |
| Pie (opcional) | Texto bajo la imagen en el libro. |
| Crédito (opcional) | "Archivo Nacional, 1972". |
| Alineación | Centrada, izquierda, derecha o a todo el ancho. |
| Ancho | Porcentaje de la caja de texto: 25, 50, 75 o 100 %. |
| Reemplazar / eliminar | Cambiar el archivo sin perder posición ni textos, o quitarla. |

## Decisión central: la posición vive en el texto

El editor actual es un `<textarea>` de texto plano. Esa sencillez sostiene cosas que ya funcionan y están probadas:

- el autoguardado con revisiones y la detección de conflictos entre pestañas;
- deshacer con `Ctrl/⌘+Z`, incluido el de *Reemplazar* e *Insertar escena*;
- retomar la posición del cursor y el scroll;
- capítulos de 1 MB.

Por eso la imagen se representa en el texto como **un párrafo marcador**:

```
La casa estaba al final del camino de ripio.

[[imagen:3f2a9c1e-7b44-4d0e-9a51-0c6f2b7e8d10]]

Al llegar, Erika dejó el bolso en la escalera.
```

- **El marcador ocupa un párrafo propio.** Su posición *es* la posición de la imagen. Al escribir antes, cortar, pegar o mover párrafos, la imagen viaja con el texto sin cálculos de desplazamiento que puedan desajustarse.
- **El marcador sólo lleva el id.** Pie, texto alternativo, alineación, ancho y archivo están en `manuscript_images`. Cambiarlos no toca el texto, no cambia la revisión del capítulo y no puede provocar conflictos de guardado.
- **Deshacer funciona solo.** Insertar o borrar un marcador es una edición de texto más.
- **Preparado para otro editor.** Si un día el editor pasa a ser de bloques (por ejemplo ProseMirror/TipTap), el marcador se corresponde uno a uno con un nodo de imagen: no hace falta migrar datos.

Se descartó guardar la posición como un desplazamiento en caracteres en una tabla aparte, porque se desajusta con cada edición. También se descartó cambiar ya a un editor de bloques: cambia mucho más que las imágenes y pondría en riesgo lo que hoy funciona.

## Tabla `manuscript_images`

```sql
create table if not exists public.manuscript_images (
  id          uuid primary key default gen_random_uuid(),   -- el id del marcador
  novel_id    uuid not null references public.novels(id) on delete cascade,
  asset_id    uuid not null,
  -- Dónde está el marcador según el último guardado. Lo mantiene el servidor; null = sin colocar.
  chapter_id  uuid,
  alt         text not null default '',
  caption     text not null default '',
  credit      text not null default '',
  align       text not null default 'center' check (align in ('center', 'left', 'right', 'full')),
  width_pct   integer not null default 100 check (width_pct in (25, 50, 75, 100)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, novel_id),
  foreign key (asset_id, novel_id) references public.assets(id, novel_id),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (chapter_id)
);
```

**`chapter_id` es un índice derivado, no la fuente de verdad.** Al guardar un capítulo, el servidor lee sus marcadores y actualiza `chapter_id`, en la misma petición que ya guarda el texto. Sirve para:

- listar las imágenes de un capítulo sin leer todos los textos;
- detectar las imágenes **sin colocar**, cuyo marcador ya no está en ningún capítulo.

## Comportamiento con el texto

- **Guardar nunca falla por una imagen.** Un marcador con un id desconocido, o de otra novela, se guarda tal cual y se muestra como "imagen no encontrada". No se pierde texto.
- **Borrar el marcador no borra la imagen.** Pasa a *sin colocar*, y desde el panel del capítulo se puede volver a insertar o eliminar definitivamente. Con `Ctrl/⌘+Z` vuelve sola.
- **Un mismo marcador dos veces** (copiar y pegar): se muestra un aviso ("Esta imagen aparece dos veces"). Para tener dos copias independientes está *Duplicar imagen*.
- **Mover un marcador a otro capítulo** (cortar y pegar) actualiza `chapter_id` en el siguiente guardado.
- **Recuento de palabras:** los marcadores no cuentan, ni en el editor ni en `word_count()`.
- **Eliminar un capítulo:** sus imágenes pasan a *sin colocar* (`on delete set null`), no se pierden. La confirmación lo dice.

## Editor

Sin convertir Procesador en Word, en tres piezas:

1. **Insertar.**
   - Botón *Imagen* en la barra del capítulo, que también funciona al pegar o arrastrar un archivo sobre el editor.
   - Inserta el marcador **en su propio párrafo** en el cursor, reutilizando la lógica de `insertAtCursor`, que ya separa párrafos y se deshace con `Ctrl/⌘+Z`.
   - La subida sigue en segundo plano. Mientras dura, el bloque muestra el progreso, y el capítulo se puede seguir editando.
2. **Tarjeta del bloque.**
   - Al poner el cursor sobre un marcador, aparece junto a él, en el margen o en la hoja inferior en móvil, una tarjeta con:
     - la miniatura;
     - el texto alternativo, el pie y el crédito;
     - la alineación y el ancho;
     - *Reemplazar archivo*, *Descargar original* y *Eliminar*.
   - Es la misma tarjeta que se abre desde el panel de imágenes del capítulo.
3. **Vista de lectura.**
   - Un conmutador *Texto / Lectura*. *Lectura* muestra el capítulo maquetado de forma sencilla, sin edición: párrafos e imágenes con su pie, alineación y ancho.
   - Así se ve el bloque como quedará, sin un editor visual.
   - Al tocar una imagen se abre su tarjeta.

En el modo *Texto*, el marcador se muestra como texto y no se puede dibujar la imagen dentro del `<textarea>`. Es la contrapartida de conservar el editor actual. La tarjeta, la vista de lectura y el panel de imágenes del capítulo lo compensan.

## Calidad para publicación

- **Se conserva el original** (ver `assets`). La app trabaja con el derivado de 2048 px; la exportación usa el original.
- **Aviso de resolución, no bloqueante.** La tarjeta calcula la resolución efectiva con el ancho elegido, sobre una caja de texto de referencia de 12 cm (configurable cuando exista la exportación):
  - por ejemplo, "A 100 % se imprimiría a 170 ppp. Para 300 ppp, el original necesitaría 1.417 px de ancho";
  - por debajo de 200 ppp se marca como advertencia.
- Las imágenes del manuscrito no se recomprimen ni se recortan, y el original no se toca. La rotación o el recorte, si algún día hacen falta, generarían una nueva versión.

## Asistente (IA)

- Ninguna imagen ni su archivo se envía a ningún modelo.
- En el contexto que se construye (`context.ts`), cada marcador se sustituye por una línea neutra: `[Imagen: {texto alternativo o pie}]`. Así el modelo sabe que ahí hay una imagen sin recibirla, y no se gastan tokens en ids.
- **Las reescrituras no pueden perder imágenes.** Si la selección contiene marcadores, se envían como `[IMAGEN 1]`, `[IMAGEN 2]` con la instrucción de conservarlos. Al aplicar, se restauran los marcadores reales. Si a la propuesta le falta alguno, *Reemplazar* no lo aplica a ciegas: avisa ("La propuesta quitó una imagen") y ofrece aplicarla y volver a colocar la imagen al final del fragmento.
- *Insertar escena* no se ve afectado.

## Exportación (futura)

El formato ya contiene todo lo necesario:

- **Orden y posición:** el texto del capítulo con sus marcadores.
- **Por imagen:** original, texto alternativo, pie, crédito, alineación y ancho.
- **Una imagen sin colocar no se exporta,** y la exportación lo advierte.
- **Destinos:**
  - Markdown y EPUB: `<figure>` con `alt` y `figcaption`;
  - DOCX y PDF: el original con el ancho relativo.

## API

| Ruta | Hace |
|---|---|
| `POST /api/novels/{id}/assets` → `POST /api/assets/{id}/complete` | Subida común (ver `archivos.md`). Con `use: { manuscript: { alt, caption } }` crea también la fila de `manuscript_images` y devuelve su id para el marcador. |
| `PATCH /api/manuscript-images/{id}` | Texto alternativo, pie, crédito, alineación, ancho. |
| `POST /api/manuscript-images/{id}/duplicate` | Nueva imagen con el mismo `asset` y un id nuevo (para un segundo marcador independiente). |
| `DELETE /api/manuscript-images/{id}` | La elimina. El cliente quita también su marcador, con deshacer. Si el `asset` se queda sin usos, se borra. |
| `POST /api/assets/{id}/replace` | Nueva versión del archivo. El marcador, los textos y la posición no cambian. |
| `PATCH /api/chapters/{id}` (existente) | Además de guardar el texto, actualiza `chapter_id` de los marcadores presentes y libera los que desaparecieron de ese capítulo. |
| `GET /api/novels/{id}` (existente) | Incluye `manuscriptImages` (metadatos), igual que `images` para la galería. Ninguno de los dos entra en `memory`. |

## Desde las imágenes de referencia

- En la galería de un personaje (y después en Investigación y Lugares) habrá una acción **Insertar en el capítulo**. Crea una imagen del manuscrito con el **mismo `asset`**, sin volver a subirlo, con sus propios texto alternativo y pie.
- Lo inverso, guardar en Investigación una imagen del manuscrito, funciona igual.
- Borrar una de las dos no borra la otra. El archivo se elimina sólo cuando no queda ningún uso.

## Pruebas previstas

- **Unitarias:**
  - leer marcadores de un texto, con casos de id inválido, repetido o marcador partido;
  - sustituir marcadores en el contexto de IA y restaurarlos tras una reescritura;
  - cálculo de la resolución efectiva;
  - que el recuento de palabras ignore los marcadores.
- **API:**
  - insertar, guardar el capítulo y ver `chapter_id` actualizado;
  - quitar el marcador y ver la imagen *sin colocar*;
  - moverla a otro capítulo;
  - reemplazar el archivo sin cambiar la revisión del capítulo;
  - borrar el capítulo y ver la imagen *sin colocar*;
  - borrar la imagen, y su archivo cuando ya no tiene usos;
  - aislamiento entre novelas (un marcador de otra novela no se resuelve);
  - duplicar una novela conserva marcadores e imágenes con ids nuevos.
- **IA:**
  - el contexto enviado contiene `[Imagen: …]` y no ids ni archivos;
  - una propuesta que pierde un marcador no se aplica sin aviso.
- **UI:**
  - insertar desde el botón y pegando un archivo;
  - deshacer la inserción;
  - la tarjeta al situar el cursor sobre el marcador;
  - la vista de lectura con alineación y ancho.

## Encaje en prioridades (propuesta)

- **Prioridad 2** (aprobada): galería de personajes. Se construye sobre la arquitectura común de archivos, que se implementa primero.
- **Imágenes del manuscrito:** justo después de la galería, como **Prioridad 2b**. Comparte toda la infraestructura y sólo añade la tabla de uso, los marcadores y las piezas del editor.
- **Exportación:** no está en ninguna prioridad definida. Este diseño sólo garantiza que no se pierde nada de lo que necesitará.
