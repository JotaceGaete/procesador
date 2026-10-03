# Archivos · Arquitectura común

> Estado: **aprobado; base implementada en el servidor** (ver "Estado de implementación" al final). Sustituye la parte de almacenamiento de [Memoria visual de personajes](personajes-galeria.md) y es la base de [Imágenes del manuscrito](manuscrito-imagenes.md) y de la futura Investigación/Lugares.

## Dos tipos de imagen, un solo sistema de archivos

| | Imágenes de referencia | Imágenes del manuscrito |
|---|---|---|
| Para qué | Memoria visual del autor: aspecto, vestuario, mapas de trabajo, documentos de investigación | Contenido editorial: mapas, fotografías, ilustraciones, documentos o recortes que forman parte del libro |
| Dónde viven | Personajes; después Lugares e Investigación | Un punto concreto de un capítulo |
| ¿Se publican? | No necesariamente | Sí: la exportación las conserva |
| Datos propios | Pie, etiqueta de etapa, principal, orden; después `story_at` | Texto alternativo, pie, crédito, alineación, ancho |
| ¿Van a la IA? | No | No (sólo un marcador de texto, ver el diseño del manuscrito) |

Lo que **comparten** es todo lo relativo al archivo: subirlo, validarlo, guardar original y derivados, servirlo con la caché correcta, versionarlo al reemplazarlo, copiarlo al duplicar una novela y borrarlo cuando nadie lo usa. Eso se implementa **una vez**.

Lo que **no comparten** son los metadatos de uso. Un pie de galería y un texto alternativo de publicación son cosas distintas. Cada uso tiene su propia tabla.

```
                    ┌──────────────────────┐
                    │ assets               │  un archivo: original + derivados, versión
                    │ (novel_id, version…) │  bucket privado novel-files
                    └──────────┬───────────┘
          ┌────────────────────┼─────────────────────┬──────────────────────┐
┌─────────┴─────────┐ ┌────────┴──────────┐ ┌────────┴────────┐ ┌───────────┴──────────┐
│ character_images  │ │ manuscript_images │ │ place_images    │ │ research_items       │
│ pie, etapa,       │ │ alt, pie, crédito,│ │ (futuro, mismo  │ │ (futuro: notas, URL, │
│ principal, orden  │ │ alineación, ancho │ │ patrón)         │ │ archivo opcional)    │
└───────────────────┘ └───────────────────┘ └─────────────────┘ └──────────────────────┘
```

Un mismo archivo puede tener varios usos. Por ejemplo, el mapa del puerto que guardaste en Investigación se inserta en el capítulo 3 sin subirlo otra vez. El archivo se borra cuando no queda ningún uso.

## Por qué tablas de uso separadas y no una tabla polimórfica

Una tabla única `attachments(owner_kind, owner_id, …)` no puede tener claves foráneas reales hacia personajes, capítulos y lugares a la vez. Perderíamos lo que hoy protege el esquema: las **claves foráneas compuestas `(id, novel_id)`**, que hacen que la base de datos rechace mezclar novelas, y el borrado en cascada. Con una tabla pequeña por uso, cada una conserva sus claves reales y sólo tiene sus propios campos.

## Tabla `assets`

```sql
create table if not exists public.assets (
  id             uuid primary key default gen_random_uuid(),
  novel_id       uuid not null references public.novels(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending', 'ready')),
  version        integer not null default 1 check (version > 0),
  file_name      text not null default '',     -- nombre original, para que el autor lo reconozca
  -- Original tal como se subió (para exportar e imprimir).
  original_path  text,
  original_type  text,                          -- image/jpeg, image/png, image/webp…
  original_bytes bigint,
  width          integer,                       -- píxeles del original
  height         integer,
  sha256         text,                          -- huella del original, calculada por el servidor
  -- Derivados para la app, generados en el navegador.
  display_path   text,                          -- lado mayor ≤ 2048 px
  thumb_path     text,                          -- lado mayor ≤ 480 px
  derived_type   text,                          -- image/webp (o jpeg si el navegador no codifica WebP)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, novel_id)
);
create index if not exists assets_novel_idx on public.assets(novel_id);
```

- **Revisión de la decisión anterior: se conserva siempre el original.** Para el libro es imprescindible: un mapa o una fotografía de 2048 px sólo da unos 17 cm a 300 ppp. Para una referencia es útil (ampliar un detalle) y el coste de almacenamiento es bajo. Un único flujo para todo es más simple que dos.
- **Las rutas incluyen la versión:** `{novel_id}/{asset_id}/v{version}/original.{ext}`, `…/display.webp`, `…/thumb.webp`. Los bytes de una versión nunca cambian.
- **Reemplazar** (ver la sección propia, más abajo) no sobrescribe nada: el archivo nuevo es otro `asset` y los usos pasan a apuntar a él. `version` queda para transformaciones futuras del mismo archivo (girar, recortar), que subirían `v{n+1}`.
- **`status = 'pending'`** mientras se sube el original (ver abajo). Los pendientes de más de 24 h se eliminan al iniciar la siguiente subida de esa novela.

## Bucket

Un solo bucket privado, **`novel-files`**:

- sin políticas en `storage.objects`, así que sólo el servidor (con la `service_role`) lee y escribe;
- `file_size_limit` de 50 MB (el máximo del plan gratuito de Supabase);
- tipos permitidos: JPEG, PNG, WebP y AVIF. TIFF y PDF quedan para más adelante, porque el navegador no puede generar sus derivados;
- las carpetas son por novela y por archivo, no por uso, porque un archivo puede tener varios usos.

## Subida

El original puede pesar más que el límite de ~4,5 MB por petición de Vercel, así que **va directo a Storage con una URL de subida firmada**. Los derivados son pequeños y siguen pasando por la API.

1. **`POST /api/novels/{id}/assets`** con `{ file_name, type, bytes }`. El servidor:
   - valida el tipo declarado y el tamaño (≤ 50 MB);
   - crea la fila `pending`;
   - devuelve una **URL de subida firmada** (`createSignedUploadUrl`) válida sólo para la ruta del original, de un solo uso y con 2 h de caducidad.
2. **El navegador:**
   - sube el original a esa URL, con barra de progreso;
   - a la vez, genera con `<canvas>` el derivado (≤ 2048 px) y la miniatura (≤ 480 px).
3. **`POST /api/assets/{id}/complete`** (multipart con derivado y miniatura). El servidor:
   - comprueba que el original existe en el bucket y su tamaño;
   - lee sus primeros bytes con una petición parcial (`Range`) para confirmar el tipo y las dimensiones reales;
   - valida derivado y miniatura por sus bytes, como ya hace el código en curso (`imageInfo`);
   - los guarda, calcula `sha256` y marca la fila `ready`.
4. **El uso se crea en la misma llamada o justo después:** una fila en `character_images` o en `manuscript_images`. Un `asset` que se queda en `pending` no aparece en ningún sitio.

Cambio respecto a la propuesta anterior: el navegador sí habla con Storage, pero **sólo para subir el original**, con una URL firmada que el servidor emite para una ruta concreta. No ve claves ni puede leer nada. Sin esto no hay forma de conservar originales grandes en Vercel.

## Lectura y caché

`GET /api/assets/{id}/{variant}?v={version}`, donde `variant` es `thumb`, `display` u `original`. Es la misma estrategia ya aprobada, ahora común:

- pasa por `proxy.ts` y `handler()`: sin sesión, 401;
- comprueba la fila en cada respuesta: si el archivo no existe, no está `ready` o `v` no es la versión actual, responde **404**;
- `Cache-Control: private, max-age=600, must-revalidate` con `ETag: "{id}-v{version}-{variant}"`; al revalidar responde **304** sin tocar Storage;
- `original` se sirve con `Content-Disposition: attachment; filename="…"` (Descargar original);
- `/api/logout` envía `Clear-Site-Data: "cache"`.

Con esto, una imagen borrada o reemplazada deja de mostrarse en el acto en la app, y en el navegador a lo sumo en 10 minutos.

## Ciclo de vida y borrado

- **Borrar un uso** (una imagen de la galería, una imagen del manuscrito): se borra la fila de uso. Si el `asset` no tiene otros usos, se borra también, primero la fila y después sus archivos.
- **Borrar un personaje o un capítulo**: las filas de uso caen en cascada. La API recoge antes los `asset_id` afectados y después borra los que se quedaron sin uso.
- **Borrar una novela**: todo cae en cascada. La API recoge antes las rutas de todos sus archivos y los borra del bucket.
- **Función `orphan_assets(p_novel)`**: devuelve los archivos sin uso. Se usa en los pasos anteriores y en un barrido de seguridad al abrir la novela, limitado y silencioso.
- **Duplicar una novela**: `duplicate_novel` copia `assets` y usos con ids nuevos y devuelve los pares de rutas. La ruta copia los archivos en Storage y, si alguna copia falla, deshace la novela nueva (como en el código en curso).

## Límites

- 50 MB por original y 4 MB entre derivado y miniatura.
- 40 imágenes por personaje (se mantiene).
- Por capítulo, sin límite propio; el límite práctico es el tamaño del capítulo.
- Archivos repetidos: ver la sección propia. Nunca se bloquea reutilizar una imagen; lo que se evita es guardarla dos veces.

## Lo que cambia respecto al código en curso (sin publicar)

El código de la galería que estaba a medio hacer guarda las rutas en `character_images` y descarta el original. Al aprobar este diseño:

- `character_images` pasa a tener `asset_id` en lugar de `storage_path`, `thumb_path`, `content_type`, `version`, `width`, `height` y `bytes`;
- las rutas `/api/images/…` pasan a ser `/api/assets/…` (servir, reemplazar) y `/api/character-images/…` (pie, etapa, principal, orden, borrar);
- se reutilizan sin cambios: `imageInfo()` (detección de formato por bytes), los triggers de principal única y orden, `reorder_character_images`, el Storage simulado de las pruebas (que añade la subida firmada, `info` y `Range`) y la estrategia de caché.

## Archivos repetidos

Objetivo: **no guardar físicamente dos veces el mismo archivo en una novela**, sin impedir usarlo en varios sitios.

1. **Antes de subir:**
   - el navegador calcula el SHA-256 del archivo y lo envía al pedir la subida;
   - si la novela ya tiene un archivo listo con esa huella y ese tamaño, no se crea nada ni se sube nada: la respuesta trae el archivo existente y dónde se usa;
   - la galería lo reutiliza como un uso más. Si ya está en la misma galería, no lo añade y lo dice ("ya está en esta galería").
2. **Al terminar la subida:**
   - el servidor lee el original guardado y calcula su propia huella. Las huellas guardadas son siempre las del servidor, nunca la del navegador;
   - si coincide con un archivo existente, descarta la copia nueva antes de guardar derivados y usa el existente;
   - `finalize_asset` repite la comprobación bajo un bloqueo por novela, de modo que dos subidas simultáneas del mismo archivo acaban en uno solo.
3. **Ámbito: por novela.** Dos novelas nunca comparten un archivo, para conservar el aislamiento y que borrar una no afecte a la otra. Duplicar una novela copia sus archivos por la misma razón.
4. **Aviso:** "Ya estaba en la novela: se usa el mismo archivo, sin guardar otra copia."

## Reemplazar un archivo

El original nunca se modifica. Reemplazar es subir otro archivo (que pasa por la detección de repetidos) y hacer que **uno o todos los usos** apunten a él, en una transacción (`replace_asset_uses`):

- **Sólo esta imagen** (`scope: "use"`): cambia ese uso. Los demás usos del archivo anterior lo conservan, y el archivo sigue guardado.
- **En todos sus usos** (`scope: "all"`): cambian todos los usos del archivo anterior.
- Cada uso conserva su id, pie, etiqueta, orden y condición de principal.
- El archivo anterior se borra (original y derivados) sólo si se quedó sin usos.
- **En la interfaz:**
  - si el archivo se usa sólo en esa imagen, se reemplaza directamente;
  - si está compartido, el visor pregunta antes, nombrando dónde más se usa ("Este archivo también se usa en: Elena Marín"), con *Sólo en esta imagen* o *En todos sus usos (N)*;
  - nunca hay efectos sobre otros usos sin esa elección explícita.
- **Rutas:**
  - archivo nuevo: subida normal con `use: { kind: "replace", character_image_id, scope }`;
  - archivo que la novela ya tiene: `POST /api/character-images/{id}/replace` con `{ asset_id, scope }`, sin subir nada.

Como el archivo nuevo tiene otro id, su URL es otra. Con eso la caché del navegador nunca muestra el anterior.

## Estado de implementación

**Hecho (servidor, base de datos y pruebas):**

- `assets` y `character_images` en `supabase/schema.sql`, con el bucket privado `novel-files` (se crea al ejecutar el esquema en Supabase).
- Los usos son la única forma de mantener vivo un archivo:
  - la clave foránea sin cascada impide borrar un `asset` en uso;
  - `delete_unused_assets()` sólo borra los que no tienen usos;
  - `asset_in_use()` es el único sitio que enumera las tablas de uso. Al añadir `manuscript_images` se amplía ahí y en `duplicate_novel`.
- Subida en dos pasos: `POST /api/novels/{id}/assets` emite la URL firmada; `POST /api/assets/{id}/complete` comprueba el original por sus bytes (lectura parcial con `Range`), guarda los derivados y crea el uso. Si algo falla, no queda nada a medias.
- `GET /api/assets/{id}/{thumb|display|original}?v=`:
  - con la caché descrita arriba;
  - el original se descarga con un enlace firmado de 60 s, porque puede superar lo que una función de Vercel puede devolver.
- Reutilizar un archivo en otra galería sin copiarlo: `POST /api/characters/{id}/images` con `{ asset_id }`.
- Galería: principal, orden, pie, etiqueta y borrar.
- Borrado seguro al eliminar una imagen, un personaje o una novela.
- Limpieza de subidas abandonadas.
- Duplicar una novela: cada archivo se copia una vez aunque tenga varios usos. La copia es independiente, de modo que borrar una novela nunca toca los archivos de la otra. Si falla una copia, se deshace.
- Storage simulado (`tests/mock-storage.mjs`) con subida firmada de un solo uso ligada a su ruta, descarga firmada, `Range` y CORS.
- Pruebas: `tests/unit/images.test.ts` y `tests/e2e/assets.test.mjs`, además de rutas y bucket en `security.test.mjs`.

- Archivos repetidos y reemplazar (secciones anteriores), con pruebas en `tests/e2e/assets-reuse.test.mjs` y en la interfaz.

**Pendiente:**

- Lugares e Investigación. Cada nueva tabla de uso se incluye en `asset_in_use`, `replace_asset_uses`, `assetUses` y `duplicate_novel`, como ya están `character_images` y `manuscript_images` (Prioridad 2b, implementada).

## Orden de implementación propuesto

1. **Archivos comunes:**
   - `assets`, bucket `novel-files`, subida firmada y `complete`, servir con caché, reemplazar, borrar huérfanos y duplicar;
   - el Storage simulado ampliado.
2. **Galería de personajes** sobre `assets` (Prioridad 2, ya aprobada).
3. **Imágenes del manuscrito** sobre `assets` (ver su diseño).
4. **Investigación/Lugares**: `place_images` con el patrón de `character_images`, y `research_items` con `asset_id` opcional.
