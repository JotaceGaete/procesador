-- Papelera de novelas (docs/papelera-novelas.md).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Eliminar una novela deja de borrarla: la marca con novels.deleted_at. La biblioteca no la muestra,
-- y el servidor la borra de verdad (con sus archivos) cuando lleva 30 días en la papelera.
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes: las novelas
-- actuales quedan con deleted_at vacío, es decir, fuera de la papelera.
-- El código anterior no usa la columna, así que se puede aplicar antes de desplegar.

alter table public.novels add column if not exists deleted_at timestamptz;

-- La biblioteca no muestra las novelas en la papelera (misma firma que antes).
create or replace function public.library()
returns table (id uuid, title text, updated_at timestamptz, chapters integer, words integer)
language sql stable set search_path = '' as $$
  select n.id, n.title, n.updated_at,
         count(c.id)::integer,
         coalesce(sum(public.word_count(c.content)), 0)::integer
  from public.novels n
  left join public.chapters c on c.novel_id = n.id
  where n.deleted_at is null
  group by n.id
  order by n.updated_at desc
$$;

create or replace function public.trash_novel(p_novel uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.novels set deleted_at = now() where id = p_novel and deleted_at is null;
  if not found then
    raise exception 'Novela no encontrada' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.restore_novel(p_novel uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.novels set deleted_at = null where id = p_novel and deleted_at is not null;
  if not found then
    raise exception 'Esa novela ya no está en la papelera' using errcode = 'P0002';
  end if;
end $$;

-- La papelera: las novelas eliminadas, la más reciente primero.
create or replace function public.novel_trash()
returns table (id uuid, title text, deleted_at timestamptz, chapters integer, words integer)
language sql stable set search_path = '' as $$
  select n.id, n.title, n.deleted_at,
         count(c.id)::integer,
         coalesce(sum(public.word_count(c.content)), 0)::integer
  from public.novels n
  left join public.chapters c on c.novel_id = n.id
  where n.deleted_at is not null
  group by n.id
  order by n.deleted_at desc
$$;

revoke execute on function public.trash_novel(uuid) from public, anon, authenticated;
revoke execute on function public.restore_novel(uuid) from public, anon, authenticated;
revoke execute on function public.novel_trash() from public, anon, authenticated;
grant execute on function public.trash_novel(uuid), public.restore_novel(uuid),
  public.novel_trash() to service_role;
