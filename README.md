# Procesador

Procesador de textos personal para escribir novelas con asistencia de IA. Tú imaginas la historia; el procesador conoce tu obra (su Guía Maestra, sus personajes, lugares y hechos) y te ayuda a convertir tus argumentos en prosa, manteniendo la continuidad, el estilo y la voz de los personajes. El manuscrito es siempre el centro.

**Stack:** Next.js 16 (App Router + API Routes) · Supabase (Postgres) · Claude, GPT y Grok, intercambiables · Vercel.

## Uso

- **Biblioteca** (`/`): tus novelas, con la última abierta primero. Puedes crear, abrir, renombrar y duplicar novelas, y eliminarlas con una confirmación explícita. Duplicar copia capítulos y memoria.
- **Capítulos**: clic en el título del capítulo, en la barra superior, para mostrar u ocultar la lista. Desde ahí puedes crear, renombrar, reordenar (↑ ↓) y eliminar capítulos (con confirmación). Al volver, la app abre la última novela y capítulo, con el cursor y el scroll donde estaban.
- **Guía Maestra** (clic en el título de la novela): género, época, narrador, persona, tiempo verbal, tono, estilo, diálogos, regionalismos, temas, cosas que evitar…
  - Todo es opcional.
  - La app la convierte en las instrucciones que recibe cualquier modelo. *Ver instrucciones maestras* muestra el resultado.
- **Memoria**: Personajes, Relaciones (Juan → hermano de → Pedro), Lugares y Hechos de continuidad, estos últimos ligados opcionalmente a personajes, capítulo, lugar y fecha. Cada novela tiene la suya.
  - **Memoria visual de Personajes**: tarjetas con la imagen principal (o las iniciales), y en la ficha la imagen principal y una *Galería* de referencias. Se suben con el selector o arrastrando, y se ven ampliadas con su pie y su etapa. Subir, eliminar, elegir la principal y ordenar se guardan al momento. Se conserva el original; la app sólo carga miniaturas y versiones reducidas. Reemplazar un archivo pregunta, si está compartido, si es sólo en esa imagen o en todos sus usos. Un archivo repetido nunca se guarda dos veces: se reutiliza. Las imágenes no se envían al asistente.
- **Asistente** (panel derecho; en móvil, hoja inferior). Tiene dos modos:
  - *Editar selección*: Redacción, Diálogo, Expandir, Acortar. Es conservador: preserva hechos, intención, voz y regionalismos. Las propuestas se muestran como **Original / Propuesta**.
  - *Escribir escena*: escribes el argumento y pulsas **Desarrollar escena**. Puedes marcar quién está en escena, el lugar y la extensión. Tu argumento es la autoridad sobre lo que ocurre; la IA sólo decide cómo contarlo. La escena se puede **insertar en el cursor**.
  - Nada se escribe en el manuscrito sin tu clic. Cada propuesta ofrece *Otra versión*, *Copiar*, *Limpiar* y *Probar con* otro proveedor.
  - Al *Reemplazar* o *Insertar*, la propuesta sale del panel y el cursor queda al final del texto nuevo, listo para seguir escribiendo. Un aviso ofrece *Deshacer* (el mismo historial que `Ctrl/⌘+Z`). Si no se puede aplicar, la propuesta se queda con el motivo.
  - Cada pestaña (*Editar selección*, *Escribir escena*) guarda su propia propuesta pendiente.
  - En el teléfono el panel es una hoja inferior compacta, de hasta el 58 % de la pantalla, que se mantiene por encima del teclado. Al aplicar una propuesta se cierra para dejar el manuscrito a la vista.
  - Bajo cada respuesta, una línea discreta indica qué se leyó, los tokens usados y, si hay precios en `AI_PRICES`, el coste aproximado. Sólo se pide confirmación por encima de `AI_CONFIRM_TOKENS`.
- **Consejero** (mismo panel; [diseño](docs/consejero.md)): piensa contigo sobre la novela, nunca escribe en el manuscrito.
  - *Consultar*: *Analizar capítulo*, *¿Cómo seguir?*, *Repeticiones*, *Cabos pendientes*, *Coherencia*, *Personajes*, o una pregunta libre.
    - La respuesta trae observaciones con tipo, confianza y citas comprobadas en el texto, cada una con *Ir*. Lo que no se puede verificar se presenta como impresión.
    - *¿Cómo seguir?* propone caminos, no escribe la continuación; uno se puede *Enviar al Asistente*.
    - Antes de responder lee los capítulos que no tengan ficha.
    - Las consultas forman conversaciones que se pueden continuar; lo más antiguo se resume solo.
    - Cada observación se puede guardar, descartar, marcar resuelta, volver a comprobar tras editar o convertir en un hecho sugerido para la Memoria.
  - *Guardadas*: las observaciones que conservaste, con aviso si el capítulo cambió desde entonces.
  - *Lectura profunda* (activada por defecto): si una pregunta lo requiere, el Consejero pide en rondas fichas, pasajes, datos de personajes, hechos, cabos o, como último recurso, un capítulo completo. Nunca la novela entera. Tiene límites de rondas, material y coste, y bajo la respuesta indica qué consultó.
  - *Sobre la selección*: Consistencia, Personaje y Evolución, con el modelo del Consejero.
  - *Panorama*, sin IA, medido en el texto:
    - cuánto hace que no aparece cada personaje;
    - frases repetidas y ecos de palabras, en el capítulo o entre capítulos, cada aparición con *Ir* al fragmento;
    - mapa de la novela;
    - uso de la IA en el mes.
  - *Cabos y lecturas*: la lectura de la novela con el modelo económico.
    - Una ficha por capítulo, con resumen, acontecimientos con citas verificadas e *Ir*, quién está en escena, revelaciones y cabos.
    - Los cabos de la novela: confirmar, renombrar, cerrar, fusionar o añadir.
    - Un resumen global hecho a partir de las fichas.
    - Cada ficha indica si está al día, con retoques o desactualizada.
    - Si está activado, un capítulo se relee al dejarlo sólo cuando cambió de forma sustancial; nunca mientras escribes.
- **Imágenes del manuscrito** (contenido del libro): botón *Imágenes*, pegar o arrastrar una imagen sobre el texto. Cada imagen es un párrafo marcador `[[imagen:…]]`; al poner el cursor encima aparece su tarjeta: texto alternativo (o *decorativa*), pie, crédito, disposición (en el texto o página propia), alineación, ancho y aviso de resolución calculado con el original. *Quitar del capítulo* la deja *sin colocar*, conservada. *Lectura* muestra el capítulo con sus imágenes. Una imagen de una galería se inserta sin copiar el archivo. El asistente sólo ve `[Imagen: …]`, y una reescritura que pierde una imagen no se aplica sin avisar.
- **Concentración** (`Ctrl/⌘ + .`, `Esc` para salir): sólo el texto y el cursor.
- **Guardado**: automático, por capítulo.
  - Si un capítulo cambió en otra pestaña o dispositivo, no se pisa: eliges *Cargar esa versión* o *Conservar la mía*.
  - Al cambiar de capítulo, la app espera a que el actual termine de guardarse.

## Qué se envía a la IA

Sólo lo relevante. El manuscrito completo nunca se envía por defecto.

| Operación | Contexto |
|---|---|
| Redacción, Diálogo, Expandir, Acortar | Guía Maestra, selección, ~4.000 caracteres antes y ~1.500 después, fichas de los personajes nombrados o elegidos |
| Consistencia | Lo anterior, más relaciones, lugares y hechos relevantes, y pasajes de toda la novela donde aparecen los personajes de la selección |
| Personaje, Evolución | La ficha, sus relaciones, sus hechos y sus pasajes en toda la novela |
| Desarrollar escena | Guía Maestra, argumento, capítulo, ~6.000 caracteres antes del cursor (y el final del capítulo anterior si el actual empieza), personajes en escena o nombrados, sus relaciones, lugares y hechos |

- "Relevante" se decide por nombres y apodos (de personajes y lugares) y por los vínculos de cada hecho. No hay embeddings ni base vectorial.
- Los hechos de capítulos posteriores se marcan como "aún no ocurridos". Los hechos *sugeridos* (reservados para el futuro) nunca se usan sin tu aprobación.
- El panel muestra el tamaño del contexto antes de enviar y pide confirmación por encima de ~30.000 tokens. *Incluir la novela completa* indica cuántos tokens añade.

## Puesta en marcha

1. **Supabase**:
   - Crea un proyecto.
   - En **SQL Editor**, ejecuta [`supabase/schema.sql`](supabase/schema.sql). También crea el bucket privado `novel-files` de Storage.
     - Es idempotente y conserva los datos: sólo crea lo que falta (tablas, columnas, índices, funciones, triggers, RLS y permisos).
     - Sólo borra las tablas de la primera etapa (MVP), reconociéndolas por sus columnas.
     - Al actualizar la app, vuelve a ejecutarlo.
     - [`supabase/verificar.sql`](supabase/verificar.sql) (sólo lectura) lista lo que le falta a una base existente; vacío = al día.
   - Copia la *Project URL* y la clave **secret / service_role**. La clave *publishable* no sirve: el esquema le niega todo acceso.
2. **Variables** (`cp .env.example .env.local`):

| Variable | Obligatoria | |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | sí | Sólo servidor |
| `APP_PASSWORD` | en producción | Si falta en producción: 503 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` | al menos una | Con varias aparece un selector |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` |
| `ANTHROPIC_EFFORT` | no | `medium` |
| `OPENAI_MODEL` | no | `gpt-5.5` |
| `XAI_MODEL` | no | `grok-4` |
| `AI_PROVIDER` | no | Proveedor inicial |
| `ANTHROPIC_MODEL_ADVISE` / `OPENAI_MODEL_ADVISE` / `XAI_MODEL_ADVISE` | no | Modelo del Consejero. Por defecto, el de escritura |
| `ANTHROPIC_MODEL_DIGEST` / `OPENAI_MODEL_DIGEST` / `XAI_MODEL_DIGEST` | no | Modelo económico de análisis y resúmenes. Por defecto, el de escritura |
| `AI_PRICES` | no | JSON con los precios en US$ por millón de tokens, para mostrar el coste. Ej.: `{"claude-opus-5-5":{"input":5,"cached":0.5,"output":25}}` |
| `AI_CONFIRM_TOKENS` | no | Umbral para pedir confirmación antes de enviar. Por defecto `150000` |
| `DEEP_MAX_ROUNDS` / `DEEP_MAX_REQUESTS` / `DEEP_MAX_MATERIAL_TOKENS` / `DEEP_MAX_CHAPTERS` / `DEEP_CHAPTER_TOKENS` / `DEEP_MAX_COST_USD` | no | Límites de la lectura profunda por consulta: `3` rondas, `6` pedidos por ronda, `40000` tokens de material, `2` capítulos completos de hasta `20000` tokens, US$ `0.5` |
| `DIGEST_CHANGE_PCT` / `DIGEST_CHANGE_MIN_WORDS` / `DIGEST_CHANGE_WORDS` | no | Cuándo un cambio es sustancial y desactualiza una ficha: `15` % del texto con al menos `40` palabras, o `300` palabras nuevas |

3. **Local**: `npm install`, `npm run dev`, `npm run typecheck`, `npm run build`.
4. **Vercel**: importa el repositorio y añade las variables. `/api/assist` declara `maxDuration = 300` s.

## Pruebas

```bash
npm run typecheck
npm test            # unitarias (~1 s): contexto, prompts, Guía Maestra, sesiones, los tres proveedores
npm run test:schema # actualización de bases existentes (~20 s): schema.sql sobre cada estado real
npm run test:e2e    # de punta a punta (~2–3 min): API, seguridad e interfaz en Chromium
npm run test:all    # todas
```

`npm run test:schema` levanta un Postgres temporal y comprueba que `supabase/schema.sql` y `supabase/actualizar-consejero.sql` se pueden ejecutar completos, dos veces, sin errores y sin alterar los datos.
- **Estados de partida:** base vacía; base anterior al Consejero (2b); base de la fase 1; base actualizada a medias a mano; y base con las fases 2–4 (versiones guardadas en `tests/schema/fixtures`).
- **Modos de ejecución:** el archivo entero como una sola consulta (como el SQL Editor de Supabase) y sentencia a sentencia (como `psql`).
- **Regresión:** una ejecución que llega al bloque de triggers sin `story_threads` ya no da `relation "public.story_threads" does not exist`.
- **Comprobación estática:** ninguna sentencia se refiere a una tabla antes del `create table` que la garantiza.

`npm run test:e2e` levanta un entorno desechable y lo elimina al terminar. No usa claves reales ni crea recursos externos:

- Un Postgres temporal con `supabase/schema.sql`, aplicado dos veces para comprobar que es idempotente.
- PostgREST detrás de `/rest/v1`, igual que Supabase.
- Un Storage en memoria detrás de `/storage/v1` (`tests/mock-storage.mjs`), con buckets privados y URLs firmadas.
- Servidores que imitan las APIs de Anthropic, OpenAI y xAI (`tests/mock-ai.mjs`). Las llamadas pasan por los SDK reales.
- `next build` y dos servidores: uno normal y otro en producción sin `APP_PASSWORD`, que debe responder 503.

| Archivo | Cubre |
|---|---|
| `tests/unit/context.test.ts` | Nombres y apodos, contexto cercano, manuscrito por capítulos, pasajes, selección de memoria |
| `tests/unit/prompts.test.ts` | Instrucciones distintas para editar y escribir, prompts de edición y escena, memoria, Guía Maestra |
| `tests/unit/auth.test.ts` | Sesión firmada y caducidad, cierre por defecto sin `APP_PASSWORD` |
| `tests/unit/providers.test.ts` | Claude, GPT y Grok: streaming, caché del manuscrito, rechazos, errores, cancelación |
| `tests/e2e/api.test.mjs` | Biblioteca, capítulos, revisiones y conflictos, memoria, aislamiento entre novelas, duplicar, borrar, construcción de contexto y cada proveedor |
| `tests/e2e/security.test.mjs` | Las 31 rutas sin sesión, cookies falsificadas, 503 sin contraseña, clave pública sin acceso a tablas, funciones ni al bucket, claves fuera del bundle, manuscrito fuera de los logs |
| `tests/unit/images.test.ts` | Formato y tamaño de imagen leídos de los bytes (JPEG, PNG, WebP, AVIF), rutas y URLs versionadas |
| `tests/e2e/assets-reuse.test.mjs` | Archivos repetidos (antes de subir y al terminar, sólo dentro de la novela) y reemplazar: sólo esta imagen o todos los usos, conservando pie, etiqueta, orden y principal, sin tocar otros usos |
| `tests/e2e/assets.test.mjs` | Archivos: subida firmada de un solo uso, original conservado, derivados, caché versionada, galería (principal única, orden, límite), archivos compartidos sin duplicar, borrado seguro, aislamiento entre novelas, limpieza, duplicar novela, nada llega a la IA |
| `tests/e2e/gallery-ui.test.mjs` | Galería en el navegador: tarjetas con iniciales sin imagen, subir con selector y arrastrando, imagen principal, visor con pie y etapa, ordenar, eliminar, Escape, límite de 40, sólo miniaturas y versiones reducidas, móvil |
| `tests/unit/manuscript.test.ts` | Formato del marcador (línea propia, dentro de un párrafo, repetidos), recuento de palabras, sustitución y restauración en el asistente, resolución de impresión |
| `tests/e2e/manuscript.test.mjs` | Imágenes del manuscrito: insertar, editar, mover, quitar y recuperar, sin colocar, borrar capítulo, reutilización y archivo compartido con galerías, reemplazar, borrado seguro, orientación EXIF, asistente, duplicar novela reescribiendo marcadores, aislamiento |
| `tests/e2e/manuscript-ui.test.mjs` | Insertar con botón, pegar y arrastrar; tarjeta; escribir sobre la imagen; quitar y recuperar; vista de lectura; desde una galería; reemplazo compartido; protección en el asistente; móvil |
| `tests/e2e/ui.test.mjs` | Flujo completo en el navegador: autoguardado, memoria, guía, capítulos, retomar posición, Desarrollar escena e insertar con deshacer, Original/Propuesta, cambio de proveedor, conflicto, concentración, móvil, capítulo de 1 MB |

Requisitos de la E2E:

- **PostgreSQL**: `initdb`, `pg_ctl` y `psql`. Si no se encuentran solos, define `PG_BIN`.
- **PostgREST**: se descarga una vez en Linux x64. En otros sistemas, define `POSTGREST_BIN`.
- **Chromium**: si falta, `npx playwright install chromium`.

Opciones: `E2E_SKIP_BUILD=1` reutiliza el build; `E2E_ONLY=reading` ejecuta sólo los archivos cuyo nombre lo contiene; `E2E_KEEP=1` deja el entorno en marcha para inspeccionarlo.

## Privacidad y seguridad

- **Claves**: sólo en el servidor. Los módulos que las usan importan `server-only`, y no hay variables `NEXT_PUBLIC_`.
- **Base de datos**:
  - RLS activado sin políticas, y permisos de tablas y funciones revocados a `anon` y `authenticated`.
  - Las claves foráneas compuestas `(id, novel_id)` hacen que la base de datos rechace mezclar novelas, por ejemplo una relación entre personajes de dos novelas.
- **Acceso**:
  - `APP_PASSWORD` se valida en el proxy y otra vez dentro de cada ruta API (`handler()` en `lib/auth.ts`).
  - Sesión `HttpOnly` y `SameSite=Strict`, firmada con HMAC y con caducidad de 30 días. Un login fallido tarda 1 s.
- **Logs**: sólo mensajes de error. Nunca el manuscrito ni los cuerpos de las peticiones.
- **Proveedores**: el texto se envía al proveedor elegido sin transformaciones. Si uno rechaza, se informa y puedes probar otro.

## Estructura

```
src/
  app/
    page.tsx                         biblioteca
    novela/[id]/page.tsx             espacio de escritura
    api/novels                       GET biblioteca · POST nueva
    api/novels/[id]                  GET (novela, capítulos, memoria) · PATCH · DELETE
    api/novels/[id]/duplicate        POST
    api/novels/[id]/chapters         POST nuevo · PUT orden
    api/novels/[id]/memory/[kind]    POST personaje | relación | lugar | hecho
    api/chapters/[id]                GET · PATCH (texto con revisión, o título) · DELETE
    api/memory/[kind]/[id]           PATCH · DELETE
    api/assist                       IA: editar o escribir escena (streaming NDJSON; dryRun = tamaño)
  components/
    Library, Workspace, ChapterEditor, ChapterNav, NovelModal, MemoryModal, AssistantPanel, useAutosave
  lib/
    guide.ts            Guía Maestra → instrucciones maestras
    ai/context.ts       selección de contexto y memoria
    ai/prompts.ts       instrucciones de los dos modos y tareas
    ai/providers.ts     interfaz común: Claude (SDK oficial), GPT (SDK oficial, Responses API), Grok (REST)
    auth.ts, supabase.ts, memory.ts, client.ts, http.ts, types.ts
  proxy.ts
supabase/schema.sql
```

## Fuera del alcance

Un solo usuario. Sin RAG, embeddings ni base vectorial. Sin colaboración, publicación, exportación editorial, historial de versiones ni extracción automática de memoria.
