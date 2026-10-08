# Privacidad: bloqueo de Procesador y novelas protegidas

> Estado: **Fases 0 y 1 implementadas** (sesiones con identidad, bloqueo de Procesador por inactividad,
> novelas protegidas). Requiere actualizar Supabase, en este orden:
> [`supabase/actualizar-sesiones.sql`](../supabase/actualizar-sesiones.sql) y
> [`supabase/actualizar-protegidas.sql`](../supabase/actualizar-protegidas.sql) (o `supabase/schema.sql` completo),
> y definir `NOVEL_LOCK_PEPPER` en el servidor. Tras desplegar, hay que volver a entrar una vez.
> El cifrado del contenido no forma parte de estas fases.

## Problema

Procesador abierto en un computador, sin nadie delante, es un manuscrito abierto: la sesión duraba
30 días y cerrar sesión sólo borraba la cookie del navegador (una copia seguía valiendo). Y algunas
novelas no deberían abrirse aunque Procesador esté abierto.

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

## Novelas protegidas

Una novela puede marcarse como protegida en *Novela → Protección*, con su propio **PIN** (6 a 12
dígitos) o **contraseña** (8 caracteres o más).

| | |
|---|---|
| Al abrirla | Pide el PIN, también entrando directamente por su URL |
| Bloquear ahora | *Bloquear novela* en la lista de capítulos |
| Inactividad | 15 minutos por defecto; 5, 15, 30 o 60. Como mucho 8 horas seguidas |
| Se vuelve a bloquear | Al bloquear Procesador, al cerrar sesión, al cambiar el PIN (en las demás sesiones) |
| Al cambiar de pestaña o de app | Sólo si se activa *Bloquear al cambiar de pestaña o de app* (desactivado por defecto, también en el móvil) |
| Título | Visible por defecto; *Ocultar el título en la biblioteca* muestra sólo «Novela protegida» (también en su pantalla de bloqueo) |
| Cambiar o quitar | Con el PIN actual |
| «Olvidé el PIN» | Con la contraseña de Procesador (`APP_PASSWORD`): quitar la protección o elegir otro PIN. En multiusuario, la reautenticación de la cuenta |
| Eliminar la novela | Desbloqueada, y con el PIN |

### La credencial

- Nunca se guarda: sólo `scrypt(HMAC-SHA256(NOVEL_LOCK_PEPPER, PIN), sal)` (N=2¹⁷, r=8, p=1,
  sal de 16 bytes), en `novel_protection`, una tabla aparte de `novels`. Se compara en tiempo constante.
- El *pepper* es un secreto del servidor: una copia de la base de datos sola no permite probar
  PINs (un PIN de 6 dígitos es un millón de combinaciones). Sin él, en producción, proteger
  responde 503.
- Nunca en `localStorage`, en la URL ni en los logs: sólo en el cuerpo de un `POST`. El campo
  no invita al navegador a guardarlo (`autocomplete="off"`).
- Intentos: los mismos de §Intentos, con el contador `novel:<id>`.

### Desbloqueo

Desbloquear es una fila en `novel_unlocks` (sesión, novela) con su última actividad y su
`credential_version`. Bloquear es borrarla: revocación real, no un modal. `novel_access` (la
función que usa `authorizeNovel`) comprueba en cada petición la fila, la versión del PIN, la
inactividad (+2 minutos de margen) y las 8 horas. Bloquear Procesador o cerrar sesión borra las
filas de esa sesión (trigger `app_sessions_forget_unlocks`).

### Qué queda cerrado mientras está bloqueada

Toda ruta que la nombra a ella o a cualquiera de sus elementos responde `423 {code: "novel_locked"}`
antes de ejecutarse, con sólo lo que su pantalla de bloqueo muestra (id, título salvo si está oculto,
tipo de credencial):

- capítulos, versiones, papelera, cronología;
- Memoria (personajes, relaciones, lugares, hechos) y galerías;
- **imágenes**: las de una novela protegida se sirven con `Cache-Control: private, no-store`
  (nunca quedan en la caché del navegador), y bloquear responde con `Clear-Site-Data: "cache"`;
  el enlace firmado a un original dura 60 s;
- **IA**: Asistente, Consejero, lectura y resúmenes (ninguna llamada al proveedor);
- **copia de seguridad** y exportación (el archivo ya descargado no queda protegido: se avisa);
- **duplicar**: la copia nace protegida con el mismo PIN, en la misma transacción, y bloqueada;
- la biblioteca la lista sin capítulos ni palabras (ni título, si está oculto).

Sólo responden `unlock`, `lock` y `protection/recover` de esa novela.

### En el navegador (`NovelGate`)

La pantalla de bloqueo sustituye al espacio de escritura, que se desmonta (texto, Memoria,
propuestas, historial de deshacer). Antes de bloquear se guarda el capítulo y se cancelan las
peticiones. El ping de actividad lleva la novela abierta. Las demás pestañas se bloquean también.
En el móvil, el PIN abre el teclado numérico.

**localStorage**: de una novela protegida no se guarda nada escrito por el autor. El argumento de
escena y la conversación abierta del Consejero no se leen ni se escriben (`readPref`/`writePref`
los ignoran), y lo que hubiera de antes se borra al abrir la biblioteca o la novela. Sólo quedan
preferencias sin contenido (posición del cursor, paneles, proveedor).

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

[`supabase/actualizar-protegidas.sql`](../supabase/actualizar-protegidas.sql) (requiere la anterior):

| Objeto | Para qué |
|---|---|
| `novel_protection` | Hash, tipo, `credential_version`, inactividad, ocultar título, bloquear al salir |
| `novel_unlocks` | Una novela desbloqueada en una sesión |
| `app_sessions_forget_unlocks` | Bloquear Procesador o cerrar sesión bloquea sus novelas |
| `novel_access` | La comprobación de cada petición |
| `novel_unlock`, `novel_protect`, `novel_unprotect` | Desbloquear, proteger o cambiar el PIN, quitar |
| `library(uuid)` | La biblioteca por sesión (`library()` se conserva) |
| `duplicate_novel_with_protection` | Duplicar sin que exista una copia sin proteger (`duplicate_novel()` se conserva) |

Las tablas nuevas, como las demás: RLS sin políticas, cerradas a `anon` y `authenticated`. Ambas
migraciones son aditivas e idempotentes y no tocan datos existentes; el código anterior sigue
funcionando con la base ya actualizada.

## Multiusuario, más adelante

| Hoy | Con Supabase Auth |
|---|---|
| `app_sessions.user_id` vacío | El usuario; el id de sesión, el `session_id` del JWT |
| `app_settings`, una fila | Una fila por usuario |
| Desbloquear con `APP_PASSWORD` | Reautenticación de la cuenta |
| Contador `app` | `app:<usuario>` |
| `authorizeNovel` comprueba el bloqueo | Primero la propiedad (404 si no es suya), después el bloqueo |
| «Olvidé el PIN» con `APP_PASSWORD` | Reautenticación de la cuenta |
| `novel_protection` por novela | Si se comparten novelas, por (novela, usuario) |
| El bloqueo lo aplica la app (`service_role`) | También RLS: `novel_unlocks` con el `session_id` del JWT |

## Límites

- Quien tenga acceso al panel de Supabase o de Vercel (la `service_role`) lee todo: el bloqueo es de la app.
- Una copia de seguridad o una exportación descargada no queda protegida. Las copias de seguridad de Supabase tampoco.
- Mientras la novela está desbloqueada: el portapapeles, capturas o extensiones del navegador.
- Si el navegador guardó el PIN, quien encuentre el computador lo autocompleta.
- Lo enviado a un proveedor de IA queda sujeto a su política.
