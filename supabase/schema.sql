-- Esquema para el procesador de ficción.
-- Ejecutar una vez en Supabase → SQL Editor.

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

create index if not exists characters_project_id_idx on public.characters(project_id);

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists characters_updated_at on public.characters;
create trigger characters_updated_at before update on public.characters
  for each row execute function public.set_updated_at();

-- RLS activado y sin políticas: las claves anon/publishable no pueden leer nada.
-- La app accede solo desde el servidor con la service_role key.
alter table public.projects   enable row level security;
alter table public.characters enable row level security;
