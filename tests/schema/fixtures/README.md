Versiones publicadas de `supabase/schema.sql`, tal como pudieron quedar aplicadas en una base
real. `tests/schema/run.mjs` las usa como punto de partida para comprobar que el esquema
actual actualiza cualquier base existente sin errores y sin tocar sus datos.

- `schema-2b.sql`: imágenes del manuscrito (commit 4cf55c9), antes del Consejero.
- `schema-fase1.sql`: Consejero fase 1 (commit 6ea212f): sólo `ai_usage`.
- `schema-fase4.sql`: Consejero fases 2 a 4 (commit 6aa0b58), con los bucles de triggers y RLS
  al final del archivo que fallaban si se ejecutaba sólo una parte.
- `schema-critico.sql`: Crítico Literario, fase 1 (commit 5359c10), la base de producción antes
  del bloqueo de capítulos.
- `actualizar-bloqueo-pr12.sql` y `actualizar-reserva-pr13.sql`: las migraciones por separado de
  los PR #12 y #13, sustituidas por `supabase/actualizar-bloqueo-reserva.sql`. Sirven para
  comprobar que la conjunta también funciona si alguien ya aplicó una de ellas.
