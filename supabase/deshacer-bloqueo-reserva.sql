-- Deshacer la migración conjunta de bloqueo y reserva (supabase/actualizar-bloqueo-reserva.sql)
-- y dejar la base como la del Crítico Literario (producción antes de esta actualización).
-- Procedimiento completo: docs/integracion-bloqueo-reserva.md, «Recuperación».
--
-- Sólo hace falta si hubiera que volver atrás la BASE. Para volver atrás sólo el código basta
-- con promover en Vercel el despliegue anterior: el código anterior funciona con la base nueva.
--
-- Qué hace, en una transacción:
--   · Los capítulos en reserva pasan al final del manuscrito, en su orden: nada se borra.
--   · Se quitan los candados: todos los capítulos vuelven a ser editables.
--   · Se borran create_chapter, move_chapter, el trigger chapters_guard_locked y su función,
--     y se reponen novel_outline, reorder_chapters, save_chapter_version, trash_chapter,
--     restore_chapter y duplicate_novel tal como estaban en producción.
--   · Se borran las columnas chapters.locked, locked_at, reserved, chapter_versions.reserved
--     y el índice por grupo.
-- Lo que NO hace: devolver a los títulos el «Capítulo N» que quitó la migración (están en el
-- respaldo previo, «titulos-antes.csv»; el código anterior muestra igual «Capítulo N»).
-- Es idempotente: sobre una base que ya está como la del Crítico no cambia nada.

begin;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'chapters' and column_name = 'reserved') then
    -- Los de la reserva, detrás del manuscrito de su novela, sin perder el orden de cada grupo.
    execute $q$
      update public.chapters ch set position = o.ord
      from (select id, row_number() over (partition by novel_id order by reserved, position, created_at) as ord
            from public.chapters) o
      where ch.id = o.id and ch.position is distinct from o.ord::integer
    $q$;
  end if;
end $$;

drop trigger if exists chapters_guard_locked on public.chapters;
drop function if exists public.chapter_guard_locked();
drop function if exists public.create_chapter(uuid, text, boolean, integer);
drop function if exists public.move_chapter(uuid, boolean, integer);
drop index if exists public.chapters_novel_group_idx;

-- novel_outline cambia lo que devuelve: se borra y se crea como estaba.
drop function if exists public.novel_outline(uuid);
create or replace function public.novel_outline(p_novel uuid)
returns table (id uuid, title text, "position" integer, chars integer, words integer, updated_at timestamptz)
language sql stable set search_path = '' as $$
  select c.id, c.title, c.position, length(c.content), public.word_count(c.content), c.updated_at
  from public.chapters c
  where c.novel_id = p_novel
  order by c.position, c.created_at
$$;

create or replace function public.reorder_chapters(p_novel uuid, p_ids uuid[])
returns void language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.chapters where novel_id = p_novel) <> cardinality(p_ids)
     or (select count(*) from public.chapters where novel_id = p_novel and id = any(p_ids)) <> cardinality(p_ids)
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then
    raise exception 'La lista de capítulos no coincide con la novela' using errcode = '22023';
  end if;
  update public.chapters c set position = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where c.id = o.id and c.novel_id = p_novel;
end $$;

create or replace function public.save_chapter_version(p_chapter uuid, p_reason text, p_label text default '',
                                                       p_content text default null)
returns uuid language plpgsql set search_path = '' as $$
declare c record; v_content text; v_last record; v_id uuid;
begin
  select id, novel_id, title, position, content into c from public.chapters where id = p_chapter;
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
  insert into public.chapter_versions (novel_id, chapter_id, source_chapter_id, title, position, content, words, reason, label)
  values (c.novel_id, c.id, c.id, c.title, c.position, v_content, public.word_count(v_content), p_reason,
          left(btrim(coalesce(p_label, '')), 200))
  returning id into v_id;
  delete from public.chapter_versions where id in (
    select id from public.chapter_versions
    where chapter_id = p_chapter and reason not in ('manual', 'delete')
    order by created_at desc, id desc offset 100);
  return v_id;
end $$;

create or replace function public.trash_chapter(p_chapter uuid)
returns void language plpgsql set search_path = '' as $$
declare v_novel uuid;
begin
  select novel_id into v_novel from public.chapters where id = p_chapter;
  if v_novel is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  -- Dos eliminaciones simultáneas no pueden dejar la novela sin capítulos.
  perform 1 from public.novels where id = v_novel for update;
  if (select count(*) from public.chapters where novel_id = v_novel) <= 1 then
    raise exception 'Una novela necesita al menos un capítulo.' using errcode = '22023';
  end if;
  perform public.save_chapter_version(p_chapter, 'delete');
  delete from public.chapters where id = p_chapter;
end $$;

create or replace function public.restore_chapter(p_novel uuid, p_source uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v record; v_id uuid := gen_random_uuid();
begin
  perform 1 from public.novels where id = p_novel for update;
  select title, content into v from public.chapter_versions
  where novel_id = p_novel and source_chapter_id = p_source and chapter_id is null
  order by created_at desc, id desc limit 1;
  if v.content is null then
    raise exception 'Ese capítulo ya no está en la papelera' using errcode = 'P0002';
  end if;
  insert into public.chapters (id, novel_id, title, position, content)
  values (v_id, p_novel, v.title,
          coalesce((select max(position) from public.chapters where novel_id = p_novel), 0) + 1, v.content);
  update public.chapter_versions set chapter_id = v_id, source_chapter_id = v_id
  where novel_id = p_novel and source_chapter_id = p_source and chapter_id is null;
  return v_id;
end $$;

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

  insert into public.chapters (id, novel_id, title, position, content)
  select (m_chap ->> id::text)::uuid, v_new, title, position, content from public.chapters where novel_id = p_novel;

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

alter table public.chapters drop column if exists locked, drop column if exists locked_at, drop column if exists reserved;
alter table public.chapter_versions drop column if exists reserved;

revoke execute on function public.novel_outline(uuid) from public, anon, authenticated;
revoke execute on function public.reorder_chapters(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.save_chapter_version(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.trash_chapter(uuid) from public, anon, authenticated;
revoke execute on function public.restore_chapter(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.duplicate_novel(uuid, text) from public, anon, authenticated;
grant execute on function public.novel_outline(uuid), public.reorder_chapters(uuid, uuid[]),
  public.save_chapter_version(uuid, text, text, text), public.trash_chapter(uuid), public.restore_chapter(uuid, uuid),
  public.duplicate_novel(uuid, text) to service_role;

commit;

notify pgrst, 'reload schema';
