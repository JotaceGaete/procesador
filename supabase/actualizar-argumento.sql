-- Argumento general (docs/consejero.md, «Argumento general · Fase 2»).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Añade la columna novels.plot: la trama completa, los secretos y el desenlace previsto que
-- escribe el autor. Solo la lee el Consejero; el Asistente nunca la recibe.
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes: cada
-- novela queda con el Argumento general vacío. Con un valor por defecto constante, PostgreSQL
-- añade la columna sin reescribir la tabla (instantáneo). No cambia funciones, políticas ni
-- permisos: la tabla ya tiene RLS y solo la service_role del servidor accede a ella. El código
-- anterior no la usa, así que se puede aplicar antes de desplegar.
--
-- Deshacer (borra lo que se haya escrito en el Argumento general):
--   alter table public.novels drop column if exists plot;

alter table public.novels add column if not exists plot text not null default '';

-- Comprobación: debe devolver una fila (plot | text | NO | ''::text).
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'novels' and column_name = 'plot';
