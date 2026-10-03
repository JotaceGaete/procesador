# Procesador

Herramienta personal para escribir ficción con asistencia de IA: un editor sin distracciones, fichas de personajes y análisis contextual de cualquier fragmento (redacción, consistencia de personaje, diálogo y evolución).

**Stack:** Next.js 16 (App Router + API Routes) · Supabase (Postgres) · Claude API (Grok opcional) · Vercel.

## Funcionalidades

- **Editor**: texto plano con tipografía serif, autoguardado (1,2 s después de dejar de escribir; también `Ctrl/Cmd+S` y al cerrar la pestaña), contador de palabras y **modo concentración** (oculta los paneles; `Esc` para salir).
- **Personajes** (hasta 10): nombre, rol, trasfondo, voz, características, arco narrativo y notas.
- **Proyecto**: título, sinopsis y notas de estilo. La IA las recibe como contexto en cada análisis.
- **Análisis**: selecciona un fragmento y elige:
  - *Revisar redacción*: problemas concretos + versión reescrita.
  - *Verificar consistencia* con un personaje: voz, comportamiento, arco y continuidad, con veredicto.
  - *Mejorar diálogo* (opcionalmente centrado en un personaje): cambios + versión reescrita.
  - *Evolución del personaje*: posibles direcciones de desarrollo y semillas para plantar.

  Las respuestas llegan en streaming. Cuando hay versión reescrita, el botón **Reemplazar selección** la aplica en el editor.
- **Contexto**: cada análisis envía las fichas de todos los personajes, la sinopsis y, si está marcado *Incluir manuscrito completo*, todo el texto (con prompt caching, así los análisis repetidos sobre el mismo texto cuestan menos).

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En **SQL Editor**, pega y ejecuta [`supabase/schema.sql`](supabase/schema.sql).
3. En **Project Settings → API** copia la *Project URL* y la clave **service_role / secret**.

Las tablas tienen RLS activado sin políticas: solo el servidor (con la service_role key) puede leerlas o escribirlas. La clave nunca llega al navegador.

### 2. Variables de entorno

```bash
cp .env.example .env.local
```

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SUPABASE_URL` | sí | URL del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | Clave secreta (solo servidor) |
| `ANTHROPIC_API_KEY` | sí* | De [console.anthropic.com](https://console.anthropic.com) |
| `ANTHROPIC_MODEL` | no | Por defecto `claude-opus-5-5` |
| `ANTHROPIC_EFFORT` | no | `low` · `medium` (por defecto) · `high` · `xhigh` · `max` |
| `XAI_API_KEY` | no* | Activa Grok como segundo proveedor |
| `XAI_MODEL` | no | Por defecto `grok-4` |
| `AI_PROVIDER` | no | Proveedor por defecto: `anthropic` o `xai` |
| `APP_PASSWORD` | en producción | Contraseña de acceso. Sin ella la app queda abierta |

\* Hace falta al menos un proveedor. Con los dos configurados aparece un selector de modelo en el panel de análisis.

### 3. Local

```bash
npm install
npm run dev     # http://localhost:3000
```

### 4. Deploy en Vercel

1. Importa el repositorio en Vercel (framework: Next.js, sin configuración extra).
2. Añade las variables de entorno de arriba, **incluida `APP_PASSWORD`**.
3. Deploy.

La ruta `/api/analyze` declara `maxDuration = 300` s para análisis largos con el manuscrito completo. Si tu plan de Vercel tiene un límite menor, se aplica ese límite.

## Sobre la "censura"

La app llama a la API directamente con un system prompt de editor literario que pide explícitamente no moralizar, no suavizar a los personajes ni añadir advertencias. Con esto, la API es mucho más permisiva que las apps de chat para ficción adulta (violencia, sexualidad, personajes moralmente repugnantes). Sigue teniendo políticas de uso, así que puede rechazar algunas peticiones extremas. En ese caso:

- La petición se reintenta automáticamente con un modelo de respaldo (parámetro `fallbacks: "default"` de la API).
- Si aun así se rechaza, el panel lo indica y puedes reformular o cambiar a Grok con el selector de modelo.

## Estructura

```
src/
  app/
    page.tsx                  → Workspace (editor + paneles)
    login/page.tsx
    api/project/              → GET proyecto+personajes, PATCH texto/metadatos
    api/characters/           → POST (máx. 10), PATCH/DELETE por id
    api/analyze/              → streaming de análisis
    api/login, api/logout
  components/                 → Workspace, AnalysisPanel, CharacterSidebar, modales
  lib/
    ai/prompts.ts             → system prompt y prompts de cada acción
    ai/providers.ts           → Claude (SDK oficial) y Grok (REST de xAI)
    supabase.ts, auth.ts, types.ts
  proxy.ts                    → protección por contraseña
supabase/schema.sql
```

## Límites del MVP

Un proyecto activo, hasta 10 personajes, texto plano (sin capítulos ni formato) y sin historial ni versiones.
