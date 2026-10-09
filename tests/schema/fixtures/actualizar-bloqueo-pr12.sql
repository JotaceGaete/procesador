-- Bloqueo de capítulos (docs/bloqueo-capitulos.md).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Añade a chapters el candado (locked, locked_at), el trigger que hace que la base rechace
-- cualquier cambio de texto o título de un capítulo bloqueado, la comprobación en la papelera
-- (trash_chapter) y el candado en el índice de capítulos (novel_outline). Requiere una base al
-- día con el Crítico (supabase/actualizar-critico.sql o schema.sql).
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica el texto de ningún
-- capítulo: todos quedan desbloqueados. El código anterior sigue funcionando con la base
-- actualizada (nadie bloquea nada), así que se puede aplicar antes de desplegar; el código
-- nuevo necesita esta actualización. Todo en una transacción: si algo falla, no se aplica nada.
--
-- Deshacer (los capítulos bloqueados vuelven a ser editables):
--   drop trigger if exists chapters_guard_locked on public.chapters;
--   drop function if exists public.chapter_guard_locked();
--   alter table public.chapters drop column if exists locked, drop column if exists locked_at;
--   y volver a ejecutar novel_outline y trash_chapter de la versión anterior de schema.sql.

begin;

alter table public.chapters add column if not exists locked boolean not null default false;
alter table public.chapters add column if not exists locked_at timestamptz;

create or replace function public.chapter_guard_locked() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.locked and (new.content is distinct from old.content or new.title is distinct from old.title) then
    raise exception 'Este capítulo está bloqueado. Desbloquéalo para modificarlo.' using errcode = 'P0423';
  end if;
  return new;
end $$;

drop trigger if exists chapters_guard_locked on public.chapters;
create trigger chapters_guard_locked before update on public.chapters
  for each row execute function public.chapter_guard_locked();

drop function if exists public.novel_outline(uuid);
create function public.novel_outline(p_novel uuid)
returns table (id uuid, title text, "position" integer, chars integer, words integer, updated_at timestamptz, locked boolean)
language sql stable set search_path = '' as $$
  select c.id, c.title, c.position, length(c.content), public.word_count(c.content), c.updated_at, c.locked
  from public.chapters c
  where c.novel_id = p_novel
  order by c.position, c.created_at
$$;

create or replace function public.trash_chapter(p_chapter uuid)
returns void language plpgsql set search_path = '' as $$
declare v_novel uuid;
begin
  select novel_id into v_novel from public.chapters where id = p_chapter;
  if v_novel is null then
    raise exception 'Capítulo no encontrado' using errcode = 'P0002';
  end if;
  if (select locked from public.chapters where id = p_chapter) then
    raise exception 'Este capítulo está bloqueado. Desbloquéalo para eliminarlo.' using errcode = 'P0423';
  end if;
  -- Dos eliminaciones simultáneas no pueden dejar la novela sin capítulos.
  perform 1 from public.novels where id = v_novel for update;
  if (select count(*) from public.chapters where novel_id = v_novel) <= 1 then
    raise exception 'Una novela necesita al menos un capítulo.' using errcode = '22023';
  end if;
  perform public.save_chapter_version(p_chapter, 'delete');
  delete from public.chapters where id = p_chapter;
end $$;

revoke execute on function public.chapter_guard_locked() from public, anon, authenticated;
revoke execute on function public.novel_outline(uuid) from public, anon, authenticated;
revoke execute on function public.trash_chapter(uuid) from public, anon, authenticated;
grant execute on function public.novel_outline(uuid), public.trash_chapter(uuid) to service_role;

commit;

-- Que la API de Supabase vea las columnas y la función nuevas de inmediato.
notify pgrst, 'reload schema';
