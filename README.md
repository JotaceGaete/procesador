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
  - **Memoria visual de Personajes**: tarjetas con la imagen principal (o las iniciales), y en la ficha la imagen principal y una *Galería* de referencias. Se suben con el selector o arrastrando, y se ven ampliadas con su pie y su etapa. Subir, eliminar, elegir la principal y ordenar se guardan al momento. Se conserva el original; la app sólo carga miniaturas y versiones reducidas. Las imágenes no se envían al asistente.
- **Asistente** (panel derecho; en móvil, hoja inferior). Tiene dos modos:
  - *Editar selección*: Redacción, Diálogo, Expandir, Acortar, Consistencia, Personaje, Evolución. Es conservador: preserva hechos, intención, voz y regionalismos. Las propuestas se muestran como **Original / Propuesta**.
  - *Escribir escena*: escribes el argumento y pulsas **Desarrollar escena**. Puedes marcar quién está en escena, el lugar y la extensión. Tu argumento es la autoridad sobre lo que ocurre; la IA sólo decide cómo contarlo. La escena se puede **insertar en el cursor**.
  - Nada se escribe en el manuscrito sin tu clic. Cada propuesta ofrece *Otra versión*, *Copiar*, *Descartar* y *Probar con* otro proveedor. Reemplazar e insertar se deshacen con `Ctrl/⌘+Z`.
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
   - En **SQL Editor**, ejecuta [`supabase/schema.sql`](supabase/schema.sql). Es idempotente y elimina las tablas de la etapa anterior si existen. También crea el bucket privado `novel-files` de Storage.
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

3. **Local**: `npm install`, `npm run dev`, `npm run typecheck`, `npm run build`.
4. **Vercel**: importa el repositorio y añade las variables. `/api/assist` declara `maxDuration = 300` s.

## Pruebas

```bash
npm run typecheck
npm test            # unitarias (~1 s): contexto, prompts, Guía Maestra, sesiones, los tres proveedores
npm run test:e2e    # de punta a punta (~2–3 min): API, seguridad e interfaz en Chromium
npm run test:all    # ambas
```

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
| `tests/e2e/security.test.mjs` | Las 24 rutas sin sesión, cookies falsificadas, 503 sin contraseña, clave pública sin acceso a tablas, funciones ni al bucket, claves fuera del bundle, manuscrito fuera de los logs |
| `tests/unit/images.test.ts` | Formato y tamaño de imagen leídos de los bytes (JPEG, PNG, WebP, AVIF), rutas y URLs versionadas |
| `tests/e2e/assets.test.mjs` | Archivos: subida firmada de un solo uso, original conservado, derivados, caché versionada, galería (principal única, orden, límite), archivos compartidos sin duplicar, borrado seguro, aislamiento entre novelas, limpieza, duplicar novela, nada llega a la IA |
| `tests/e2e/gallery-ui.test.mjs` | Galería en el navegador: tarjetas con iniciales sin imagen, subir con selector y arrastrando, imagen principal, visor con pie y etapa, ordenar, eliminar, Escape, límite de 40, sólo miniaturas y versiones reducidas, móvil |
| `tests/e2e/ui.test.mjs` | Flujo completo en el navegador: autoguardado, memoria, guía, capítulos, retomar posición, Desarrollar escena e insertar con deshacer, Original/Propuesta, cambio de proveedor, conflicto, concentración, móvil, capítulo de 1 MB |

Requisitos de la E2E:

- **PostgreSQL**: `initdb`, `pg_ctl` y `psql`. Si no se encuentran solos, define `PG_BIN`.
- **PostgREST**: se descarga una vez en Linux x64. En otros sistemas, define `POSTGREST_BIN`.
- **Chromium**: si falta, `npx playwright install chromium`.

Opciones: `E2E_SKIP_BUILD=1` reutiliza el build; `E2E_KEEP=1` deja el entorno en marcha para inspeccionarlo.

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
