-- Crítico Literario, fase 1 (docs/critico.md).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Añade la tabla chapter_critiques (los informes del Crítico, protegida como las demás: RLS,
-- sin acceso público) y el propósito 'critic' en ai_usage. Requiere una base al día con el
-- Consejero (supabase/actualizar-consejero.sql o schema.sql).
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes. El
-- código anterior no usa la tabla, así que se puede aplicar antes de desplegar. Todo en una
-- transacción: si algo falla, no se aplica nada.
--
-- Deshacer (borra los informes del Crítico):
--   drop table if exists public.chapter_critiques;

begin;
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

commit;

-- Que la API de Supabase vea la tabla nueva de inmediato.
notify pgrst, 'reload schema';
