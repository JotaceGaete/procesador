-- Esquema del procesador de novelas.
-- Ejecutar en Supabase → SQL Editor. Es idempotente: se puede volver a ejecutar.
--
-- Aislamiento entre novelas: cada tabla de memoria lleva novel_id y las referencias
-- entre tablas usan claves foráneas compuestas (id, novel_id). La base de datos
-- rechaza, por ejemplo, una relación entre personajes de novelas distintas.

-- ---------------------------------------------------------------------------
-- Migración desde la etapa anterior (proyecto único). Sólo se ejecuta si
-- encuentra las tablas viejas; no contenían datos que conservar.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'characters' and column_name = 'project_id') then
    drop table public.characters;
  end if;
  drop table if exists public.projects;
  drop function if exists public.set_updated_at();
end $$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.novels (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default 'Novela sin título',
  synopsis   text not null default '',
  notes      text not null default '',
  -- Guía Maestra: campos opcionales (género, narrador, tono…). Ver src/lib/guide.ts.
  guide      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chapters (
  id         uuid primary key default gen_random_uuid(),
  novel_id   uuid not null references public.novels(id) on delete cascade,
  title      text not null default '',
  position   integer not null default 0,
  content    text not null default '',
  -- Sube cada vez que cambia el texto. Un guardado basado en una revisión vieja se rechaza.
  revision   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, novel_id)
);
create index if not exists chapters_novel_position_idx on public.chapters(novel_id, position);

create table if not exists public.characters (
  id             uuid primary key default gen_random_uuid(),
  novel_id       uuid not null references public.novels(id) on delete cascade,
  name           text not null,
  aliases        text not null default '',
  age            text not null default '',
  role           text not null default '',
  description    text not null default '',
  background     text not null default '',
  personality    text not null default '',
  motivations    text not null default '',
  fears          text not null default '',
  contradictions text not null default '',
  "values"       text not null default '',
  voice          text not null default '',
  vocabulary     text not null default '',
  secrets        text not null default '',
  knows          text not null default '',
  unaware        text not null default '',
  arc            text not null default '',
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, novel_id)
);
create index if not exists characters_novel_idx on public.characters(novel_id);

create table if not exists public.relationships (
  id         uuid primary key default gen_random_uuid(),
  novel_id   uuid not null references public.novels(id) on delete cascade,
  from_id    uuid not null,
  to_id      uuid not null,
  kind       text not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (from_id, novel_id) references public.characters(id, novel_id) on delete cascade,
  foreign key (to_id, novel_id) references public.characters(id, novel_id) on delete cascade,
  check (from_id <> to_id)
);
create index if not exists relationships_novel_idx on public.relationships(novel_id);

create table if not exists public.places (
  id          uuid primary key default gen_random_uuid(),
  novel_id    uuid not null references public.novels(id) on delete cascade,
  name        text not null,
  aliases     text not null default '',
  description text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, novel_id)
);
create index if not exists places_novel_idx on public.places(novel_id);

create table if not exists public.facts (
  id         uuid primary key default gen_random_uuid(),
  novel_id   uuid not null references public.novels(id) on delete cascade,
  text       text not null,
  chapter_id uuid,
  place_id   uuid,
  story_time text not null default '',
  note       text not null default '',
  -- 'suggested' queda reservado para hechos que la IA proponga en el futuro:
  -- sólo los 'approved' (aprobados por el autor) se usan como memoria.
  status     text not null default 'approved' check (status in ('approved', 'suggested')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, novel_id),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (chapter_id),
  foreign key (place_id, novel_id) references public.places(id, novel_id) on delete set null (place_id)
);
create index if not exists facts_novel_idx on public.facts(novel_id);

create table if not exists public.fact_characters (
  fact_id      uuid not null,
  character_id uuid not null,
  novel_id     uuid not null,
  primary key (fact_id, character_id),
  foreign key (fact_id, novel_id) references public.facts(id, novel_id) on delete cascade,
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.touch_chapter() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  if new.content is distinct from old.content then
    new.revision = old.revision + 1;
    -- La biblioteca ordena por última edición.
    update public.novels set updated_at = now() where id = new.novel_id;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['novels', 'characters', 'relationships', 'places', 'facts'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_row()', t, t);
  end loop;
end $$;

drop trigger if exists chapters_touch on public.chapters;
create trigger chapters_touch before update on public.chapters
  for each row execute function public.touch_chapter();

-- ---------------------------------------------------------------------------
-- Funciones usadas por el servidor
-- ---------------------------------------------------------------------------
create or replace function public.word_count(t text) returns integer
language sql immutable set search_path = '' as $$
  select case when btrim(t) = '' then 0
              else coalesce(array_length(regexp_split_to_array(btrim(t), '\s+'), 1), 0) end
$$;

-- Biblioteca: novelas con número de capítulos y palabras.
create or replace function public.library()
returns table (id uuid, title text, updated_at timestamptz, chapters integer, words integer)
language sql stable set search_path = '' as $$
  select n.id, n.title, n.updated_at,
         count(c.id)::integer,
         coalesce(sum(public.word_count(c.content)), 0)::integer
  from public.novels n
  left join public.chapters c on c.novel_id = n.id
  group by n.id
  order by n.updated_at desc
$$;

-- Índice de capítulos sin traer el texto.
create or replace function public.novel_outline(p_novel uuid)
returns table (id uuid, title text, "position" integer, chars integer, words integer, updated_at timestamptz)
language sql stable set search_path = '' as $$
  select c.id, c.title, c.position, length(c.content), public.word_count(c.content), c.updated_at
  from public.chapters c
  where c.novel_id = p_novel
  order by c.position, c.created_at
$$;

-- Reordena en una transacción. Exige la lista completa de capítulos de esa novela.
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

-- Copia completa de una novela (capítulos y memoria) con ids nuevos, en una transacción.
create or replace function public.duplicate_novel(p_novel uuid, p_title text)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_new uuid := gen_random_uuid();
  m_chap jsonb; m_char jsonb; m_place jsonb; m_fact jsonb;
begin
  insert into public.novels (id, title, synopsis, notes, guide)
  select v_new, p_title, synopsis, notes, guide from public.novels where id = p_novel;
  if not found then return null; end if;

  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_chap from public.chapters where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_char from public.characters where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_place from public.places where novel_id = p_novel;
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_fact from public.facts where novel_id = p_novel;

  insert into public.chapters (id, novel_id, title, position, content)
  select (m_chap ->> id::text)::uuid, v_new, title, position, content from public.chapters where novel_id = p_novel;

  insert into public.characters (id, novel_id, name, aliases, age, role, description, background, personality,
    motivations, fears, contradictions, "values", voice, vocabulary, secrets, knows, unaware, arc, notes)
  select (m_char ->> id::text)::uuid, v_new, name, aliases, age, role, description, background, personality,
    motivations, fears, contradictions, "values", voice, vocabulary, secrets, knows, unaware, arc, notes
  from public.characters where novel_id = p_novel;

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

  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Privacidad: RLS activado sin políticas y sin permisos para los roles públicos.
-- Con la clave anon/publishable no se puede leer, escribir ni llamar funciones.
-- La app accede sólo desde el servidor con la service_role key.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['novels', 'chapters', 'characters', 'relationships', 'places', 'facts', 'fact_characters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

revoke execute on function public.touch_row() from public, anon, authenticated;
revoke execute on function public.touch_chapter() from public, anon, authenticated;
revoke execute on function public.word_count(text) from public, anon, authenticated;
revoke execute on function public.library() from public, anon, authenticated;
revoke execute on function public.novel_outline(uuid) from public, anon, authenticated;
revoke execute on function public.reorder_chapters(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.duplicate_novel(uuid, text) from public, anon, authenticated;
grant execute on function public.word_count(text), public.library(), public.novel_outline(uuid),
  public.reorder_chapters(uuid, uuid[]), public.duplicate_novel(uuid, text) to service_role;
