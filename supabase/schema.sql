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

-- Memoria visual: imagen principal y galería de cada personaje.
-- Los archivos viven en el bucket privado 'character-images'; aquí sólo referencias y metadatos.
-- stage_label es una etiqueta descriptiva ("1982", "tras la cárcel"), no un dato cronológico.
create table if not exists public.character_images (
  id           uuid primary key default gen_random_uuid(),
  novel_id     uuid not null references public.novels(id) on delete cascade,
  character_id uuid not null,
  storage_path text not null unique,
  thumb_path   text not null unique,
  content_type text not null check (content_type in ('image/webp', 'image/jpeg', 'image/png')),
  -- Sube cuando cambian los bytes; va en la ruta y en la URL, así una versión vieja nunca se sirve.
  version      integer not null default 1 check (version > 0),
  caption      text not null default '',
  stage_label  text not null default '',
  is_primary   boolean not null default false,
  sort_order   integer not null default 0,
  width        integer not null check (width > 0),
  height       integer not null check (height > 0),
  bytes        integer not null check (bytes > 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade
);
create index if not exists character_images_character_idx on public.character_images(character_id, sort_order);
create index if not exists character_images_novel_idx on public.character_images(novel_id);
-- Como mucho una imagen principal por personaje.
create unique index if not exists character_images_one_primary
  on public.character_images(character_id) where is_primary;

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
  foreach t in array array['novels', 'characters', 'relationships', 'places', 'facts', 'character_images'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_row()', t, t);
  end loop;
end $$;

-- Al añadir: se coloca al final, la primera del personaje es la principal y hay un máximo por personaje.
-- El bloqueo de la fila del personaje serializa subidas simultáneas.
create or replace function public.character_image_insert() returns trigger
language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  -- duplicate_novel copia filas tal cual (orden y principal incluidos).
  if current_setting('procesador.copying_images', true) = 'on' then
    return new;
  end if;
  perform 1 from public.characters where id = new.character_id for update;
  select count(*) into v_count from public.character_images where character_id = new.character_id;
  if v_count >= 40 then
    raise exception 'Máximo 40 imágenes por personaje.' using errcode = '22023';
  end if;
  new.sort_order = coalesce((select max(sort_order) + 1 from public.character_images where character_id = new.character_id), 1);
  new.is_primary = v_count = 0;
  return new;
end $$;

-- Al borrar la principal, la siguiente en orden pasa a serlo (si queda alguna).
create or replace function public.character_image_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.is_primary then
    update public.character_images set is_primary = true
    where id = (select id from public.character_images
                where character_id = old.character_id
                order by sort_order, created_at limit 1)
      and not exists (select 1 from public.character_images where character_id = old.character_id and is_primary);
  end if;
  return null;
end $$;

drop trigger if exists character_images_insert on public.character_images;
create trigger character_images_insert before insert on public.character_images
  for each row execute function public.character_image_insert();
drop trigger if exists character_images_deleted on public.character_images;
create trigger character_images_deleted after delete on public.character_images
  for each row execute function public.character_image_deleted();

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

-- Imagen principal: quita la anterior y marca ésta, en una transacción.
create or replace function public.set_primary_image(p_image uuid)
returns void language plpgsql set search_path = '' as $$
declare v_character uuid;
begin
  select character_id into v_character from public.character_images where id = p_image;
  if v_character is null then
    raise exception 'Imagen no encontrada' using errcode = 'P0002';
  end if;
  perform 1 from public.characters where id = v_character for update;
  update public.character_images set is_primary = false where character_id = v_character and is_primary and id <> p_image;
  update public.character_images set is_primary = true where id = p_image;
end $$;

-- Reordena la galería en una transacción. Exige la lista completa de imágenes de ese personaje.
create or replace function public.reorder_character_images(p_character uuid, p_ids uuid[])
returns void language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.character_images where character_id = p_character) <> cardinality(p_ids)
     or (select count(*) from public.character_images where character_id = p_character and id = any(p_ids)) <> cardinality(p_ids)
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) then
    raise exception 'La lista de imágenes no coincide con la galería' using errcode = '22023';
  end if;
  update public.character_images i set sort_order = o.ord
  from unnest(p_ids) with ordinality as o(id, ord)
  where i.id = o.id and i.character_id = p_character;
end $$;

-- Copia completa de una novela (capítulos y memoria) con ids nuevos, en una transacción.
-- Devuelve el id nuevo y los archivos de imagen que el servidor debe copiar en Storage.
drop function if exists public.duplicate_novel(uuid, text);
create or replace function public.duplicate_novel(p_novel uuid, p_title text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_new uuid := gen_random_uuid();
  m_chap jsonb; m_char jsonb; m_place jsonb; m_fact jsonb; m_img jsonb;
  v_copies jsonb;
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

  -- Las rutas cambian de novela, personaje e id; el trigger de inserción no debe reordenar ni elegir principal.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_img from public.character_images where novel_id = p_novel;
  perform set_config('procesador.copying_images', 'on', true);
  insert into public.character_images (id, novel_id, character_id, storage_path, thumb_path, content_type, version,
    caption, stage_label, is_primary, sort_order, width, height, bytes)
  select (m_img ->> i.id::text)::uuid, v_new, (m_char ->> i.character_id::text)::uuid,
    concat_ws('/', v_new, m_char ->> i.character_id::text, (m_img ->> i.id::text) || '-v' || i.version || substring(i.storage_path from '\.[a-z]+$')),
    concat_ws('/', v_new, m_char ->> i.character_id::text, (m_img ->> i.id::text) || '-v' || i.version || '.thumb' || substring(i.thumb_path from '\.[a-z]+$')),
    i.content_type, i.version, i.caption, i.stage_label, i.is_primary, i.sort_order, i.width, i.height, i.bytes
  from public.character_images i where i.novel_id = p_novel;
  perform set_config('procesador.copying_images', 'off', true);

  select coalesce(jsonb_agg(jsonb_build_array(p.old_path, p.new_path)), '[]') into v_copies
  from public.character_images oi
  join public.character_images ni on ni.id = (m_img ->> oi.id::text)::uuid
  cross join lateral (values (oi.storage_path, ni.storage_path), (oi.thumb_path, ni.thumb_path)) as p(old_path, new_path)
  where oi.novel_id = p_novel;

  return jsonb_build_object('id', v_new, 'copies', v_copies);
end $$;

-- ---------------------------------------------------------------------------
-- Privacidad: RLS activado sin políticas y sin permisos para los roles públicos.
-- Con la clave anon/publishable no se puede leer, escribir ni llamar funciones.
-- La app accede sólo desde el servidor con la service_role key.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['novels', 'chapters', 'characters', 'relationships', 'places', 'facts', 'fact_characters',
                           'character_images'] loop
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
revoke execute on function public.character_image_insert() from public, anon, authenticated;
revoke execute on function public.character_image_deleted() from public, anon, authenticated;
revoke execute on function public.set_primary_image(uuid) from public, anon, authenticated;
revoke execute on function public.reorder_character_images(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.word_count(text), public.library(), public.novel_outline(uuid),
  public.reorder_chapters(uuid, uuid[]), public.duplicate_novel(uuid, text),
  public.set_primary_image(uuid), public.reorder_character_images(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado para las imágenes de personajes.
-- Sin políticas en storage.objects: sólo la service_role (el servidor) lee y escribe.
-- Se omite donde no existe el esquema storage (p. ej. el Postgres de las pruebas E2E).
-- ---------------------------------------------------------------------------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('character-images', 'character-images', false, 4194304, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do update set public = false,
                                   file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
