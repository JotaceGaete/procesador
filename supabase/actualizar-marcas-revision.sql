-- Marcas de revisión: observaciones del autor, separadas del manuscrito y de la memoria de IA.
-- Ejecutar antes de publicar el código de esta rama.
begin;
create table if not exists public.review_marks (
  id uuid primary key default gen_random_uuid(),
  novel_id uuid not null references public.novels(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  category text not null default 'incoherencia'
    check (category in ('incoherencia','continuidad','repeticion','estilo','ortografia','otro')),
  note text not null check (length(trim(note)) between 1 and 4000),
  quote text not null default '',
  start_offset integer not null default 0 check (start_offset >= 0),
  end_offset integer not null default 0 check (end_offset >= start_offset),
  status text not null default 'pending' check (status in ('pending','resolved')),
  origin text not null default 'manual' check (origin in ('manual','ai')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint review_marks_quote_limit check (length(quote) <= 3000)
);
create index if not exists review_marks_novel_status_idx on public.review_marks(novel_id,status,created_at desc);
create index if not exists review_marks_chapter_idx on public.review_marks(chapter_id);
alter table public.review_marks enable row level security;
-- Acceso exclusivo por las rutas autenticadas del servidor con service role.
-- Sin políticas para anon/authenticated: no hay acceso directo desde el navegador.
commit;
