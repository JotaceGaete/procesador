# Personajes · Memoria visual (imagen principal y galería)

> Estado: **implementada (Prioridad 2)**, servidor e interfaz, sobre la [arquitectura común de archivos](archivos.md), compartida con las [imágenes del manuscrito](manuscrito-imagenes.md).
>
> Pendiente de esta parte: reemplazar un archivo por una nueva versión, el aviso de archivos repetidos y, con la Cronología, `story_at`.
> Compatible con [Cronología · Tratamiento de edades](cronologia-edades.md): la asociación temporal usa el tiempo narrativo, nunca una edad fija.

## Objetivo

Las imágenes son parte de la memoria de la obra, igual que las fichas, relaciones, lugares y hechos. La experiencia buscada: al entrar en Personajes reconoces a cada uno por su tarjeta, abres uno y tienes a mano su imagen principal y sus distintas referencias visuales.

Cada personaje tiene:

- una **imagen principal**, que lo representa en la lista de Personajes;
- una **galería de referencias**: aspecto físico, vestuario, peinados, edades o etapas, gestos, objetos…

Son **imágenes de referencia**: memoria visual del autor, que no necesariamente se publica. Las imágenes que forman parte del libro son otra cosa, las [imágenes del manuscrito](manuscrito-imagenes.md), aunque compartan archivos: una referencia se puede insertar en un capítulo sin volver a subirla.

## Lo que ya existe y se reutiliza

Revisé la implementación actual antes de proponer nada nuevo:

| Pieza actual | Cómo se reutiliza |
|---|---|
| `characters` con `unique (id, novel_id)` | `character_images` cuelga de ahí con la misma clave foránea compuesta. La base de datos impide asociar una imagen a un personaje de otra novela. |
| Patrón de aislamiento: `novel_id` en cada tabla, RLS sin políticas, permisos revocados a `anon`/`authenticated` | Idéntico para la tabla nueva. El bucket es privado y sin políticas en `storage.objects`: sólo la `service_role` del servidor accede. |
| Acceso sólo desde el servidor (`lib/supabase.ts`, `handler()` en cada ruta, sin `NEXT_PUBLIC_`) | Las imágenes se sirven por rutas API. La única excepción es subir el original, con una URL firmada de un solo uso (ver `archivos.md`). |
| `reorder_chapters(p_novel, p_ids)`: reordenar en una transacción exigiendo la lista completa | Mismo patrón: `reorder_character_images(p_character, p_ids)`. |
| `GET /api/novels/{id}` carga toda la novela en una vez | Añade `images` (sólo metadatos) junto a `memory`, sin otra petición. No entra en `memory`, que es de donde sale el contexto del asistente. |
| `MemoryModal`: pestaña Personajes, ficha por secciones `<details>` y bloque de sólo lectura "Relaciones" cuando la ficha ya existe | La galería es una sección más de la ficha. La lista de Personajes pasa a tarjetas. No hay un módulo aparte. |
| `duplicate_novel` copia la memoria con ids nuevos | Se amplía para copiar las filas de imágenes, y la ruta copia los archivos. |
| Ordenar con ↑ ↓ en la lista de capítulos | Mismos controles en la galería: funcionan en móvil y con teclado. |

Los archivos se guardan en la tabla común `assets` (ver `archivos.md`). `character_images` sólo guarda lo que es propio de la galería. Lugares tendrá `place_images` con el mismo patrón.

## Modelo de datos

### Tabla `character_images`

```sql
create table if not exists public.character_images (
  id            uuid primary key default gen_random_uuid(),
  novel_id      uuid not null references public.novels(id) on delete cascade,
  character_id  uuid not null,
  asset_id      uuid not null,             -- el archivo (original y derivados), ver archivos.md
  caption       text not null default '',  -- "Vestido del baile", "Con el pelo corto"
  stage_label   text not null default '',  -- etiqueta descriptiva: "1982", "tras la cárcel", "época universitaria"
  is_primary    boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade,
  foreign key (asset_id, novel_id) references public.assets(id, novel_id)
);
create index if not exists character_images_character_idx on public.character_images(character_id, sort_order);
-- Como mucho una imagen principal por personaje.
create unique index if not exists character_images_one_primary
  on public.character_images(character_id) where is_primary;
```

Respecto a la estructura sugerida:

- **`storage_path` pasa a `assets`**, junto con el original, los derivados, la versión, el tipo y las dimensiones. Así la galería, el manuscrito y la Investigación comparten un único sistema de archivos.
- **`is_primary` se mantiene**, con un índice único parcial. Así la base de datos garantiza que haya como mucho una principal. Se descartó `characters.primary_image_id`, que crearía una referencia circular entre las dos tablas y complicaría `duplicate_novel`.
- **`sort_order` se mantiene.** La principal no tiene por qué ser la primera de la galería.
- **Triggers:**
  - al insertar, la imagen va al final, la primera del personaje se convierte en principal y se controla el máximo de 40;
  - al borrar la principal, la siguiente pasa a serlo.
- **Se añade `stage_label`, una etiqueta descriptiva opcional.** El autor escribe "1982", "tras la cárcel" o "época universitaria" para reconocer la imagen. **No es información cronológica**: la app no la interpreta, no la ordena como fecha y no calcula nada con ella. La relación temporal real será `story_at` (abajo), cuando llegue la Cronología. El nombre lleva `_label` para que nadie la confunda con un dato temporal.
- **Se añade `novel_id`**, como en todas las tablas de memoria, para filtrar y aislar.

### Asociación temporal (llega con la Cronología)

Cuando exista la Cronología, se añade **una columna**, sin tocar nada más:

```sql
alter table public.character_images add column if not exists story_at jsonb;  -- { mark_id } | { date: StoryDate }
```

- Es **el mismo tipo** que ya usa el ancla de edad (`age_at.at`): o una marca temporal del relato (inicio de un capítulo, o más adelante un punto dentro de una escena), o una fecha narrativa, que puede ser parcial o relativa ("Año 5").
- **La imagen nunca guarda una edad.** "Erika, 1982" guarda `{ date: { year: 1982 } }`, y la edad (31, o "30–31") la calcula `ageAt()` en el momento de mostrarla. Si cambia el ancla de edad de Erika, el pie de todas sus imágenes se actualiza solo.
- **`stage_label` y `story_at` conviven y no se mezclan.** `stage_label` es lo que el autor quiere leer bajo la imagen ("época universitaria"); `story_at` es el punto del relato al que corresponde. Al llegar la Cronología, la app puede **proponer** un `story_at` a partir de una etiqueta como "1982", pero sólo lo guarda si el autor confirma, y nunca modifica la etiqueta.
- Con `story_at` la app puede, por ejemplo, mostrar en la ficha la referencia visual que corresponde al capítulo abierto ("Erika en este punto del relato: 1987"), o ordenar la galería cronológicamente.

Esto requiere un ajuste menor en el diseño de Cronología: `ageAt()` debe aceptar un punto del relato que sea una posición en el manuscrito **o** una fecha narrativa. Queda anotado allí.

## Almacenamiento, subida y caché

Todo esto es común y está en [Archivos · Arquitectura común](archivos.md):

- **Bucket privado:** `novel-files`, sin políticas.
- **Original conservado:** se sube directo con una URL firmada de un solo uso.
- **Derivados:** se generan en el navegador (≤ 2048 px y miniatura ≤ 480 px) y pasan por la API.
- **Caché:** versión en la URL, comprobación de la fila en cada respuesta, `max-age=600` con revalidación por ETag y `Clear-Site-Data` al cerrar sesión. Una imagen borrada o reemplazada no sigue apareciendo indefinidamente.
- **Borrado:** cuando el archivo se queda sin usos.

## API

| Ruta | Hace |
|---|---|
| `POST /api/novels/{id}/assets` → `POST /api/assets/{id}/complete` | Subida común. Con `use: { kind: "character", character_id, caption, stage_label }` crea también la fila de la galería. |
| `POST /api/characters/{id}/images` | Añade a la galería un archivo que la novela ya tiene (`{ asset_id }`), sin subirlo ni copiarlo. |
| `PATCH /api/character-images/{id}` | Edita `caption` y `stage_label` (después también `story_at`). |
| `POST /api/character-images/{id}/primary` | La marca como principal. RPC `set_primary_image`: en una transacción quita la anterior y pone esta. |
| `PUT /api/characters/{id}/images` | Reordena. RPC `reorder_character_images(p_character, p_ids)`, que exige la lista completa, como `reorder_chapters`. |
| `DELETE /api/character-images/{id}` | Borra la fila. Si era la principal, promueve la siguiente. Si el archivo se queda sin usos, se borra. |
| `POST /api/assets/{id}/replace` | Reemplaza el archivo (nueva versión). La fila de la galería no cambia. |
| `GET /api/assets/{id}/{thumb\|display\|original}?v=` | Sirve el archivo (ver `archivos.md`). |

Cambios en rutas existentes:

- **`GET /api/novels/{id}`**: añade `images` (metadatos de la galería, ordenados) junto a `memory`, sin mezclarlos.
- **`DELETE /api/memory/characters/{id}`**: las filas de la galería caen en cascada; después se borran los archivos que se quedaron sin uso.
- **`DELETE /api/novels/{id}` y `POST /api/novels/{id}/duplicate`**: los resuelve la arquitectura común.

## Interfaz

Todo ocurre dentro de **Memoria narrativa → Personajes**, sin pantalla nueva.

### Lista de Personajes: tarjetas

La lista de texto actual de esa pestaña se sustituye por una cuadrícula de tarjetas (Relaciones, Lugares y Hechos siguen como están):

```
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│   [imagen]    │ │   [imagen]    │ │      EM       │  ← sin imagen: iniciales
│               │ │               │ │               │
├───────────────┤ ├───────────────┤ ├───────────────┤
│ Erika Müller  │ │ Juan Soto     │ │ Elena Marín   │
│ Protagonista  │ │ Antagonista   │ │ Secundaria    │
│ 31 años · «La │ │ nació en 1940 │ │ «Nena»        │
│ Alemana»      │ │               │ │               │
└───────────────┘ └───────────────┘ └───────────────┘
```

- **Imagen:** la miniatura de la principal, recortada a 4:5 (`object-fit: cover`). Sin imagen, las iniciales sobre un fondo tenue.
- **Nombre** y **rol**.
- **Una línea de datos:**
  - la edad: hoy, la nota libre de "Edad o nacimiento"; con la Cronología, la edad calculada en el capítulo abierto;
  - el primer apodo de "También llamado";
  - el número de relaciones y de imágenes, en gris.
- **Rejilla adaptable:** 2 columnas en móvil y 3–4 en escritorio. La tarjeta entera es el botón que abre la ficha.
- El modal de Memoria se ensancha en esta pestaña, igual que ya hace la ficha (`wide`).

### Ficha del personaje

- **Cabecera:**
  - la imagen principal (o un hueco "Añadir imagen") a la izquierda del bloque *Esencial*;
  - en móvil, encima del bloque.
  - Al tocarla, se abre la galería.
- **Nueva sección "Galería"**, un `<details>` más entre *Esencial* e *Interior*, con:
  - cuadrícula de miniaturas con su pie y su etapa;
  - un botón **Añadir imágenes**, que acepta varias a la vez y también arrastrar y soltar, con una barra de progreso por archivo;
  - la principal, marcada con una estrella.
- **Imagen ampliada**, al tocar una miniatura. Es un visor dentro del mismo modal, con:
  - la imagen grande;
  - los campos *Pie* y *Etapa (etiqueta)*;
  - las acciones **Usar como principal**, **↑ / ↓** (o ← → en la cuadrícula) y **Eliminar** (con confirmación);
  - flechas para pasar a la siguiente imagen.
- **Antes de guardar:** la galería sólo aparece cuando el personaje ya existe, igual que el bloque "Relaciones". En una ficha nueva se ve "Guarda la ficha para añadir imágenes".
- **Las acciones de imagen se guardan al momento** (subir, borrar, ordenar, principal, pie). No dependen del botón *Guardar* de la ficha, que sigue siendo para los campos de texto, y lo dice una línea en gris en la sección.
- **Desde el visor:** *Descargar original* e *Insertar en el capítulo*. Esta segunda crea una imagen del manuscrito con el mismo archivo (ver `manuscrito-imagenes.md`).
- **Eliminar un personaje con imágenes:** la confirmación actual añade "y sus N imágenes".
- **Etiqueta:** en el visor, el campo se llama **"Etapa (etiqueta)"**, con la pista "Texto libre para reconocerla: 1982, tras la cárcel…".

## Asistente (IA)

- **No se envían imágenes, pies ni etiquetas al asistente.** El contexto de IA no cambia en esta prioridad.
- **En esta fase no se envían imágenes a ningún modelo.** Sería caro y supondría enviar material visual sin que lo pidas. El contexto de IA no cambia.
- **Futuro opcional:** una acción **"Describir para la ficha"** en el visor. Enviaría esa imagen, y sólo esa, a un modelo con visión para proponer texto para *Descripción*, mostrado como Original / Propuesta. Así el contenido visual llega a la memoria textual que sí usa el asistente, sólo con tu clic.

## Límites

- 40 imágenes por personaje (el mismo orden de magnitud que `MAX_CHARACTERS`).
- Los de archivos (`archivos.md`): 50 MB por original y tipos JPEG, PNG, WebP y AVIF, comprobados por sus bytes.

## Pruebas previstas

- **Unitarias:**
  - validación de tipo y tamaño;
  - construcción de rutas de Storage;
  - formato de la línea de datos de la tarjeta.
- **E2E de API:** `tests/e2e` hoy levanta Postgres y PostgREST, pero no Storage. Hace falta un **Storage simulado** (como `tests/mock-ai.mjs`) que implemente las llamadas que usa `supabase-js`: subir, descargar, borrar, copiar y listar. Con él se prueba:
  - subir, servir, renombrar, ordenar, cambiar la principal y borrar;
  - la promoción de la principal al borrarla;
  - el límite por personaje;
  - el aislamiento entre novelas (una imagen de otra novela da 404 o 400);
  - el borrado en cascada (personaje y novela) y que deja la carpeta vacía;
  - que duplicar una novela copia los archivos.
- **Seguridad:**
  - las rutas nuevas sin sesión responden 401;
  - el bucket no es público;
  - la clave publicable no lista ni lee objetos;
  - un archivo que no es imagen se rechaza.
- **UI (Chromium):**
  - la tarjeta muestra la principal o las iniciales;
  - subir dos imágenes, cambiar la principal y ver la tarjeta actualizada;
  - reordenar y borrar con confirmación;
  - en móvil, rejilla de dos columnas.

## Orden de implementación

1. Arquitectura común de archivos (`archivos.md`): `assets`, bucket, subida, servir, reemplazar, huérfanos, duplicar y Storage simulado.
2. `character_images` sobre `assets`, con sus RPCs y la API de la galería: principal, orden, pie, etiqueta y borrar.
3. Ficha: cabecera con la principal, sección *Galería* y visor.
4. Tarjetas en la lista de Personajes.
5. Con la Cronología (Prioridad 3): `story_at`, la edad calculada en el pie de cada imagen y la referencia del capítulo actual.
6. Opcional, posterior: "Describir para la ficha" con un modelo con visión.
