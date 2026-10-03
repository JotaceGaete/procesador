# Personajes · Memoria visual (imagen principal y galería)

> Estado: **propuesta, sin implementar.** Pendiente de aprobación.
> Compatible con [Cronología · Tratamiento de edades](cronologia-edades.md): la asociación temporal usa el tiempo narrativo, nunca una edad fija.

## Objetivo

Las imágenes son parte de la memoria de la obra, igual que las fichas, relaciones, lugares y hechos. Cada personaje tiene:

- una **imagen principal**, que lo representa en la lista de Personajes;
- una **galería de referencias**: aspecto físico, vestuario, peinados, edades o etapas, gestos, objetos…

Las imágenes **no entran en el manuscrito**. El editor sigue siendo texto plano.

## Lo que ya existe y se reutiliza

Revisé la implementación actual antes de proponer nada nuevo:

| Pieza actual | Cómo se reutiliza |
|---|---|
| `characters` con `unique (id, novel_id)` | `character_images` cuelga de ahí con la misma clave foránea compuesta. La base de datos impide asociar una imagen a un personaje de otra novela. |
| Patrón de aislamiento: `novel_id` en cada tabla, RLS sin políticas, permisos revocados a `anon`/`authenticated` | Idéntico para la tabla nueva. El bucket es privado y sin políticas en `storage.objects`: sólo la `service_role` del servidor accede. |
| Acceso sólo desde el servidor (`lib/supabase.ts`, `handler()` en cada ruta, sin `NEXT_PUBLIC_`) | Las imágenes también pasan por rutas API. El navegador nunca habla con Supabase ni conoce su URL. |
| `reorder_chapters(p_novel, p_ids)`: reordenar en una transacción exigiendo la lista completa | Mismo patrón: `reorder_character_images(p_character, p_ids)`. |
| `getMemory()` carga toda la memoria de una novela en una vez | Añade `images` a cada personaje (sólo metadatos), sin otra petición. |
| `MemoryModal`: pestaña Personajes, ficha por secciones `<details>` y bloque de sólo lectura "Relaciones" cuando la ficha ya existe | La galería es una sección más de la ficha. La lista de Personajes pasa a tarjetas. No hay un módulo aparte. |
| `duplicate_novel` copia la memoria con ids nuevos | Se amplía para copiar las filas de imágenes, y la ruta copia los archivos. |
| Ordenar con ↑ ↓ en la lista de capítulos | Mismos controles en la galería: funcionan en móvil y con teclado. |

No se crea una tabla genérica de "adjuntos" ni un módulo de Documentación. Si más adelante los lugares necesitan imágenes, se añade `place_images` con el mismo patrón, o se generaliza entonces con datos reales.

## Modelo de datos

### Tabla `character_images`

```sql
create table if not exists public.character_images (
  id            uuid primary key default gen_random_uuid(),
  novel_id      uuid not null references public.novels(id) on delete cascade,
  character_id  uuid not null,
  storage_path  text not null unique,      -- {novel_id}/{character_id}/{id}.webp
  thumb_path    text not null unique,      -- {novel_id}/{character_id}/{id}.thumb.webp
  caption       text not null default '',  -- "Vestido del baile", "Con el pelo corto"
  stage         text not null default '',  -- etapa en texto libre: "1982", "tras la cárcel", "niña"
  is_primary    boolean not null default false,
  sort_order    integer not null default 0,
  width         integer not null,
  height        integer not null,
  bytes         integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade
);
create index if not exists character_images_character_idx on public.character_images(character_id, sort_order);
-- Como mucho una imagen principal por personaje.
create unique index if not exists character_images_one_primary
  on public.character_images(character_id) where is_primary;
```

Respecto a la estructura sugerida:

- **`is_primary` se mantiene**, con un índice único parcial. Así la base de datos garantiza que haya como mucho una principal. Se descartó `characters.primary_image_id`, que crearía una referencia circular entre las dos tablas y complicaría `duplicate_novel`.
- **`sort_order` se mantiene.** La principal no tiene por qué ser la primera de la galería.
- **Se añade `thumb_path`** (ver Almacenamiento) y **`width`, `height` y `bytes`**, para reservar el hueco y evitar saltos al cargar.
- **Se añade `stage`, texto libre.** Es el mismo patrón que `facts.story_time` hoy: el autor escribe "1982" o "después del accidente" sin esperar a la Cronología.
- **Se añade `novel_id`**, como en todas las tablas de memoria, para filtrar y aislar.

### Asociación temporal (llega con la Cronología)

Cuando exista la Cronología, se añade **una columna**, sin tocar nada más:

```sql
alter table public.character_images add column if not exists story_at jsonb;  -- { mark_id } | { date: StoryDate }
```

- Es **el mismo tipo** que ya usa el ancla de edad (`age_at.at`): o una marca temporal del relato (inicio de un capítulo, o más adelante un punto dentro de una escena), o una fecha narrativa, que puede ser parcial o relativa ("Año 5").
- **La imagen nunca guarda una edad.** "Erika, 1982" guarda `{ date: { year: 1982 } }`, y la edad (31, o "30–31") la calcula `ageAt()` en el momento de mostrarla. Si cambia el ancla de edad de Erika, el pie de todas sus imágenes se actualiza solo.
- `stage` sigue siendo la etiqueta libre. Al llegar la Cronología, la app **propone** convertir etapas como "1982" en `story_at`, sin hacerlo sola, igual que con la nota de edad.
- Con `story_at` la app puede, por ejemplo, mostrar en la ficha la referencia visual que corresponde al capítulo abierto ("Erika en este punto del relato: 1987"), o ordenar la galería cronológicamente.

Esto requiere un ajuste menor en el diseño de Cronología: `ageAt()` debe aceptar un punto del relato que sea una posición en el manuscrito **o** una fecha narrativa. Queda anotado allí.

## Almacenamiento (Supabase Storage)

- **Bucket privado `character-images`**, creado de forma idempotente desde `schema.sql`:
  ```sql
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('character-images', 'character-images', false, 4194304, array['image/webp', 'image/jpeg', 'image/png'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;
  ```
  El bucket no tiene políticas en `storage.objects`, así que con la clave publicable no se puede listar, leer ni subir nada.
- **Rutas:** `{novel_id}/{character_id}/{image_id}.webp` y `.thumb.webp`. Borrar un personaje o una novela es borrar su carpeta.
- **Archivos inmutables:** una imagen nunca se sobrescribe. Reemplazarla es subir otra y borrar la anterior, lo que permite caché permanente en el navegador.
- **En PostgreSQL sólo hay referencias y metadatos.** Nunca bytes.

### Subida: redimensionar en el navegador y pasar por la API

1. El navegador lee el archivo (JPEG, PNG, WebP o HEIC si el navegador lo decodifica) y genera con `<canvas>`:
   - la **imagen**: lado mayor ≤ 2048 px, WebP de calidad ~0,85 (normalmente 200–800 KB);
   - la **miniatura**: lado mayor ≤ 480 px, para las tarjetas y la cuadrícula.
2. Envía ambas en un `multipart/form-data` a `POST /api/characters/{id}/images`.
3. El servidor:
   - comprueba la sesión, que el personaje exista y el límite de imágenes por personaje;
   - valida el tipo por los bytes iniciales y no por la extensión, y el tamaño (≤ 4 MB en total);
   - sube los dos objetos con la `service_role`;
   - inserta la fila. Si es la primera imagen del personaje, la marca como principal.
   - Si falla la inserción, borra los objetos recién subidos.

Por qué así y no con una URL firmada de subida directa a Storage:

- Las funciones de Vercel aceptan como mucho ~4,5 MB por petición. Redimensionar antes resuelve el límite y además ahorra espacio.
- Se mantiene la regla actual: **el navegador sólo habla con la app**. No hay que exponer la URL de Supabase, ni configurar CORS, ni manejar subidas huérfanas que nunca se confirman.
- Las miniaturas no dependen de *Image Transformations* de Supabase, que sólo está en planes de pago.
- Coste: no se conserva el original a resolución completa. Para referencia de escritura, 2048 px sobra. Si algún día hace falta, se añade una columna `original_path`.

La subida se valida en el servidor también sin el navegador: un cliente que mande un archivo enorme o que no sea imagen recibe un 400.

### Lectura: ruta propia con caché

`GET /api/images/{id}?size=thumb|full`:

- pasa por `proxy.ts` y `handler()`, como el resto, así que sin sesión devuelve 401;
- descarga el objeto con la `service_role` y lo devuelve con `Cache-Control: private, max-age=31536000, immutable`. Como el archivo nunca cambia, el navegador no lo vuelve a pedir.

Se descartaron las URLs firmadas: caducan con la pestaña abierta, cambian en cada carga (lo que impide la caché) y exponen el dominio de Supabase. Para un solo usuario y miniaturas pequeñas, el tráfico extra por Vercel es despreciable.

## API

| Ruta | Hace |
|---|---|
| `POST /api/characters/{id}/images` | Sube una imagen (multipart). Devuelve la fila. |
| `PATCH /api/images/{id}` | Edita `caption` y `stage` (después también `story_at`). |
| `POST /api/images/{id}/primary` | La marca como principal. RPC `set_primary_image`: en una transacción quita la anterior y pone esta. |
| `PUT /api/characters/{id}/images/order` | Reordena. RPC `reorder_character_images(p_character, p_ids)`, que exige la lista completa, como `reorder_chapters`. |
| `DELETE /api/images/{id}` | Borra la fila y después los dos objetos. Si era la principal, promueve la siguiente por `sort_order`. |
| `GET /api/images/{id}?size=` | Sirve el archivo (ver arriba). |

Cambios en rutas existentes:

- **`GET /api/novels/{id}`**: `getMemory()` añade `images` a cada personaje (metadatos, ordenados por `sort_order`).
- **`DELETE /api/memory/characters/{id}`**: tras borrar la fila (las imágenes caen por cascada), borra la carpeta `{novel}/{character}/` del bucket.
- **`DELETE /api/novels/{id}`**: borra la carpeta `{novel}/`.
- **`POST /api/novels/{id}/duplicate`**:
  - `duplicate_novel` copia también las filas de `character_images`, con ids y rutas nuevas, y devuelve los pares (ruta vieja, ruta nueva);
  - la ruta copia los objetos con `storage.copy`;
  - si una copia falla, borra la novela nueva y lo informa. Nunca queda una copia a medias.

Si el borrado en Storage falla después de borrar las filas, el objeto queda huérfano pero inaccesible, porque no hay fila que lo sirva. Se registra el error (sólo el mensaje, como hoy) y la operación del usuario no falla.

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
  - los campos *Pie* y *Etapa*;
  - las acciones **Usar como principal**, **↑ / ↓** (o ← → en la cuadrícula) y **Eliminar** (con confirmación);
  - flechas para pasar a la siguiente imagen.
- **Antes de guardar:** la galería sólo aparece cuando el personaje ya existe, igual que el bloque "Relaciones". En una ficha nueva se ve "Guarda la ficha para añadir imágenes".
- **Las acciones de imagen se guardan al momento** (subir, borrar, ordenar, principal, pie). No dependen del botón *Guardar* de la ficha, que sigue siendo para los campos de texto, y lo dice una línea en gris en la sección.
- **Eliminar un personaje con imágenes:** la confirmación actual añade "y sus N imágenes".

## Asistente (IA)

- **En esta fase no se envían imágenes a ningún modelo.** Sería caro y supondría enviar material visual sin que lo pidas. El contexto de IA no cambia.
- **Futuro opcional:** una acción **"Describir para la ficha"** en el visor. Enviaría esa imagen, y sólo esa, a un modelo con visión para proponer texto para *Descripción*, mostrado como Original / Propuesta. Así el contenido visual llega a la memoria textual que sí usa el asistente, sólo con tu clic.

## Límites

- 40 imágenes por personaje (el mismo orden de magnitud que `MAX_CHARACTERS`).
- 4 MB por subida, ya redimensionada.
- Tipos aceptados en el servidor: WebP, JPEG y PNG, comprobados por sus bytes.

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

1. Esquema (`character_images`, bucket, RPCs, `duplicate_novel`) y Storage simulado para las E2E.
2. API: subir, servir, editar, principal, ordenar, borrar, y los borrados en cascada.
3. Ficha: cabecera con la principal, sección *Galería* y visor.
4. Tarjetas en la lista de Personajes.
5. Con la Cronología (Prioridad 3): `story_at`, la edad calculada en el pie de cada imagen y la referencia del capítulo actual.
6. Opcional, posterior: "Describir para la ficha" con un modelo con visión.
