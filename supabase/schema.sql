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
  -- Borrador de la galería (sin publicar) que guardaba las rutas en character_images.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'character_images' and column_name = 'storage_path') then
    drop table public.character_images;
  end if;
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

-- Archivos de la novela (ver docs/archivos.md). Un archivo: el original, conservado siempre,
-- y sus derivados para la interfaz. Los bytes viven en el bucket privado 'novel-files';
-- aquí sólo rutas y metadatos. Los usos (galería, manuscrito…) son tablas aparte que lo
-- referencian: un archivo no se borra mientras tenga algún uso.
create table if not exists public.assets (
  id             uuid primary key default gen_random_uuid(),
  novel_id       uuid not null references public.novels(id) on delete cascade,
  -- 'pending' mientras el navegador sube el original; sólo los 'ready' se usan y se sirven.
  status         text not null default 'pending' check (status in ('pending', 'ready')),
  -- Sube al reemplazar el archivo; va en las rutas y en las URLs.
  version        integer not null default 1 check (version > 0),
  file_name      text not null default '',
  original_path  text not null unique,
  original_type  text not null check (original_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  original_bytes bigint not null check (original_bytes > 0),
  width          integer check (width > 0),
  height         integer check (height > 0),
  -- Calculado en el navegador; sólo sirve para avisar de archivos repetidos.
  sha256         text,
  display_path   text unique,
  thumb_path     text unique,
  derived_type   text check (derived_type in ('image/webp', 'image/jpeg', 'image/png')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, novel_id),
  check (status = 'pending' or (width is not null and height is not null and display_path is not null
                                 and thumb_path is not null and derived_type is not null))
);
create index if not exists assets_novel_idx on public.assets(novel_id);

-- Uso: galería de un personaje (imágenes de referencia).
-- stage_label es una etiqueta descriptiva ("1982", "tras la cárcel"), no un dato cronológico.
create table if not exists public.character_images (
  id           uuid primary key default gen_random_uuid(),
  novel_id     uuid not null references public.novels(id) on delete cascade,
  character_id uuid not null,
  asset_id     uuid not null,
  caption      text not null default '',
  stage_label  text not null default '',
  is_primary   boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade,
  -- Sin cascada: la base de datos impide borrar un archivo que todavía se usa.
  foreign key (asset_id, novel_id) references public.assets(id, novel_id)
);
create index if not exists character_images_character_idx on public.character_images(character_id, sort_order);
create index if not exists character_images_novel_idx on public.character_images(novel_id);
create index if not exists character_images_asset_idx on public.character_images(asset_id);
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
  foreach t in array array['novels', 'characters', 'relationships', 'places', 'facts', 'assets', 'character_images'] loop
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
  if current_setting('procesador.copying', true) = 'on' then
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

-- Usos de cada archivo. Al añadir otra tabla de uso (manuscript_images, place_images…),
-- se añade aquí y en duplicate_novel.
create or replace function public.asset_in_use(p_asset uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.character_images where asset_id = p_asset)
$$;

-- Borra los archivos indicados que ya no tienen ningún uso y devuelve sus rutas para
-- que el servidor los quite del bucket. Los que siguen en uso no se tocan.
create or replace function public.delete_unused_assets(p_ids uuid[])
returns table (path text) language plpgsql set search_path = '' as $$
begin
  return query
  with gone as (
    delete from public.assets a
    where a.id = any(p_ids) and not public.asset_in_use(a.id)
    returning a.original_path, a.display_path, a.thumb_path
  )
  select p from gone, unnest(array[gone.original_path, gone.display_path, gone.thumb_path]) as p
  where p is not null;
end $$;

-- Limpieza de una novela: subidas sin terminar de más de un día, y archivos listos que se
-- quedaron sin uso hace más de una hora (p. ej. un uso que falló al crearse).
create or replace function public.sweep_assets(p_novel uuid)
returns table (path text) language plpgsql set search_path = '' as $$
begin
  return query
  with gone as (
    delete from public.assets a
    where a.novel_id = p_novel
      and ((a.status = 'pending' and a.created_at < now() - interval '1 day')
        or (a.status = 'ready' and a.updated_at < now() - interval '1 hour' and not public.asset_in_use(a.id)))
    returning a.original_path, a.display_path, a.thumb_path
  )
  select p from gone, unnest(array[gone.original_path, gone.display_path, gone.thumb_path]) as p
  where p is not null;
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
-- Devuelve el id nuevo y los pares de rutas (origen, destino) que el servidor copia en Storage.
drop function if exists public.duplicate_novel(uuid, text);
create or replace function public.duplicate_novel(p_novel uuid, p_title text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_new uuid := gen_random_uuid();
  m_chap jsonb; m_char jsonb; m_place jsonb; m_fact jsonb; m_asset jsonb;
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

  -- Archivos: filas nuevas con rutas bajo la novela nueva. Los bytes los copia el servidor
  -- (pares devueltos en 'copies'); dentro de la novela, cada archivo se copia una sola vez
  -- aunque tenga varios usos. Las subidas sin terminar no se copian.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_asset
  from public.assets where novel_id = p_novel and status = 'ready';
  insert into public.assets (id, novel_id, status, version, file_name, original_path, original_type, original_bytes,
    width, height, sha256, display_path, thumb_path, derived_type)
  select (m_asset ->> a.id::text)::uuid, v_new, 'ready', a.version, a.file_name,
    regexp_replace(a.original_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    a.original_type, a.original_bytes, a.width, a.height, a.sha256,
    regexp_replace(a.display_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    regexp_replace(a.thumb_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    a.derived_type
  from public.assets a where a.novel_id = p_novel and a.status = 'ready';

  -- Usos: el trigger de inserción no debe reordenar ni elegir principal al copiar.
  perform set_config('procesador.copying', 'on', true);
  insert into public.character_images (novel_id, character_id, asset_id, caption, stage_label, is_primary, sort_order)
  select v_new, (m_char ->> i.character_id::text)::uuid, (m_asset ->> i.asset_id::text)::uuid,
         i.caption, i.stage_label, i.is_primary, i.sort_order
  from public.character_images i where i.novel_id = p_novel;
  perform set_config('procesador.copying', 'off', true);

  select coalesce(jsonb_agg(jsonb_build_array(p.old_path, p.new_path)), '[]') into v_copies
  from public.assets oa
  join public.assets na on na.id = (m_asset ->> oa.id::text)::uuid
  cross join lateral (values (oa.original_path, na.original_path), (oa.display_path, na.display_path),
                             (oa.thumb_path, na.thumb_path)) as p(old_path, new_path)
  where oa.novel_id = p_novel and oa.status = 'ready';

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
                           'assets', 'character_images'] loop
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
revoke execute on function public.asset_in_use(uuid) from public, anon, authenticated;
revoke execute on function public.delete_unused_assets(uuid[]) from public, anon, authenticated;
revoke execute on function public.sweep_assets(uuid) from public, anon, authenticated;
grant execute on function public.word_count(text), public.library(), public.novel_outline(uuid),
  public.reorder_chapters(uuid, uuid[]), public.duplicate_novel(uuid, text),
  public.set_primary_image(uuid), public.reorder_character_images(uuid, uuid[]),
  public.asset_in_use(uuid), public.delete_unused_assets(uuid[]), public.sweep_assets(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Storage: un bucket privado para todos los archivos de las novelas (docs/archivos.md).
-- Sin políticas en storage.objects: sólo la service_role (el servidor) lee y escribe.
-- El navegador sólo sube originales, con una URL firmada de un solo uso que emite el servidor.
-- Se omite donde no existe el esquema storage (p. ej. el Postgres de las pruebas E2E).
-- ---------------------------------------------------------------------------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('novel-files', 'novel-files', false, 52428800,
            array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
    on conflict (id) do update set public = false,
                                   file_size_limit = excluded.file_size_limit,
                                   allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
