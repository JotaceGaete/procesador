-- Capítulos en reserva y reorganización del manuscrito (docs/capitulos-reserva.md).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Añade chapters.reserved (todos los capítulos existentes quedan en el manuscrito, con sus
-- ids, su texto y su orden) y chapter_versions.reserved; las funciones create_chapter y
-- move_chapter; y actualiza novel_outline, reorder_chapters, save_chapter_version,
-- trash_chapter, restore_chapter y duplicate_novel para que distingan los dos grupos.
--
-- Único cambio en los datos, sólo la primera vez: se quita del título el número que la app
-- guardaba al crear un capítulo («Capítulo 3» → vacío, y se muestra «Capítulo N» según su
-- lugar; «Capítulo 3: La manta» → «La manta»). Los títulos anteriores siguen en las versiones.
--
-- Requiere una base al día con el Crítico Literario (supabase/actualizar-critico.sql o
-- schema.sql). Idempotente: se puede ejecutar varias veces. Todo en una transacción: si algo
-- falla, no se aplica nada. El código anterior sigue funcionando con la base nueva, así que se
-- aplica ANTES de desplegar el código nuevo. Comprobar después con supabase/verificar.sql.
--
-- Deshacer (sólo si no hay capítulos en reserva; los títulos no se restauran):
--   alter table public.chapters drop column reserved;  -- y volver a ejecutar el schema.sql anterior

begin;
-- Capítulos en reserva (docs/capitulos-reserva.md): escritos para más adelante, fuera del
-- manuscrito. No se numeran, no se exportan y la IA no los lee salvo el que el autor tenga
-- abierto. position ordena dentro de cada grupo; el número visible es el orden del manuscrito
-- y no forma parte del título. La primera vez se quita del título el número que la app
-- guardaba al crear el capítulo («Capítulo 3» → vacío; «Capítulo 3: La manta» → «La manta»):
-- el título anterior sigue en las versiones del capítulo.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'chapters' and column_name = 'reserved') then
    alter table public.chapters add column reserved boolean not null default false;
    update public.chapters
    set title = btrim(regexp_replace(title, '^\s*[cC][aA][pP][iIíÍ][tT][uU][lL][oO]\s+[0-9]+\s*([:.,–—-]\s*)?', ''))
    where title ~ '^\s*[cC][aA][pP][iIíÍ][tT][uU][lL][oO]\s+[0-9]+\s*([:.,–—-]|$)';
  end if;
end $$;
create index if not exists chapters_novel_group_idx on public.chapters(novel_id, reserved, position);

-- El grupo del capítulo (docs/capitulos-reserva.md): recuperar de la papelera un capítulo en
-- reserva lo devuelve a la reserva, nunca al manuscrito.
alter table public.chapter_versions add column if not exists reserved boolean not null default false;

-- Índice de capítulos sin traer el texto: el manuscrito en orden y después la reserva.
-- (Se borra antes de crearla porque añadir `reserved` cambió lo que devuelve.)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'novel_outline' and pronamespace = 'public'::regnamespace
             and pg_get_function_result(oid) not like '%reserved%') then
    drop function public.novel_outline(uuid);
  end if;
end $$;
create or replace function public.novel_outline(p_novel uuid)
returns table (id uuid, title text, "position" integer, chars integer, words integer, updated_at timestamptz, reserved boolean)
language plpgsql stable set search_path = '' as $$
begin
  return query
  select c.id, c.title, c.position, length(c.content), public.word_count(c.content), c.updated_at, c.reserved
  from public.chapters c
  where c.novel_id = p_novel
  order by c.reserved, c.position, c.created_at;
end $$;

-- Reordena el manuscrito en una transacción. Exige la lista completa de sus capítulos (los de
-- la reserva no cambian).
create or replace function public.reorder_chapters(p_novel uuid, p_ids uuid[])
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from public.novels where id = p_novel for update;
  if (select count(*) from public.chapters where novel_id = p_novel and not reserved) <> cardinality(p_ids)
     or (select count(*) from public.chapters where novel_id = p_novel and not reserved and id = any(p_ids)) <> cardinality(p_ids)
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then
    raise exception 'La lista de capítulos no coincide con el manuscrito' using errcode = '22023';
  end if;
  update public.chapters c set position = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where c.id = o.id and c.novel_id = p_novel;
end $$;

-- Capítulos en reserva (docs/capitulos-reserva.md). Las dos funciones bloquean la fila de la
-- novela: dos pestañas que reordenan a la vez se aplican una tras otra, sin duplicar ni dejar
-- huecos. Sólo cambian `reserved` y `position`: texto, título, imágenes, versiones y notas no
-- se tocan. Cada grupo queda numerado 1…n.

-- Un capítulo nuevo en la posición p_at (1 = el primero; null o más allá del final = al final)
-- del manuscrito o de la reserva. Devuelve su id.
create or replace function public.create_chapter(p_novel uuid, p_title text, p_reserved boolean, p_at integer)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_n integer; v_at integer;
begin
  perform 1 from public.novels where id = p_novel for update;
  if not found then
    raise exception 'Novela no encontrada' using errcode = 'P0002';
  end if;
  select count(*) into v_n from public.chapters where novel_id = p_novel and reserved = p_reserved;
  v_at := least(greatest(coalesce(p_at, v_n + 1), 1), v_n + 1);
  update public.chapters c set position = case when o.ord >= v_at then o.ord + 1 else o.ord end
  from (select id, row_number() over (order by position, created_at) as ord
        from public.chapters where novel_id = p_novel and reserved = p_reserved) o
  where c.id = o.id and c.position is distinct from (case when o.ord >= v_at then o.ord + 1 else o.ord end);
  insert into public.chapters (id, novel_id, title, position, reserved)
  values (v_id, p_novel, left(btrim(coalesce(p_title, '')), 300), v_at, p_reserved);
  return v_id;
end $$;

-- Mueve un capítulo a la posición p_at de un grupo: dentro del suyo (reordenar, flechas,
-- arrastrar) o al otro (a la reserva, al manuscrito). El manuscrito conserva siempre un
-- capítulo. Al cambiar de grupo se invalida lo derivado (la lectura del Consejero):
--   · su ficha (salvo la corregida por el autor, que la app no lee mientras esté en reserva);
--   · al ir a la reserva, también la ficha del capítulo que le seguía (se hizo con su resumen),
--     el resumen global que lo incluía y los cabos posibles que ya sólo venían de la reserva;
--   · al volver al manuscrito, las referencias de su ficha a cabos que ya no existen.
-- La app recalcula después dónde abre y cierra cada cabo (recomputeThreads).
create or replace function public.move_chapter(p_chapter uuid, p_reserved boolean, p_at integer)
returns void language plpgsql set search_path = '' as $$
declare c record; v_ids uuid[]; v_at integer; v_next uuid;
begin
  select novel_id into c from public.chapters where id = p_chapter;
  if c.novel_id is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  perform 1 from public.novels where id = c.novel_id for update;
  -- Leído otra vez con la novela bloqueada: otra operación pudo moverlo o borrarlo.
  select id, novel_id, reserved into c from public.chapters where id = p_chapter;
  if c.id is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  if not c.reserved and p_reserved
     and (select count(*) from public.chapters where novel_id = c.novel_id and not reserved) <= 1 then
    raise exception 'El manuscrito necesita al menos un capítulo.' using errcode = '22023';
  end if;
  if not c.reserved and p_reserved then
    select id into v_next from public.chapters
    where novel_id = c.novel_id and not reserved
      and (position, created_at) > (select position, created_at from public.chapters where id = p_chapter)
    order by position, created_at limit 1;
  end if;

  select coalesce(array_agg(id order by position, created_at), '{}') into v_ids
  from public.chapters where novel_id = c.novel_id and reserved = p_reserved and id <> p_chapter;
  v_at := least(greatest(coalesce(p_at, cardinality(v_ids) + 1), 1), cardinality(v_ids) + 1);
  v_ids := v_ids[1:v_at - 1] || p_chapter || v_ids[v_at:cardinality(v_ids)];
  update public.chapters ch set position = o.ord, reserved = p_reserved
  from unnest(v_ids) with ordinality as o(id, ord)
  where ch.id = o.id and (ch.position is distinct from o.ord::integer or ch.reserved is distinct from p_reserved);
  if c.reserved = p_reserved then
    return;
  end if;

  -- El grupo que dejó, numerado otra vez.
  update public.chapters ch set position = o.ord
  from (select id, row_number() over (order by position, created_at) as ord
        from public.chapters where novel_id = c.novel_id and reserved = c.reserved) o
  where ch.id = o.id and ch.position is distinct from o.ord::integer;

  delete from public.chapter_digests where chapter_id = p_chapter and not author_edited;
  if p_reserved then
    delete from public.chapter_digests where chapter_id = v_next and not author_edited;
    delete from public.novel_digests where novel_id = c.novel_id and based_on ? p_chapter::text;
    delete from public.story_threads t
    where t.novel_id = c.novel_id and t.origin = 'advisor' and not t.confirmed
      and not exists (select 1 from public.chapter_digests d join public.chapters ch on ch.id = d.chapter_id
                      where d.novel_id = c.novel_id and not ch.reserved
                        and d.threads @> jsonb_build_array(jsonb_build_object('thread', t.id::text)));
  else
    update public.chapter_digests d
    set threads = coalesce((select jsonb_agg(x) from jsonb_array_elements(d.threads) x
                            where exists (select 1 from public.story_threads t
                                          where t.novel_id = c.novel_id and t.id::text = x ->> 'thread')), '[]'::jsonb)
    where d.chapter_id = p_chapter;
  end if;
end $$;

-- Guarda una versión de un capítulo: el texto indicado o, sin él, el guardado. Un texto vacío
-- no se guarda. No repite la última versión si es idéntica (salvo las del autor y la de la
-- papelera). Conserva las 100 versiones automáticas más recientes de cada capítulo; las
-- guardadas por el autor y las de la papelera no se podan. Devuelve el id (o null).
create or replace function public.save_chapter_version(p_chapter uuid, p_reason text, p_label text default '',
                                                       p_content text default null)
returns uuid language plpgsql set search_path = '' as $$
declare c record; v_content text; v_last record; v_id uuid;
begin
  select id, novel_id, title, position, content, reserved into c from public.chapters where id = p_chapter;
  if c.id is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  v_content := coalesce(p_content, c.content);
  if btrim(v_content) = '' then
    return null;
  end if;
  select id, content into v_last from public.chapter_versions
  where chapter_id = p_chapter order by created_at desc, id desc limit 1;
  if p_reason not in ('manual', 'delete') and v_last.id is not null and v_last.content = v_content then
    return v_last.id;
  end if;
  insert into public.chapter_versions (novel_id, chapter_id, source_chapter_id, title, position, content, words, reason, label,
                                       reserved)
  values (c.novel_id, c.id, c.id, c.title, c.position, v_content, public.word_count(v_content), p_reason,
          left(btrim(coalesce(p_label, '')), 200), c.reserved)
  returning id into v_id;
  delete from public.chapter_versions where id in (
    select id from public.chapter_versions
    where chapter_id = p_chapter and reason not in ('manual', 'delete')
    order by created_at desc, id desc offset 100);
  return v_id;
end $$;

-- Eliminar un capítulo: su texto pasa a la papelera (una versión 'delete') y el capítulo se
-- borra, en una transacción. Sus versiones quedan en la papelera (chapter_id null). El
-- manuscrito conserva siempre al menos un capítulo (los de la reserva no cuentan).
create or replace function public.trash_chapter(p_chapter uuid)
returns void language plpgsql set search_path = '' as $$
declare v_novel uuid;
begin
  select novel_id into v_novel from public.chapters where id = p_chapter;
  if v_novel is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  -- Dos eliminaciones simultáneas no pueden dejar el manuscrito sin capítulos.
  perform 1 from public.novels where id = v_novel for update;
  if not (select reserved from public.chapters where id = p_chapter)
     and (select count(*) from public.chapters where novel_id = v_novel and not reserved) <= 1 then
    raise exception 'Una novela necesita al menos un capítulo en el manuscrito.' using errcode = '22023';
  end if;
  perform public.save_chapter_version(p_chapter, 'delete');
  delete from public.chapters where id = p_chapter;
end $$;

-- Recuperar un capítulo de la papelera: vuelve al final de su grupo (el manuscrito o la
-- reserva, docs/capitulos-reserva.md) con el título y el texto de su última versión, y con
-- todo su historial. Devuelve el id del capítulo.
create or replace function public.restore_chapter(p_novel uuid, p_source uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v record; v_id uuid := gen_random_uuid();
begin
  perform 1 from public.novels where id = p_novel for update;
  select title, content, reserved into v from public.chapter_versions
  where novel_id = p_novel and source_chapter_id = p_source and chapter_id is null
  order by created_at desc, id desc limit 1;
  if v.content is null then
    raise exception 'Ese capítulo ya no está en la papelera' using errcode = 'P0002';
  end if;
  insert into public.chapters (id, novel_id, title, position, content, reserved)
  values (v_id, p_novel, v.title,
          coalesce((select max(position) from public.chapters where novel_id = p_novel and reserved = v.reserved), 0) + 1,
          v.content, v.reserved);
  update public.chapter_versions set chapter_id = v_id, source_chapter_id = v_id
  where novel_id = p_novel and source_chapter_id = p_source and chapter_id is null;
  return v_id;
end $$;

-- Copia completa de una novela (capítulos y memoria) con ids nuevos, en una transacción.
-- Devuelve el id nuevo y los pares de rutas (origen, destino) que el servidor copia en Storage.
drop function if exists public.duplicate_novel(uuid, text);
create or replace function public.duplicate_novel(p_novel uuid, p_title text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_new uuid := gen_random_uuid();
  m_chap jsonb; m_char jsonb; m_place jsonb; m_fact jsonb; m_asset jsonb; m_mimg jsonb; m_thread jsonb; r record;
  v_ids jsonb; v_text text; r2 record;
  v_copies jsonb;
begin
  insert into public.novels (id, title, synopsis, notes, guide, auto_digest, calendar, book)
  select v_new, p_title, synopsis, notes, guide, auto_digest, calendar, book from public.novels where id = p_novel;
  if not found then return null; end if;

  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_chap from public.chapters where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_char from public.characters where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_place from public.places where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_fact from public.facts where novel_id = p_novel;

  insert into public.chapters (id, novel_id, title, position, content, reserved)
  select (m_chap ->> id::text)::uuid, v_new, title, position, content, reserved from public.chapters where novel_id = p_novel;

  insert into public.characters (id, novel_id, name, aliases, age, role, description, background, personality,
    motivations, fears, contradictions, "values", voice, vocabulary, secrets, knows, unaware, arc, notes,
    age_anchor, age_approx, death)
  select (m_char ->> id::text)::uuid, v_new, name, aliases, age, role, description, background, personality,
    motivations, fears, contradictions, "values", voice, vocabulary, secrets, knows, unaware, arc, notes,
    -- Un ancla "edad en un capítulo" apunta al capítulo de la copia.
    case when age_anchor #>> '{at,chapter_id}' is not null
         then jsonb_set(age_anchor, '{at,chapter_id}', to_jsonb(m_chap ->> (age_anchor #>> '{at,chapter_id}')))
         else age_anchor end,
    age_approx, death
  from public.characters where novel_id = p_novel;

  -- Cronología: las marcas, en los capítulos de la copia.
  insert into public.time_marks (novel_id, chapter_id, anchor, "when", flashback, label)
  select v_new, (m_chap ->> t.chapter_id::text)::uuid, t.anchor, t."when", t.flashback, t.label
  from public.time_marks t where t.novel_id = p_novel;

  insert into public.relationships (novel_id, from_id, to_id, kind, note)
  select v_new, (m_char ->> from_id::text)::uuid, (m_char ->> to_id::text)::uuid, kind, note
  from public.relationships where novel_id = p_novel;

  insert into public.places (id, novel_id, name, aliases, description, notes)
  select (m_place ->> id::text)::uuid, v_new, name, aliases, description, notes from public.places where novel_id = p_novel;

  insert into public.facts (id, novel_id, text, chapter_id, place_id, story_time, note, status)
  select (m_fact ->> id::text)::uuid, v_new, text, (m_chap ->> chapter_id::text)::uuid, (m_place ->> place_id::text)::uuid,
         story_time, note, status
  from public.facts where novel_id = p_novel;

  insert into public.fact_characters (fact_id, character_id, novel_id)
  select (m_fact ->> fc.fact_id::text)::uuid, (m_char ->> fc.character_id::text)::uuid, v_new
  from public.fact_characters fc where fc.novel_id = p_novel;

  -- Archivos: filas nuevas con rutas bajo la novela nueva. Los bytes los copia el servidor
  -- (pares devueltos en 'copies'); dentro de la novela, cada archivo se copia una sola vez
  -- aunque tenga varios usos. Las subidas sin terminar no se copian.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_asset
  from public.assets where novel_id = p_novel and status = 'ready';
  insert into public.assets (id, novel_id, status, version, file_name, original_path, original_type, original_bytes,
    width, height, orientation, sha256, display_path, thumb_path, derived_type)
  select (m_asset ->> a.id::text)::uuid, v_new, 'ready', a.version, a.file_name,
    regexp_replace(a.original_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    a.original_type, a.original_bytes, a.width, a.height, a.orientation, a.sha256,
    regexp_replace(a.display_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    regexp_replace(a.thumb_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    a.derived_type
  from public.assets a where a.novel_id = p_novel and a.status = 'ready';
  -- La portada del libro, si es un archivo de la novela, es el archivo de la copia.
  update public.novels set book = jsonb_set(book, '{coverAssetId}', coalesce(m_asset -> (book ->> 'coverAssetId'), 'null'::jsonb))
  where id = v_new and book ? 'coverAssetId';

  -- Usos: el trigger de inserción no debe reordenar ni elegir principal al copiar.
  perform set_config('procesador.copying', 'on', true);
  insert into public.character_images (novel_id, character_id, asset_id, caption, stage_label, is_primary, sort_order)
  select v_new, (m_char ->> i.character_id::text)::uuid, (m_asset ->> i.asset_id::text)::uuid,
         i.caption, i.stage_label, i.is_primary, i.sort_order
  from public.character_images i where i.novel_id = p_novel;
  perform set_config('procesador.copying', 'off', true);

  -- Imágenes del manuscrito con ids nuevos, y sus marcadores reescritos en el texto copiado:
  -- cada capítulo de la copia apunta a sus propias imágenes, nunca a las de la original.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_mimg
  from public.manuscript_images where novel_id = p_novel;
  insert into public.manuscript_images (id, novel_id, asset_id, chapter_id, alt, decorative, caption, credit,
    layout, align, width_pct)
  select (m_mimg ->> m.id::text)::uuid, v_new, (m_asset ->> m.asset_id::text)::uuid,
    (m_chap ->> m.chapter_id::text)::uuid, m.alt, m.decorative, m.caption, m.credit, m.layout, m.align, m.width_pct
  from public.manuscript_images m where m.novel_id = p_novel;
  -- (copying: reescribir los marcadores no es una edición del autor, no deja versión)
  perform set_config('procesador.copying', 'on', true);
  for r in select key as old_id, value #>> '{}' as new_id from jsonb_each(m_mimg) loop
    update public.chapters
    set content = regexp_replace(content, '\[\[imagen:' || r.old_id || '\]\]', '[[imagen:' || r.new_id || ']]', 'gi')
    where novel_id = v_new and content ~* ('\[\[imagen:' || r.old_id || '\]\]');
  end loop;
  perform set_config('procesador.copying', 'off', true);

  -- Lectura del Consejero: fichas, cabos y resumen global se copian (son caros de rehacer)
  -- con sus ids reasignados. Una ficha al día de la original lo está en la copia (cuya
  -- revisión empieza en 0); una desactualizada sigue desactualizada (-1).
  -- El uso de la IA (ai_usage), las conversaciones y las observaciones no se copian: son el
  -- historial de esa novela.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_thread from public.story_threads where novel_id = p_novel;
  insert into public.story_threads (id, novel_id, title, description, kind, status, status_by, origin, confirmed,
    opened_chapter_id, last_chapter_id, closed_chapter_id)
  select (m_thread ->> t.id::text)::uuid, v_new, t.title, t.description, t.kind, t.status, t.status_by, t.origin, t.confirmed,
    (m_chap ->> t.opened_chapter_id::text)::uuid, (m_chap ->> t.last_chapter_id::text)::uuid,
    (m_chap ->> t.closed_chapter_id::text)::uuid
  from public.story_threads t where t.novel_id = p_novel;

  -- Los ids de personajes y cabos dentro de las fichas, reescritos como texto (son uuid únicos).
  v_ids := m_char || m_thread;
  for r in select d.*, c.revision as chapter_revision from public.chapter_digests d
           join public.chapters c on c.id = d.chapter_id where d.novel_id = p_novel loop
    v_text := jsonb_build_array(r.events, r.presence, r.revelations, r.threads)::text;
    for r2 in select key as old_id, value #>> '{}' as new_id from jsonb_each(v_ids) loop
      v_text := replace(v_text, r2.old_id, r2.new_id);
    end loop;
    insert into public.chapter_digests (chapter_id, novel_id, source_revision, text_sketch, summary, events,
      presence, revelations, threads, notes, author_edited, model)
    values ((m_chap ->> r.chapter_id::text)::uuid, v_new,
      case when r.source_revision = r.chapter_revision then 0 else -1 end, r.text_sketch, r.summary,
      v_text::jsonb -> 0, v_text::jsonb -> 1, v_text::jsonb -> 2, v_text::jsonb -> 3, r.notes, r.author_edited, r.model);
  end loop;

  insert into public.novel_digests (novel_id, summary, based_on, model)
  select v_new, nd.summary,
    coalesce((select jsonb_object_agg(m_chap ->> b.key,
                case when (b.value #>> '{}')::int = c.revision then 0 else -1 end)
              from jsonb_each(nd.based_on) b join public.chapters c on c.id = b.key::uuid
              where m_chap ? b.key), '{}'),
    nd.model
  from public.novel_digests nd where nd.novel_id = p_novel;

  select coalesce(jsonb_agg(jsonb_build_array(p.old_path, p.new_path)), '[]') into v_copies
  from public.assets oa
  join public.assets na on na.id = (m_asset ->> oa.id::text)::uuid
  cross join lateral (values (oa.original_path, na.original_path), (oa.display_path, na.display_path),
                             (oa.thumb_path, na.thumb_path)) as p(old_path, new_path)
  where oa.novel_id = p_novel and oa.status = 'ready';

  return jsonb_build_object('id', v_new, 'copies', v_copies);
end $$;

revoke execute on function public.novel_outline(uuid) from public, anon, authenticated;
revoke execute on function public.reorder_chapters(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.create_chapter(uuid, text, boolean, integer) from public, anon, authenticated;
revoke execute on function public.move_chapter(uuid, boolean, integer) from public, anon, authenticated;
revoke execute on function public.save_chapter_version(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.trash_chapter(uuid) from public, anon, authenticated;
revoke execute on function public.restore_chapter(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.duplicate_novel(uuid, text) from public, anon, authenticated;
grant execute on function public.novel_outline(uuid), public.reorder_chapters(uuid, uuid[]),
  public.create_chapter(uuid, text, boolean, integer), public.move_chapter(uuid, boolean, integer),
  public.save_chapter_version(uuid, text, text, text), public.trash_chapter(uuid), public.restore_chapter(uuid, uuid),
  public.duplicate_novel(uuid, text) to service_role;
commit;
