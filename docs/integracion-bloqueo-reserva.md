# Bloqueo de capítulos + capítulos en reserva: integración y despliegue

Pedido por Juan el 2026-10-09. Une el bloqueo de capítulos (PR #12, docs/bloqueo-capitulos.md)
y los capítulos en reserva (PR #13, docs/capitulos-reserva.md) en una sola rama y **una sola
migración**, `supabase/actualizar-bloqueo-reserva.sql`, que sustituye a las dos anteriores.

## Cómo conviven

- Un capítulo puede estar bloqueado y en reserva a la vez. `novel_outline` devuelve `locked` y
  `reserved`; la lista lateral muestra 🔒 en los dos grupos.
- El candado protege **texto y título**, en el manuscrito y en la reserva: la base (trigger
  `chapters_guard_locked`, SQLSTATE P0423) y el servidor (423) lo rechazan, y tampoco se puede
  enviar a la papelera. **No** protege su lugar: las flechas, arrastrar y «Mover» (a la reserva,
  al manuscrito, a cualquier posición) funcionan con un capítulo bloqueado, porque
  `move_chapter` sólo cambia `position` y `reserved`. Mover no crea versiones ni cambia la
  revisión.
- Un capítulo bloqueado no ofrece *Renombrar* ni *Eliminar* en ninguno de los dos grupos.
- Recuperar de la papelera devuelve el capítulo a su grupo, desbloqueado (para eliminarlo hubo
  que desbloquearlo). Duplicar la novela conserva el grupo y la copia nace desbloqueada.
- La migración quita el «Capítulo N» guardado en los títulos, **salvo** en un capítulo que ya
  estuviera bloqueado (sólo posible si alguien aplicó antes la migración del PR #12): el
  candado protege su título. Se ve igual, porque `chapterLabel` ignora un título «Capítulo N».

## El Consejero

- **Reserva:** la IA lee el manuscrito y, sólo si el capítulo abierto está en reserva, ese
  capítulo; nunca otro. Esa lectura no escribe memoria (fichas, cabos, resumen global). Las
  conversaciones sobre un capítulo en reserva no continúan desde el manuscrito.
- **Bloqueo:** no cambia lo que la IA lee. Un capítulo bloqueado del manuscrito se lee como
  cualquier otro (contexto, fichas, Crítico, comparación); uno bloqueado en reserva, sólo si
  es el abierto. La IA puede preparar propuestas sobre un capítulo bloqueado; aplicarlas es
  lo que se rechaza.
- Pruebas: `tests/e2e/reserva.test.mjs` (aislamiento, con palabras únicas en la reserva) y
  `tests/e2e/integracion.test.mjs` (combinaciones).

## Lo que cambió al integrar

- `supabase/schema.sql`: columnas `locked`/`locked_at` antes del paso que quita números de los
  títulos; `novel_outline` con las dos columnas (se borra y recrea si le falta alguna);
  `trash_chapter` rechaza bloqueados y cuenta sólo el manuscrito.
- `supabase/actualizar-bloqueo-reserva.sql`: la migración conjunta (generada de schema.sql; una
  prueba comprueba que sus funciones son idénticas). Se niega a correr sobre una base anterior
  al Crítico. `actualizar-bloqueo.sql` y `actualizar-reserva.sql` se retiraron (quedan como
  fixtures de prueba): ejecutar una de ellas después de la conjunta rompería `novel_outline`.
- `supabase/deshacer-bloqueo-reserva.sql`: vuelve la base a la del Crítico sin perder capítulos.
- `supabase/huella.sql`: huella de los datos, de sólo lectura, para comprobar respaldo y migración.
- `scripts/ensayo-migracion.mjs`: ensayo sobre una copia local del respaldo real.
- Lista lateral, índice, mensajes de propuesta en otro capítulo y diálogo de desbloqueo: usan la
  etiqueta de reserva («Capítulo en reserva: …») cuando corresponde.
- Editor de texto: Ctrl/⌘+I y las inserciones dejan la selección puesta en el acto (antes sólo
  en el siguiente fotograma). Con carga, una segunda pulsación rápida veía el cursor colapsado y
  añadía `**` en vez de quitar la cursiva: era el fallo intermitente de `format.test.mjs`, que
  ya estaba en `main`.

## La base de producción real

La huella de producción (2026-10-09) muestra, además de las tablas del Crítico, las de
Privacidad (`app_settings`, `app_sessions`, `credential_attempts`, `novel_protection`,
`novel_unlocks`): sus migraciones (`actualizar-sesiones.sql`, `actualizar-protegidas.sql`, rama
`claude/loving-noether-9syx48`, sin integrar en `main`) están aplicadas. La migración conjunta no
toca nada de Privacidad; `duplicate_novel_with_protection` llama a `duplicate_novel` en tiempo
de ejecución, así que sigue funcionando. Hay una prueba de esquema sobre esa base exacta
(Crítico + Privacidad), con la migración, su recuperación y las funciones de Privacidad.

## Despliegue

Nada de esto se hace sin autorización expresa de Juan. Todo cabe en los planes gratuitos:
SQL Editor de Supabase, `pg_dump` con la cadena de conexión del proyecto, PostgreSQL en el
propio ordenador para el ensayo y el *rollback* de Vercel al despliegue anterior. No hace falta
*branching*, PITR ni ningún complemento de pago.

1. **Versión del esquema.** SQL Editor → `supabase/verificar.sql`. Debe listar sólo lo de
   bloqueo y reserva (`chapters.locked`, `chapters.reserved`, `move_chapter`… y «versión
   anterior al bloqueo / a los capítulos en reserva»). Cualquier otra línea: parar.
2. **Respaldo.**
   - SQL Editor → `supabase/huella.sql`; descargar el resultado como `huella-antes.csv`.
   - SQL Editor → `select id, novel_id, position, title from public.chapters order by novel_id, position;`
     → descargar como `titulos-antes.csv`.
   - En el ordenador, con el cliente de PostgreSQL 17 (la versión de Supabase) y la cadena de
     conexión de *Project Settings → Database* (Session pooler):
     `pg_dump "postgresql://…:5432/postgres" -Fc -n public --no-owner --no-privileges -f procesador-antes.dump`
3. **Comprobar el respaldo y ensayar.** `node scripts/ensayo-migracion.mjs procesador-antes.dump`.
   La huella que imprime debe ser idéntica a `huella-antes.csv` (así el respaldo está completo)
   y debe terminar en «Ensayo correcto». Lista qué títulos perderán el «Capítulo N».
   Entre la huella de antes y la de después, no uses Procesador (escribir o consultar a la IA
   cambia `chapters`, `ai_usage` y otras tablas, y la huella dejaría de coincidir).
4. **Migración.** SQL Editor → pegar `supabase/actualizar-bloqueo-reserva.sql` entero → Run.
   Una sola transacción: si algo falla, no se aplica nada.
5. **Comprobar.** `verificar.sql` → vacío. `huella.sql` → igual a `huella-antes.csv` salvo,
   quizá, la línea `chapters.title`. Abrir la app (todavía el código anterior): abre, guarda,
   reordena. Ese código está probado contra la base migrada (batería E2E completa de `main`).
6. **Código.** Merge del PR de integración a `main` (no los PR #12 ni #13, que se cierran);
   Vercel despliega solo.
7. **Prueba en producción.** Bloquear y desbloquear; mover un capítulo bloqueado a la reserva y
   de vuelta; abrir uno en reserva y consultar al Consejero; en el iPhone, «Mover» sin zoom.

No volver a ejecutar el `schema.sql` antiguo (de `main`) después de la migración: falla en
`novel_outline` (en el SQL Editor se deshace entero, sin daño). El `schema.sql` nuevo sí.

## Recuperación

- **Falla el código nuevo:** Vercel → Deployments → el despliegue de producción anterior →
  *Instant Rollback*. La base se queda como está: el código anterior funciona con ella.
- **Hay que volver atrás la base:** primero el código (punto anterior, porque el código nuevo
  necesita la base nueva), después SQL Editor → `supabase/deshacer-bloqueo-reserva.sql`. Los
  capítulos en reserva pasan al final del manuscrito y los candados desaparecen; ningún texto
  se pierde. Los títulos con «Capítulo N» no vuelven solos: están en `titulos-antes.csv`.
- **Último recurso:** restaurar `procesador-antes.dump` (`pg_restore --clean`). Se pierde lo
  escrito después del respaldo, así que sólo si lo anterior no basta.
