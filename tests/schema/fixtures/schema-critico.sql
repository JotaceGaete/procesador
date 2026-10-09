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
  -- Sólo la tabla del MVP (reconocible por sus columnas), nunca otra que se llame igual.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'projects' and column_name = 'style_notes')
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'projects' and column_name = 'singleton') then
    drop table public.projects;
  end if;
  -- Borrador de la galería (sin publicar) que guardaba las rutas en character_images.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'character_images' and column_name = 'storage_path') then
    drop table public.character_images;
  end if;
  drop function if exists public.set_updated_at();
end $$;

-- ---------------------------------------------------------------------------
-- Utilidades del esquema. Van antes de las tablas: cada tabla se protege justo
-- después de crearse, de modo que ninguna sentencia se refiere a una tabla que
-- no se haya garantizado antes (aunque se ejecute sólo una parte del archivo).
-- ---------------------------------------------------------------------------
create or replace function public.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- RLS activado sin políticas, sin permisos para las claves públicas (anon, authenticated)
-- y todos para la service_role del servidor. Con p_touch, el trigger <tabla>_touch que
-- mantiene updated_at. Idempotente.
create or replace function public.procesador_secure_table(p_table regclass, p_touch boolean)
returns void language plpgsql set search_path = '' as $$
declare v_name text := (select relname from pg_catalog.pg_class where oid = p_table);
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from anon, authenticated', p_table);
  execute format('grant all on %s to service_role', p_table);
  if p_touch then
    execute format('drop trigger if exists %I on %s', v_name || '_touch', p_table);
    execute format('create trigger %I before update on %s for each row execute function public.touch_row()',
                   v_name || '_touch', p_table);
  end if;
end $$;
revoke execute on function public.procesador_secure_table(regclass, boolean) from public, anon, authenticated;

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
select public.procesador_secure_table('public.novels', true);

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
-- Su trigger de updated_at es chapters_touch (touch_chapter: también sube la revisión), más abajo.
select public.procesador_secure_table('public.chapters', false);

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
select public.procesador_secure_table('public.characters', true);
-- Cronología (docs/cronologia-edades.md). La edad no se guarda: se calcula desde un ancla
-- {kind:'birth', date} o {kind:'age_at', age, at:{chapter_id}|{date}}. `age` sigue como nota.
-- age_approx: "unos cuarenta" (≈, sin avisos por un año). death: fecha opcional. Validados en la API.
alter table public.characters add column if not exists age_anchor jsonb;
alter table public.characters add column if not exists age_approx boolean not null default false;
alter table public.characters add column if not exists death jsonb;

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
select public.procesador_secure_table('public.relationships', true);

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
select public.procesador_secure_table('public.places', true);

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
select public.procesador_secure_table('public.facts', true);

create table if not exists public.fact_characters (
  fact_id      uuid not null,
  character_id uuid not null,
  novel_id     uuid not null,
  primary key (fact_id, character_id),
  foreign key (fact_id, novel_id) references public.facts(id, novel_id) on delete cascade,
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade
);
select public.procesador_secure_table('public.fact_characters', false);

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
  -- Tamaño en píxeles tal como se ve la imagen (orientación EXIF ya aplicada).
  width          integer check (width > 0),
  height         integer check (height > 0),
  -- Orientación EXIF del original (1 = tal cual; 5–8 = girada un cuarto de vuelta).
  orientation    smallint not null default 1 check (orientation between 1 and 8),
  -- Huella del original, calculada por el servidor al terminar la subida. Dentro de una
  -- novela no hay dos archivos listos con el mismo contenido (ver finalize_asset).
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
alter table public.assets add column if not exists orientation smallint not null default 1
  check (orientation between 1 and 8);
create index if not exists assets_novel_sha_idx on public.assets(novel_id, sha256) where status = 'ready';
select public.procesador_secure_table('public.assets', true);

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
select public.procesador_secure_table('public.character_images', true);
-- Como mucho una imagen principal por personaje.
create unique index if not exists character_images_one_primary
  on public.character_images(character_id) where is_primary;

-- Uso: imagen del manuscrito (contenido editorial del libro; docs/manuscrito-imagenes.md).
-- Su posición es el marcador [[imagen:<id>]] en el texto del capítulo. chapter_id es un
-- índice que el servidor sincroniza al guardar; null = sin colocar (sigue siendo un uso).
create table if not exists public.manuscript_images (
  id          uuid primary key default gen_random_uuid(),
  novel_id    uuid not null references public.novels(id) on delete cascade,
  asset_id    uuid not null,
  chapter_id  uuid,
  -- Texto alternativo (accesibilidad), independiente del pie. No hace falta si es decorativa.
  alt         text not null default '',
  decorative  boolean not null default false,
  -- Pie editorial y crédito/atribución: conceptos distintos, tratados aparte al exportar.
  caption     text not null default '',
  credit      text not null default '',
  -- 'inline': en el flujo del texto; 'page': en página propia (mapas, láminas).
  layout      text not null default 'inline' check (layout in ('inline', 'page')),
  align       text not null default 'center' check (align in ('center', 'left', 'right')),
  -- Ancho relativo a la caja de texto: sirve igual para PDF, EPUB y DOCX.
  width_pct   integer not null default 100 check (width_pct in (25, 50, 75, 100)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, novel_id),
  -- Sin cascada: el archivo no se puede borrar mientras esta imagen exista, colocada o no.
  foreign key (asset_id, novel_id) references public.assets(id, novel_id),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (chapter_id)
);
create index if not exists manuscript_images_novel_idx on public.manuscript_images(novel_id);
create index if not exists manuscript_images_asset_idx on public.manuscript_images(asset_id);
create index if not exists manuscript_images_chapter_idx on public.manuscript_images(chapter_id);
select public.procesador_secure_table('public.manuscript_images', true);

-- Registro de uso de la IA (docs/consejero.md): una fila por consulta, con los tokens que
-- informó el proveedor y su costo estimado (null si no hay precios configurados).
-- purpose: 'assist' (Asistente), 'advise' (Consejero), 'digest' (resúmenes de capítulo),
-- 'critic' (Crítico Literario).
-- No se copia al duplicar una novela.
create table if not exists public.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  novel_id       uuid not null references public.novels(id) on delete cascade,
  purpose        text not null check (purpose in ('assist', 'advise', 'digest', 'critic')),
  provider       text not null,
  model          text not null,
  input_tokens   integer not null default 0 check (input_tokens >= 0),
  cached_tokens  integer not null default 0 check (cached_tokens >= 0),
  output_tokens  integer not null default 0 check (output_tokens >= 0),
  cost_usd       numeric(12, 6),
  created_at     timestamptz not null default now()
);
create index if not exists ai_usage_novel_idx on public.ai_usage(novel_id, created_at);
select public.procesador_secure_table('public.ai_usage', false);

-- Consejero, fase 2 (docs/consejero.md): la lectura de la novela. Todo es derivado y
-- regenerable: el manuscrito (chapters.content) es siempre la fuente de verdad, y nada
-- de esto repite lo que guarda la Memoria (los personajes se citan por id).

-- Interruptor: rehacer la ficha de un capítulo al dejarlo tras un cambio sustancial.
alter table public.novels add column if not exists auto_digest boolean not null default true;
-- Cronología: calendario real (1972) o relativo (Año 0, Año 5), y advertencias descartadas
-- por el autor ({clave: huella}: vuelven si cambian los datos que las producen).
alter table public.novels add column if not exists calendar text not null default 'real';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'novels_calendar_check') then
    alter table public.novels add constraint novels_calendar_check check (calendar in ('real', 'relative'));
  end if;
end $$;
alter table public.novels add column if not exists dismissed_warnings jsonb not null default '{}'::jsonb;
-- Exportación editorial (docs/exportacion.md): los datos del libro (autor, ISBN, dedicatoria,
-- página de créditos, portada, tamaño de página y márgenes). Los valida la app (src/lib/book.ts).
alter table public.novels add column if not exists book jsonb not null default '{}'::jsonb;
-- Argumento general (docs/consejero.md): la trama completa, los secretos y el desenlace previsto.
-- Solo lo lee el Consejero; el Asistente nunca. La app limita su longitud (src/lib/types.ts,
-- PLOT_MAX) y lo copia al duplicar la novela (no duplicate_novel).
alter table public.novels add column if not exists plot text not null default '';

-- Cabos y conflictos. Los propone el Consejero al leer (origin 'advisor', sin confirmar:
-- "posible cabo") o los crea el autor. Capítulo de apertura, última aparición y cierre se
-- derivan de las fichas; status_by indica si el estado lo decidió el autor (y entonces manda).
create table if not exists public.story_threads (
  id                 uuid primary key default gen_random_uuid(),
  novel_id           uuid not null references public.novels(id) on delete cascade,
  title              text not null check (length(title) between 1 and 200),
  description        text not null default '',
  kind               text not null default 'other' check (kind in ('conflict', 'mystery', 'promise', 'relationship', 'other')),
  status             text not null default 'open' check (status in ('open', 'closed', 'abandoned')),
  status_by          text not null default 'advisor' check (status_by in ('advisor', 'author')),
  origin             text not null default 'advisor' check (origin in ('advisor', 'author')),
  confirmed          boolean not null default false,
  opened_chapter_id  uuid,
  last_chapter_id    uuid,
  closed_chapter_id  uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, novel_id),
  foreign key (opened_chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (opened_chapter_id),
  foreign key (last_chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (last_chapter_id),
  foreign key (closed_chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (closed_chapter_id)
);
create index if not exists story_threads_novel_idx on public.story_threads(novel_id);
select public.procesador_secure_table('public.story_threads', true);

-- Ficha de lectura de cada capítulo. source_revision es la revisión del capítulo leída;
-- text_sketch, una huella numérica del texto leído (secuencias de tres palabras, bottom-k),
-- distingue un retoque de una reescritura sin guardar el texto. Las citas (quote) son literales
-- y cortas: lo único del texto que se guarda fuera de chapters, y se verifican contra él.
--   events       [{ text, characters: [character_id], quote }]
--   presence     [{ character: character_id, kind: 'present' | 'mentioned' }]
--   revelations  [{ text, to: 'lector' | character_id, quote }]
--   threads      [{ thread: story_thread_id, change: 'opened' | 'advanced' | 'closed', quote }]
create table if not exists public.chapter_digests (
  chapter_id        uuid primary key,
  novel_id          uuid not null references public.novels(id) on delete cascade,
  source_revision   integer not null,
  text_sketch       jsonb not null default '{"n": 0, "h": []}'::jsonb,
  summary           text not null default '',
  events            jsonb not null default '[]'::jsonb,
  presence          jsonb not null default '[]'::jsonb,
  revelations       jsonb not null default '[]'::jsonb,
  threads           jsonb not null default '[]'::jsonb,
  notes             text not null default '',
  -- Corregida a mano: no se pisa al regenerar automáticamente.
  author_edited     boolean not null default false,
  model             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);
create index if not exists chapter_digests_novel_idx on public.chapter_digests(novel_id);
select public.procesador_secure_table('public.chapter_digests', true);

-- Conversaciones del Consejero (fase 4). Los turnos más recientes van literales a cada
-- consulta; los anteriores, resumidos en summary (hasta el mensaje summarized_count).
create table if not exists public.advisor_conversations (
  id               uuid primary key default gen_random_uuid(),
  novel_id         uuid not null references public.novels(id) on delete cascade,
  title            text not null default '' check (length(title) <= 200),
  summary          text not null default '',
  summarized_count integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, novel_id)
);
create index if not exists advisor_conversations_novel_idx on public.advisor_conversations(novel_id, updated_at);
select public.procesador_secure_table('public.advisor_conversations', true);

-- Mensajes: del autor (pregunta o acción) y del Consejero (su texto en Markdown).
-- context: qué se leyó (partes y tokens), el plan y based_on { chapter_id: revision }.
create table if not exists public.advisor_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null,
  novel_id         uuid not null references public.novels(id) on delete cascade,
  role             text not null check (role in ('author', 'advisor')),
  content          text not null,
  context          jsonb,
  created_at       timestamptz not null default now(),
  unique (id, novel_id),
  foreign key (conversation_id, novel_id) references public.advisor_conversations(id, novel_id) on delete cascade
);
create index if not exists advisor_messages_conversation_idx on public.advisor_messages(conversation_id, created_at);
select public.procesador_secure_table('public.advisor_messages', false);

-- Observaciones (tarjetas). refs: [{ chapterId, quote, verified, at }], verificadas contra el
-- texto. based_on: { chapter_id: revision } de los capítulos en que se apoya; si alguno cambió,
-- la observación se marca "basada en una versión anterior" y se puede volver a comprobar.
-- Sobreviven a su conversación (message_id pasa a null) si el autor las guardó.
create table if not exists public.advisor_observations (
  id          uuid primary key default gen_random_uuid(),
  novel_id    uuid not null references public.novels(id) on delete cascade,
  message_id  uuid,
  kind        text not null check (kind in ('problem', 'repetition', 'contradiction', 'thread', 'opportunity', 'alternative', 'pacing')),
  title       text not null default '',
  body        text not null default '',
  confidence  text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  verified    boolean not null default false,
  refs        jsonb not null default '[]'::jsonb,
  based_on    jsonb not null default '{}'::jsonb,
  status      text not null default 'new' check (status in ('new', 'saved', 'dismissed', 'resolved')),
  -- Orden dentro de su respuesta.
  position    smallint not null default 0,
  checked_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (message_id, novel_id) references public.advisor_messages(id, novel_id) on delete set null (message_id)
);
create index if not exists advisor_observations_novel_idx on public.advisor_observations(novel_id, status);
create index if not exists advisor_observations_message_idx on public.advisor_observations(message_id);
select public.procesador_secure_table('public.advisor_observations', true);

-- Resumen global, derivado de las fichas (no del texto). based_on: { chapter_id: revision }.
create table if not exists public.novel_digests (
  novel_id    uuid primary key references public.novels(id) on delete cascade,
  summary     text not null default '',
  based_on    jsonb not null default '{}'::jsonb,
  model       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
select public.procesador_secure_table('public.novel_digests', true);

-- Versiones de capítulo (docs/versiones.md): copias completas del texto de un capítulo.
-- chapter_id null = el capítulo se eliminó y sus versiones están en la papelera;
-- source_chapter_id recuerda de qué capítulo eran. No se copian al duplicar una novela.
create table if not exists public.chapter_versions (
  id                uuid primary key default gen_random_uuid(),
  novel_id          uuid not null references public.novels(id) on delete cascade,
  chapter_id        uuid,
  source_chapter_id uuid not null,
  title             text not null default '',
  position          integer not null default 0,
  content           text not null,
  words             integer not null default 0,
  -- auto: mientras se escribe (como mucho una cada 30 minutos); ai: antes de aplicar una
  -- propuesta de la IA; conflict: la versión de otra pestaña o dispositivo, antes de
  -- «Conservar la mía»; manual: guardada por el autor; restore: antes de restaurar otra
  -- versión; delete: al eliminar el capítulo.
  reason            text not null check (reason in ('auto', 'ai', 'conflict', 'manual', 'restore', 'delete')),
  label             text not null default '' check (length(label) <= 200),
  created_at        timestamptz not null default now(),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete set null (chapter_id)
);
create index if not exists chapter_versions_chapter_idx on public.chapter_versions(chapter_id, created_at desc);
create index if not exists chapter_versions_trash_idx on public.chapter_versions(novel_id, source_chapter_id) where chapter_id is null;
select public.procesador_secure_table('public.chapter_versions', false);

-- Cronología: el tiempo del relato como marcas ancladas a un punto del manuscrito. En esta
-- versión, una por capítulo y al inicio (anchor {at:'chapter_start'}). when: {date:{year,
-- month?, day?}} o {after:{years?, months?, days?}} respecto del capítulo anterior. flashback:
-- retrospectiva a propósito (sin aviso por retroceder). Validadas en la API (src/lib/chronology.ts).
create table if not exists public.time_marks (
  id          uuid primary key default gen_random_uuid(),
  novel_id    uuid not null references public.novels(id) on delete cascade,
  chapter_id  uuid not null,
  anchor      jsonb not null default '{"at": "chapter_start"}'::jsonb,
  "when"      jsonb not null,
  flashback   boolean not null default false,
  label       text not null default '' check (length(label) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);
-- Una marca de inicio por capítulo. Se quitará al admitir marcas dentro del capítulo.
create unique index if not exists time_marks_one_per_chapter on public.time_marks(chapter_id) where (anchor ->> 'at') = 'chapter_start';
create index if not exists time_marks_novel_idx on public.time_marks(novel_id);
select public.procesador_secure_table('public.time_marks', true);

-- Crítico Literario (docs/critico.md): el juicio de un capítulo terminado. Un informe por
-- evaluación, que no se edita (otra evaluación es otra fila); el autor sólo añade su
-- respuesta. source_revision y text_sketch dicen sobre qué versión del capítulo se hizo. No
-- guarda texto del manuscrito salvo citas breves, verificadas contra él. No se copia al
-- duplicar una novela (es el historial de esa novela) y se borra con el capítulo.
--   scores          [{ criterion, score (1–10, un decimal; null = no aplica), rationale, refs: [{ quote, verified }], impression }]
--   experience      { effects: [...], summary, stretches: [{ effect, note, quote, verified }] }
--   strengths, weaknesses  [{ text, quote, verified }]
--   contradictions  [{ description, quote, quoteVerified, sourceQuote, sourceChapter, sourceVerified, confirmed, affects }]
--   context         qué leyó y el uso: { parts, missingDigests, staleDigests, input, cached, output, costUsd }
create table if not exists public.chapter_critiques (
  id               uuid primary key default gen_random_uuid(),
  novel_id         uuid not null references public.novels(id) on delete cascade,
  chapter_id       uuid not null,
  source_revision  integer not null,
  text_sketch      jsonb not null default '{"n": 0, "h": []}'::jsonb,
  chapter_kind     text not null default '',
  scores           jsonb not null default '[]'::jsonb,
  average          numeric(3, 1) not null,
  overall_score    numeric(3, 1) not null check (overall_score between 1 and 10),
  verdict          text not null check (verdict in ('excelente', 'solido', 'irregular', 'no_funciona')),
  verdict_text     text not null default '',
  experience       jsonb not null default '{}'::jsonb,
  strengths        jsonb not null default '[]'::jsonb,
  weaknesses       jsonb not null default '[]'::jsonb,
  contradictions   jsonb not null default '[]'::jsonb,
  context          jsonb not null default '{}'::jsonb,
  provider         text not null,
  model            text not null default '',
  author_response  text check (author_response in ('agree', 'disagree')),
  author_note      text not null default '' check (length(author_note) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);
create index if not exists chapter_critiques_chapter_idx on public.chapter_critiques(chapter_id, created_at desc);
create index if not exists chapter_critiques_novel_idx on public.chapter_critiques(novel_id);
select public.procesador_secure_table('public.chapter_critiques', true);
-- Una base anterior al Crítico tiene ai_usage sin el propósito 'critic'.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_purpose_check'
                 and pg_get_constraintdef(oid) like '%critic%') then
    alter table public.ai_usage drop constraint if exists ai_usage_purpose_check;
    alter table public.ai_usage add constraint ai_usage_purpose_check check (purpose in ('assist', 'advise', 'digest', 'critic'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
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

-- Copia automática mientras se escribe: el texto anterior a un guardado, si el capítulo no
-- tiene ninguna versión de los últimos 30 minutos. Así siempre hay un punto al que volver
-- de cada media hora de trabajo, sin depender del navegador.
create or replace function public.chapter_version_auto() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.content is distinct from old.content and btrim(old.content) <> ''
     and coalesce(current_setting('procesador.copying', true), '') <> 'on'
     and not exists (select 1 from public.chapter_versions
                     where chapter_id = new.id and created_at > now() - interval '30 minutes') then
    perform public.save_chapter_version(new.id, 'auto', '', old.content);
  end if;
  return null;
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

drop trigger if exists chapters_version on public.chapters;
create trigger chapters_version after update of content on public.chapters
  for each row execute function public.chapter_version_auto();

-- ---------------------------------------------------------------------------
-- Funciones usadas por el servidor
-- ---------------------------------------------------------------------------
-- Palabras de la prosa: los marcadores de imagen y los separadores no cuentan (como countWords
-- en src/lib/manuscript.ts).
create or replace function public.word_count(t text) returns integer
language sql immutable set search_path = '' as $$
  select case when btrim(c) = '' then 0
              else coalesce(array_length(regexp_split_to_array(btrim(c), '\s+'), 1), 0) end
  from (select regexp_replace(regexp_replace(t, '\[\[imagen:[0-9a-fA-F-]{36}\]\]', ' ', 'g'),
                              '\[\[separador\]\]', ' ', 'gi') as c) x
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

-- Guarda una versión de un capítulo: el texto indicado o, sin él, el guardado. Un texto vacío
-- no se guarda. No repite la última versión si es idéntica (salvo las del autor y la de la
-- papelera). Conserva las 100 versiones automáticas más recientes de cada capítulo; las
-- guardadas por el autor y las de la papelera no se podan. Devuelve el id (o null).
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

-- Eliminar un capítulo: su texto pasa a la papelera (una versión 'delete') y el capítulo se
-- borra, en una transacción. Sus versiones quedan en la papelera (chapter_id null). Una
-- novela conserva siempre al menos un capítulo.
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

-- La papelera de una novela: un capítulo eliminado por fila, con su última versión, el más
-- reciente primero. Antes vacía lo eliminado hace más de 30 días.
create or replace function public.chapter_trash(p_novel uuid)
returns table (source_chapter_id uuid, title text, "position" integer, words integer, deleted_at timestamptz, versions integer)
language plpgsql set search_path = '' as $$
#variable_conflict use_column
begin
  delete from public.chapter_versions v
  where v.novel_id = p_novel and v.chapter_id is null
    and v.source_chapter_id in (select x.source_chapter_id from public.chapter_versions x
                                where x.novel_id = p_novel and x.chapter_id is null
                                group by x.source_chapter_id
                                having max(x.created_at) < now() - interval '30 days');
  return query
  select t.source_chapter_id, t.title, t.position, t.words, t.created_at, t.versions
  from (select distinct on (v.source_chapter_id) v.source_chapter_id, v.title, v.position, v.words, v.created_at,
               (count(*) over (partition by v.source_chapter_id))::integer as versions
        from public.chapter_versions v
        where v.novel_id = p_novel and v.chapter_id is null
        order by v.source_chapter_id, v.created_at desc, v.id desc) t
  order by t.created_at desc;
end $$;

-- Recuperar un capítulo de la papelera: vuelve al final de la novela con el título y el texto
-- de su última versión, y con todo su historial. Devuelve el id del capítulo.
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

-- Usos de cada archivo. Al añadir otra tabla de uso (manuscript_images, place_images…),
-- se añade aquí y en duplicate_novel.
create or replace function public.asset_in_use(p_asset uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.character_images where asset_id = p_asset)
      or exists (select 1 from public.manuscript_images where asset_id = p_asset)
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

-- Último paso de una subida. Bajo un bloqueo por novela, si ya existe un archivo listo con
-- el mismo contenido devuelve ése (el servidor descarta la copia nueva); si no, marca éste
-- como listo. Así una novela nunca guarda dos veces el mismo archivo, ni con subidas simultáneas.
drop function if exists public.finalize_asset(uuid, text, text, bigint, integer, integer, text, text, text);
create or replace function public.finalize_asset(
  p_asset uuid, p_sha256 text, p_type text, p_bytes bigint, p_width integer, p_height integer, p_orientation smallint,
  p_display text, p_thumb text, p_derived text)
returns uuid language plpgsql set search_path = '' as $$
declare v_novel uuid; v_existing uuid;
begin
  select novel_id into v_novel from public.assets where id = p_asset and status = 'pending';
  if v_novel is null then
    raise exception 'Este archivo ya está completo' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_novel::text, 0));
  select id into v_existing from public.assets
  where novel_id = v_novel and status = 'ready' and sha256 = p_sha256 and original_bytes = p_bytes
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;
  update public.assets
  set status = 'ready', sha256 = p_sha256, original_type = p_type, original_bytes = p_bytes,
      width = p_width, height = p_height, orientation = p_orientation, display_path = p_display, thumb_path = p_thumb, derived_type = p_derived
  where id = p_asset;
  return p_asset;
end $$;

-- Reemplazar un archivo: los usos pasan a apuntar a otro archivo y conservan todo lo demás
-- (id, textos, orden, principal, posición en el capítulo). p_kind es 'character' o
-- 'manuscript'. Con p_all = false sólo cambia ese uso; con true, todos los usos del archivo
-- anterior, en cualquier tabla de uso. Devuelve el archivo anterior, que el servidor borra
-- si se quedó sin usos.
drop function if exists public.replace_asset_uses(uuid, uuid, boolean);
create or replace function public.replace_asset_uses(p_kind text, p_use uuid, p_new uuid, p_all boolean)
returns uuid language plpgsql set search_path = '' as $$
declare v_old uuid;
begin
  if p_kind = 'character' then
    select asset_id into v_old from public.character_images where id = p_use;
  elsif p_kind = 'manuscript' then
    select asset_id into v_old from public.manuscript_images where id = p_use;
  end if;
  if v_old is null then
    raise exception 'Imagen no encontrada' using errcode = 'P0002';
  end if;
  if v_old = p_new then
    return v_old;
  end if;
  if p_all then
    update public.character_images set asset_id = p_new where asset_id = v_old;
    update public.manuscript_images set asset_id = p_new where asset_id = v_old;
  elsif p_kind = 'character' then
    update public.character_images set asset_id = p_new where id = p_use;
  else
    update public.manuscript_images set asset_id = p_new where id = p_use;
  end if;
  return v_old;
end $$;

-- Al guardar un capítulo: las imágenes cuyos marcadores están en su texto pasan a estar en
-- él; las que estaban en él y ya no aparecen quedan sin colocar (nunca se borran). Sólo
-- toca imágenes de la misma novela: un marcador ajeno no se resuelve.
create or replace function public.sync_chapter_images(p_chapter uuid, p_ids uuid[])
returns void language plpgsql set search_path = '' as $$
declare v_novel uuid;
begin
  select novel_id into v_novel from public.chapters where id = p_chapter;
  if v_novel is null then return; end if;
  update public.manuscript_images set chapter_id = null
  where chapter_id = p_chapter and not (id = any(p_ids));
  update public.manuscript_images set chapter_id = p_chapter
  where novel_id = v_novel and id = any(p_ids) and chapter_id is distinct from p_chapter;
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

-- ---------------------------------------------------------------------------
-- Privacidad: RLS activado sin políticas y sin permisos para los roles públicos.
-- Con la clave anon/publishable no se puede leer, escribir ni llamar funciones.
-- La app accede sólo desde el servidor con la service_role key.
-- ---------------------------------------------------------------------------
-- Cada tabla se protegió al crearse (procesador_secure_table). Comprobación final: si
-- falta alguna tabla o alguna quedó sin RLS (por ejemplo, porque se ejecutó sólo una
-- parte de este archivo), se detiene con un mensaje claro. En el SQL Editor de Supabase todo
-- el archivo es una sola transacción: al detenerse no queda nada aplicado a medias.
do $$
declare v_missing text;
begin
  select string_agg(t, ', ') into v_missing
  from unnest(array['novels', 'chapters', 'characters', 'relationships', 'places', 'facts', 'fact_characters',
                    'assets', 'character_images', 'manuscript_images', 'ai_usage', 'story_threads',
                    'chapter_digests', 'novel_digests', 'advisor_conversations', 'advisor_messages',
                    'advisor_observations', 'chapter_versions', 'time_marks', 'chapter_critiques']) as t
  where to_regclass('public.' || t) is null
     or not (select relrowsecurity from pg_class where oid = to_regclass('public.' || t));
  if v_missing is not null then
    raise exception 'Esquema incompleto: falta o no está protegida: %. Ejecuta supabase/schema.sql completo, sin seleccionar una parte.', v_missing;
  end if;
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
revoke execute on function public.finalize_asset(uuid, text, text, bigint, integer, integer, smallint, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.replace_asset_uses(text, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.sync_chapter_images(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.chapter_version_auto() from public, anon, authenticated;
revoke execute on function public.save_chapter_version(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.trash_chapter(uuid) from public, anon, authenticated;
revoke execute on function public.chapter_trash(uuid) from public, anon, authenticated;
revoke execute on function public.restore_chapter(uuid, uuid) from public, anon, authenticated;
grant execute on function public.word_count(text), public.library(), public.novel_outline(uuid),
  public.reorder_chapters(uuid, uuid[]), public.duplicate_novel(uuid, text),
  public.set_primary_image(uuid), public.reorder_character_images(uuid, uuid[]),
  public.asset_in_use(uuid), public.delete_unused_assets(uuid[]), public.sweep_assets(uuid),
  public.finalize_asset(uuid, text, text, bigint, integer, integer, smallint, text, text, text),
  public.replace_asset_uses(text, uuid, uuid, boolean), public.sync_chapter_images(uuid, uuid[]),
  public.save_chapter_version(uuid, text, text, text), public.trash_chapter(uuid), public.chapter_trash(uuid),
  public.restore_chapter(uuid, uuid) to service_role;

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
