-- Huella de los datos (sólo lectura): por cada tabla de la app, cuántas filas tiene y un md5 de
-- todas ellas. Sirve para comprobar un respaldo (la huella de la copia restaurada debe ser igual
-- a la de la base) y una actualización (igual antes y después). Procedimiento completo:
-- docs/integracion-bloqueo-reserva.md.
--
-- Se dejan fuera las columnas que añade la migración conjunta de bloqueo y reserva (locked,
-- locked_at, reserved) y, de chapters, el título y updated_at, que la migración cambia a
-- propósito sólo cuando quita el «Capítulo N» guardado. El título tiene su propia línea,
-- «chapters.title», que cambia sólo si había títulos con ese número (titulos-antes.csv).
--
-- No modifica nada: se puede ejecutar en el SQL Editor cuantas veces haga falta.
with cols as (
  select c.table_name, string_agg(quote_ident(c.column_name), ',' order by c.ordinal_position) as list
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    and c.column_name not in ('locked', 'locked_at', 'reserved')
    and not (c.table_name = 'chapters' and c.column_name in ('title', 'updated_at'))
  group by c.table_name
), parts as (
  select table_name as what,
         format('select count(*) || '' filas · '' || coalesce(md5(string_agg(r::text, ''|'' order by r::text)), ''-'') as h from (select %s from public.%I) r',
                list, table_name) as q
  from cols
  union all
  select 'chapters.title', 'select count(*) || '' filas · '' || coalesce(md5(string_agg(id || '':'' || title, ''|'' order by id)), ''-'') as h from public.chapters'
)
select what as tabla, (xpath('/row/h/text()', query_to_xml(q, false, true, '')))[1]::text as huella
from parts
order by what;
