-- Estado narrativo por personaje y capítulo (docs/estado-narrativo.md).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Añade la tabla character_states: lo que sabemos de un personaje al terminar un capítulo
-- (dónde está, qué sabe, su estado físico, lo que lleva, si vive). Protegida como las demás:
-- RLS, sin acceso público. Idempotente: se puede ejecutar varias veces y no borra datos.
-- El código anterior no la usa, así que puede aplicarse antes de desplegar.
--
-- Deshacer (borra los estados narrativos):
--   drop table if exists public.character_states;

begin;
-- status: 'approved' (el autor lo aprobó, cuenta como memoria) o 'suggested' (propuesto por la
-- lectura del capítulo, no se usa hasta que se aprueba). Como en facts.
-- No guarda la posición del capítulo: se calcula al leer, así reordenar capítulos no la deja mal.
create table if not exists public.character_states (
  id           uuid primary key default gen_random_uuid(),
  novel_id     uuid not null references public.novels(id) on delete cascade,
  character_id uuid not null,
  chapter_id   uuid not null,
  alive        boolean not null default true,
  location     text not null default '' check (length(location) <= 300),
  knows        text not null default '' check (length(knows) <= 1000),
  physical     text not null default '' check (length(physical) <= 500),
  objects      text not null default '' check (length(objects) <= 500),
  status       text not null default 'approved' check (status in ('approved', 'suggested')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (novel_id, character_id, chapter_id),
  foreign key (character_id, novel_id) references public.characters(id, novel_id) on delete cascade,
  foreign key (chapter_id, novel_id) references public.chapters(id, novel_id) on delete cascade
);
create index if not exists character_states_novel_idx on public.character_states(novel_id);
select public.procesador_secure_table('public.character_states', true);

commit;

-- Que la API de Supabase vea la tabla nueva de inmediato.
notify pgrst, 'reload schema';
