# Archivos · Arquitectura común

> Estado: **diseño, pendiente de aprobación.** Sustituye la parte de almacenamiento de [Memoria visual de personajes](personajes-galeria.md) y es la base de [Imágenes del manuscrito](manuscrito-imagenes.md) y de la futura Investigación/Lugares.

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
  sha256         text,                          -- detecta subidas repetidas
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
- **Reemplazar** un archivo sube `v{n+1}`, actualiza la fila y borra la versión anterior. Los usos apuntan al `asset`, no a la versión, así que no hay que tocarlos. En el manuscrito eso significa que **el texto del capítulo no cambia** y su revisión tampoco.
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
- Avisos (nunca bloqueos) cuando un original repite el `sha256` de otro de la novela: "Esta imagen ya está en la novela (Investigación › Mapa del puerto). ¿Usar la existente?".

## Lo que cambia respecto al código en curso (sin publicar)

El código de la galería que estaba a medio hacer guarda las rutas en `character_images` y descarta el original. Al aprobar este diseño:

- `character_images` pasa a tener `asset_id` en lugar de `storage_path`, `thumb_path`, `content_type`, `version`, `width`, `height` y `bytes`;
- las rutas `/api/images/…` pasan a ser `/api/assets/…` (servir, reemplazar) y `/api/character-images/…` (pie, etapa, principal, orden, borrar);
- se reutilizan sin cambios: `imageInfo()` (detección de formato por bytes), los triggers de principal única y orden, `reorder_character_images`, el Storage simulado de las pruebas (que añade la subida firmada, `info` y `Range`) y la estrategia de caché.

## Orden de implementación propuesto

1. **Archivos comunes:**
   - `assets`, bucket `novel-files`, subida firmada y `complete`, servir con caché, reemplazar, borrar huérfanos y duplicar;
   - el Storage simulado ampliado.
2. **Galería de personajes** sobre `assets` (Prioridad 2, ya aprobada).
3. **Imágenes del manuscrito** sobre `assets` (ver su diseño).
4. **Investigación/Lugares**: `place_images` con el patrón de `character_images`, y `research_items` con `asset_id` opcional.
