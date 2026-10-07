# Privacidad: bloqueo de Procesador

> Estado: **Fase 0 implementada** (sesiones con identidad y bloqueo de Procesador por inactividad).
> Requiere actualizar Supabase: ejecutar [`supabase/actualizar-sesiones.sql`](../supabase/actualizar-sesiones.sql)
> (o `supabase/schema.sql` completo). Tras desplegar, hay que volver a entrar una vez.

## Problema

Procesador abierto en un computador, sin nadie delante, es un manuscrito abierto: la sesión duraba
30 días y cerrar sesión sólo borraba la cookie del navegador (una copia seguía valiendo).

## Principios

1. **El servidor decide.** El bloqueo no es un modal: con Procesador bloqueado, cada ruta del API
   responde `423` y no lee ni escribe nada. Entrar directamente a una URL no lo salta.
2. **Una sola arquitectura para dos cerraduras.** El bloqueo de Procesador y el de una novela
   protegida (Fase 1) comparten la sesión, la actividad, la pantalla de bloqueo y las pruebas.
3. **Bloquear no pierde texto.** Antes de bloquear se guarda lo que está abierto.
4. **Preparado para multiusuario** sin rehacer nada (ver más abajo).

## Sesiones

- Entrar crea una fila en `app_sessions`. La cookie (`HttpOnly`, `SameSite=Strict`) lleva
  `<id de sesión>.<caducidad>.<firma HMAC con APP_PASSWORD>`. Cambiar `APP_PASSWORD` sigue
  invalidando todas las sesiones.
- El proxy sólo comprueba la firma. Cada ruta del API comprueba además la fila: cerrada → `401`;
  Procesador bloqueado → `423 {code: "app_locked"}`.
- **Cerrar sesión revoca la fila**: una copia de la cookie deja de valer.
- Sin `APP_PASSWORD` (sólo en desarrollo) hay una única sesión fija y Procesador no se bloquea
  (no habría con qué desbloquearlo).

## Bloqueo de Procesador

| | |
|---|---|
| Inactividad | 15 minutos por defecto; 15, 30, 60, 120 o 240 en *Biblioteca → Privacidad* (`app_settings`) |
| Bloquear ahora | *Bloquear* en la Biblioteca y en la barra del espacio de escritura, o `Ctrl/⌘+Shift+L` |
| Desbloquear | La contraseña de Procesador (`APP_PASSWORD`) |
| Mientras está bloqueado | Sólo responden `GET /api/session`, `POST /api/session/unlock` y `/api/logout` |

### Actividad

- Toda petición autorizada cuenta como actividad (como mucho una escritura cada 30 s).
- El navegador envía `POST /api/session/ping` como mucho una vez por minuto, y sólo tras una
  entrada real (teclado, puntero, rueda, scroll o toque): leer sin escribir no bloquea.
- `GET /api/session` informa del estado sin contar como actividad.
- El servidor bloquea al pasar el plazo **más 2 minutos de margen**; el navegador, con su propio
  reloj, avisa un minuto antes («Seguir») y bloquea al llegar al plazo, de modo que siempre
  alcanza a guardar.
- Al volver a una pestaña (o al volver el móvil del selector de apps) y al volver con *Atrás*
  (bfcache), el navegador pregunta de nuevo al servidor.

### Al bloquear (`LockProvider`)

1. Se guarda el capítulo abierto (`useLockGuard`), con un límite de 3 s.
2. Se cancelan las peticiones en curso, incluidas las de la IA.
3. `POST /api/session/lock` (responde con `Clear-Site-Data: "cache"`, que borra las imágenes privadas guardadas por el navegador).
4. Se desmonta todo lo abierto: texto, Memoria, propuestas e historial de deshacer salen de la memoria.
5. Las demás pestañas de la misma sesión se bloquean también (`BroadcastChannel`).

Desbloquear vuelve a montar la página, que carga de nuevo desde el servidor.

### Intentos

`credential_attempts` cuenta los fallos de `APP_PASSWORD` (entrar y desbloquear comparten el
contador `app`): a partir del quinto, una espera de 30 s que se duplica hasta 15 minutos. Un
acierto la borra. Las páginas (`/`, `/novela/…`) y las respuestas del API van con `Cache-Control: no-store`.

## Autorización en el servidor: una sola puerta

Todas las rutas del API pasan por `src/lib/access.ts`:

- `handler()` — rutas que no tocan datos de una novela (biblioteca, ajustes, la sesión).
- `novelHandler(resolver, …)` — **toda** ruta que lee o cambia algo de una novela. El resolver
  encuentra la novela por el id de la ruta (`byParam`), por la fila del elemento nombrado
  (`byChild("chapters")`, `byChild("assets")`…, leída antes que nada) o por el cuerpo (`byBody`), y
  `authorizeNovel` decide antes de que la ruta se ejecute.

Lo garantizan dos pruebas:

- `tests/unit/routes.test.ts` falla si algún método de algún `route.ts` no usa el envoltorio que le
  corresponde, o si falta en `tests/e2e/routes.mjs`.
- `tests/e2e/privacy.test.mjs` y `security.test.mjs` recorren esa lista entera: sin sesión (401),
  sesión inexistente o revocada (401) y Procesador bloqueado (423, sin ningún cambio en la base).

## Supabase

[`supabase/actualizar-sesiones.sql`](../supabase/actualizar-sesiones.sql) (también incluido en `schema.sql`):

| Objeto | Para qué |
|---|---|
| `app_settings` | Una fila: `app_idle_minutes` (15 por defecto) |
| `app_sessions` | Una fila por sesión: caducidad, última actividad, `app_locked_at`, `revoked_at`, `user_id` (vacío hasta multiusuario) |
| `credential_attempts` | Fallos por credencial y espera |
| `session_touch` | Comprueba y anota actividad; bloquea pasado el plazo |
| `session_set_locked`, `session_revoke` | Bloquear, desbloquear, cerrar sesión |
| `credential_failure`, `credential_success` | Contador de intentos |
| `purge_sessions` | Limpieza al entrar |

Las tres tablas, como las demás: RLS sin políticas, cerradas a `anon` y `authenticated`. Es aditiva
e idempotente: no toca datos existentes.

## Multiusuario, más adelante

| Hoy | Con Supabase Auth |
|---|---|
| `app_sessions.user_id` vacío | El usuario; el id de sesión, el `session_id` del JWT |
| `app_settings`, una fila | Una fila por usuario |
| Desbloquear con `APP_PASSWORD` | Reautenticación de la cuenta |
| Contador `app` | `app:<usuario>` |
| `authorizeNovel` comprueba el bloqueo | Primero la propiedad (404 si no es suya), después el bloqueo |

## Límites

- Quien tenga acceso al panel de Supabase o de Vercel (la `service_role`) lee todo: el bloqueo es de la app.
- Una copia de seguridad o una exportación descargada no queda protegida.
- Lo enviado a un proveedor de IA queda sujeto a su política.
