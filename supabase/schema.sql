-- Esquema para el procesador de ficción.
-- Ejecutar en Supabase → SQL Editor. Es idempotente: se puede volver a ejecutar.

create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Proyecto sin título',
  synopsis    text not null default '',
  style_notes text not null default '',
  content     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- MVP: un único proyecto. La restricción impide que dos cargas simultáneas creen dos.
alter table public.projects add column if not exists singleton boolean not null default true;
do $$ begin
  alter table public.projects add constraint projects_singleton check (singleton);
  alter table public.projects add constraint projects_singleton_key unique (singleton);
exception when duplicate_object or duplicate_table then null;
end $$;

-- Se incrementa cada vez que cambia el texto. El cliente envía la revisión que conoce
-- y el servidor rechaza el guardado si el texto cambió en otra pestaña o dispositivo.
alter table public.projects add column if not exists revision integer not null default 0;

create table if not exists public.characters (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  role        text not null default '',
  background  text not null default '',
  voice       text not null default '',
  traits      text not null default '',
  arc         text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.characters add column if not exists aliases       text not null default '';
alter table public.characters add column if not exists motivations   text not null default '';
alter table public.characters add column if not exists relationships text not null default '';

create index if not exists characters_project_id_idx on public.characters(project_id);

create or replace function public.touch_row() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  if tg_table_name = 'projects' then
    -- Nested: on `characters` the record has no `content` field.
    if new.content is distinct from old.content then
      new.revision = old.revision + 1;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at before update on public.projects
  for each row execute function public.touch_row();

drop trigger if exists characters_updated_at on public.characters;
create trigger characters_updated_at before update on public.characters
  for each row execute function public.touch_row();

drop function if exists public.set_updated_at();

-- Privacidad: RLS activado y sin políticas, y sin permisos para los roles públicos.
-- Con la clave anon/publishable no se puede leer ni escribir nada.
-- La app accede solo desde el servidor con la service_role key (que ignora RLS).
alter table public.projects   enable row level security;
alter table public.characters enable row level security;
revoke all on public.projects   from anon, authenticated;
revoke all on public.characters from anon, authenticated;
revoke execute on function public.touch_row() from anon, authenticated, public;
