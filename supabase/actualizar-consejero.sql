-- Actualización de una base existente a las fases 1 a 5 del Consejero.
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes:
-- sólo añade una columna (novels.auto_digest), tablas nuevas, índices, triggers,
-- RLS, permisos y la versión actual de duplicate_novel.
-- Equivale a la parte nueva de supabase/schema.sql; ejecutar el schema completo también sirve.

begin;

-- Registro de uso de la IA (docs/consejero.md): una fila por consulta, con los tokens que
-- informó el proveedor y su costo estimado (null si no hay precios configurados).
-- purpose: 'assist' (Asistente), 'advise' (Consejero), 'digest' (resúmenes de capítulo).
-- No se copia al duplicar una novela.
create table if not exists public.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  novel_id       uuid not null references public.novels(id) on delete cascade,
  purpose        text not null check (purpose in ('assist', 'advise', 'digest')),
  provider       text not null,
  model          text not null,
  input_tokens   integer not null default 0 check (input_tokens >= 0),
  cached_tokens  integer not null default 0 check (cached_tokens >= 0),
  output_tokens  integer not null default 0 check (output_tokens >= 0),
  cost_usd       numeric(12, 6),
  created_at     timestamptz not null default now()
);
create index if not exists ai_usage_novel_idx on public.ai_usage(novel_id, created_at);

-- Consejero, fase 2 (docs/consejero.md): la lectura de la novela. Todo es derivado y
-- regenerable: el manuscrito (chapters.content) es siempre la fuente de verdad, y nada
-- de esto repite lo que guarda la Memoria (los personajes se citan por id).

-- Interruptor: rehacer la ficha de un capítulo al dejarlo tras un cambio sustancial.
alter table public.novels add column if not exists auto_digest boolean not null default true;

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

-- Resumen global, derivado de las fichas (no del texto). based_on: { chapter_id: revision }.
create table if not exists public.novel_digests (
  novel_id    uuid primary key references public.novels(id) on delete cascade,
  summary     text not null default '',
  based_on    jsonb not null default '{}'::jsonb,
  model       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at automático en las tablas nuevas.
do $$
declare t text;
begin
  foreach t in array array['story_threads', 'chapter_digests', 'novel_digests', 'advisor_conversations', 'advisor_observations'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_row()', t, t);
  end loop;
end $$;

-- Duplicar una novela copia también el interruptor y la lectura del Consejero.
drop function if exists public.duplicate_novel(uuid, text);
create or replace function public.duplicate_novel(p_novel uuid, p_title text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_new uuid := gen_random_uuid();
  m_chap jsonb; m_char jsonb; m_place jsonb; m_fact jsonb; m_asset jsonb; m_mimg jsonb; m_thread jsonb; r record;
  v_ids jsonb; v_text text; r2 record;
  v_copies jsonb;
begin
  insert into public.novels (id, title, synopsis, notes, guide, auto_digest)
  select v_new, p_title, synopsis, notes, guide, auto_digest from public.novels where id = p_novel;
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
    width, height, orientation, sha256, display_path, thumb_path, derived_type)
  select (m_asset ->> a.id::text)::uuid, v_new, 'ready', a.version, a.file_name,
    regexp_replace(a.original_path, '^[^/]+/[^/]+/', v_new || '/' || (m_asset ->> a.id::text) || '/'),
    a.original_type, a.original_bytes, a.width, a.height, a.orientation, a.sha256,
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

  -- Imágenes del manuscrito con ids nuevos, y sus marcadores reescritos en el texto copiado:
  -- cada capítulo de la copia apunta a sus propias imágenes, nunca a las de la original.
  select coalesce(jsonb_object_agg(id, gen_random_uuid()), '{}') into m_mimg
  from public.manuscript_images where novel_id = p_novel;
  insert into public.manuscript_images (id, novel_id, asset_id, chapter_id, alt, decorative, caption, credit,
    layout, align, width_pct)
  select (m_mimg ->> m.id::text)::uuid, v_new, (m_asset ->> m.asset_id::text)::uuid,
    (m_chap ->> m.chapter_id::text)::uuid, m.alt, m.decorative, m.caption, m.credit, m.layout, m.align, m.width_pct
  from public.manuscript_images m where m.novel_id = p_novel;
  for r in select key as old_id, value #>> '{}' as new_id from jsonb_each(m_mimg) loop
    update public.chapters
    set content = regexp_replace(content, '\[\[imagen:' || r.old_id || '\]\]', '[[imagen:' || r.new_id || ']]', 'gi')
    where novel_id = v_new and content ~* ('\[\[imagen:' || r.old_id || '\]\]');
  end loop;

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

revoke execute on function public.duplicate_novel(uuid, text) from public, anon, authenticated;
grant execute on function public.duplicate_novel(uuid, text) to service_role;

-- Privacidad: RLS sin políticas y sin acceso para las claves públicas, como el resto.
do $$
declare t text;
begin
  foreach t in array array['ai_usage', 'story_threads', 'chapter_digests', 'novel_digests',
                           'advisor_conversations', 'advisor_messages', 'advisor_observations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

commit;

-- Que la API de Supabase vea las columnas y tablas nuevas de inmediato.
notify pgrst, 'reload schema';
