# Procesador

Herramienta personal para escribir ficción con asistencia de IA. Es un editor sin distracciones con fichas de personajes que sirven de memoria narrativa, y un análisis bajo demanda del fragmento que selecciones.

**Stack:** Next.js 16 (App Router + API Routes) · Supabase (Postgres) · Claude API, con Grok como alternativa opcional · Vercel.

## Uso

- **Editor**: texto plano, con autoguardado un segundo después de dejar de escribir.
  - Estado siempre visible: *Sin guardar*, *Guardando…*, *Guardado* o *No se pudo guardar*. Si falla, reintenta solo.
  - Si el texto cambió en otra pestaña o dispositivo, no lo pisa. Te deja elegir entre *Cargar esa versión* y *Conservar la mía*.
- **Atajos**:
  - `Ctrl/⌘ + S`: guardar ahora.
  - `Ctrl/⌘ + .`: entrar o salir del modo concentración (`Esc` también sale).
  - `Ctrl/⌘ + Z`: deshace también un reemplazo hecho desde el análisis.
- **Personajes** (botón *Personajes*, hasta 10): nombre, apodos, rol, trasfondo, personalidad, voz, motivaciones, relaciones, arco narrativo y notas.
- **Proyecto** (clic en el título): sinopsis y notas de estilo, que acompañan a cada análisis. También desde ahí se cierra la sesión.
- **Análisis** (panel derecho; en móvil, hoja inferior): selecciona un fragmento y elige *Redacción*, *Consistencia*, *Diálogo* o *Evolución*.
  - Cuando la IA propone una reescritura, ves **Original / Propuesta**. El texto sólo cambia si pulsas *Reemplazar selección*.
  - Si un proveedor no responde a una solicitud, se indica en una línea y, si el otro está configurado, aparece *Probar con Grok* (o *con Claude*).

## Qué se envía a la IA

Por defecto, cada análisis envía sólo lo necesario:

| Siempre | Instrucciones de editor, la selección, ~4.000 caracteres antes y ~1.500 después, sinopsis y notas de estilo |
|---|---|
| Fichas | Las del personaje elegido y las de los personajes nombrados (por nombre o apodo) cerca de la selección |
| Consistencia / Evolución | Además, hasta ~12.000 caracteres de pasajes de todo el manuscrito donde aparece el personaje, repartidos de principio a fin y con su posición (≈35 % del manuscrito, por ejemplo) |
| Manuscrito completo | Sólo si marcas la casilla. La casilla muestra cuántos tokens añade por consulta |

En una novela de ~1 millón de caracteres, una verificación de consistencia por defecto usa unos 5.000 tokens de contexto, frente a unos 300.000 con el manuscrito completo. Cuando lo incluyes, el manuscrito va en un bloque cacheado: varias consultas seguidas sin editar el texto se cobran a tarifa de caché.

No se usan embeddings ni RAG. La búsqueda de pasajes es por nombre y apodos, así que conviene rellenar *También llamado*.

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En **SQL Editor**, ejecuta [`supabase/schema.sql`](supabase/schema.sql). Es idempotente: si ya ejecutaste una versión anterior, vuelve a ejecutarlo para migrar.
3. En **Project Settings → API** copia la *Project URL* y la clave **service_role / secret**.

### 2. Variables de entorno

```bash
cp .env.example .env.local
```

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SUPABASE_URL` | sí | URL del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | Clave secreta; sólo la usa el servidor |
| `APP_PASSWORD` | en producción | Contraseña de acceso. Si falta en producción, la app responde 503 |
| `ANTHROPIC_API_KEY` | al menos un proveedor | [console.anthropic.com](https://console.anthropic.com) |
| `ANTHROPIC_MODEL` | no | Por defecto `claude-opus-5-5` |
| `ANTHROPIC_EFFORT` | no | `low` · `medium` (por defecto) · `high` · `xhigh` · `max` |
| `XAI_API_KEY` | al menos un proveedor | Activa Grok |
| `XAI_MODEL` | no | Por defecto `grok-4`; comprueba el nombre vigente en la consola de xAI |
| `AI_PROVIDER` | no | Proveedor inicial: `anthropic` o `xai` (luego se recuerda tu elección) |

### 3. Local

```bash
npm install
npm run dev        # http://localhost:3000 (sin APP_PASSWORD, en local no pide contraseña)
npm run typecheck
npm run build
```

### 4. Vercel

Importa el repositorio, añade las variables (incluida `APP_PASSWORD`) y despliega. `/api/analyze` declara `maxDuration = 300` s; si tu plan permite menos, se aplica el límite del plan.

## Privacidad y seguridad

- **Claves**: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` y `XAI_API_KEY` sólo se leen en el servidor (los módulos que las usan importan `server-only`). Ninguna lleva el prefijo `NEXT_PUBLIC_`.
- **Base de datos**: RLS activado sin políticas y permisos revocados a `anon`/`authenticated`. Con la clave pública de Supabase no se puede leer ni escribir nada.
- **Acceso**:
  - `APP_PASSWORD` se valida en el servidor, en dos lugares: el proxy de Next.js y cada ruta API.
  - La sesión es una cookie `HttpOnly`, `SameSite=Strict` y `Secure` en producción, firmada con HMAC y válida 30 días. Cambiar la contraseña invalida todas las sesiones.
  - Cada intento fallido de login tarda 1 s.
  - Sin `APP_PASSWORD`, la app queda cerrada en producción.
- **Logs**: los errores se registran sólo con su mensaje. Ni el manuscrito ni los cuerpos de las peticiones se escriben en logs.
- **Proveedores**: el texto que analizas se envía a Anthropic o a xAI según el modelo elegido. No se modifica ni se oculta para esquivar sus políticas. Si un proveedor rechaza una solicitud, la app lo dice.

## Estructura

```
src/
  app/
    page.tsx, login/page.tsx
    api/project/        GET proyecto + personajes · PATCH texto (con revisión) o metadatos
    api/characters/     POST (máx. 10) · [id]: PATCH, DELETE
    api/analyze/        análisis en streaming (NDJSON: text | refusal | truncated | error)
    api/login, api/logout
  components/
    Workspace.tsx       editor, barra superior, atajos
    useAutosave.ts      autoguardado con revisiones y reintentos
    AnalysisPanel.tsx   acciones, Original/Propuesta, aviso de rechazo
    CharactersModal.tsx lista + ficha
  lib/
    ai/context.ts       contexto cercano, fichas relevantes, pasajes del personaje
    ai/prompts.ts       instrucciones y tareas
    ai/providers.ts     interfaz común para Claude (SDK oficial) y Grok (REST de xAI)
    auth.ts, supabase.ts, client.ts, http.ts, types.ts
  proxy.ts              protección por contraseña
supabase/schema.sql
```

## Fuera del alcance

Un solo proyecto y un solo usuario. Sin capítulos ni formato enriquecido, sin historial ni versiones, sin colaboración ni publicación.
