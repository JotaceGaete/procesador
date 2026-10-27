-- Verificación de solo lectura tras ejecutar actualizar-marcas-revision.sql
select 'tabla review_marks ausente' as problema
where to_regclass('public.review_marks') is null
union all
select 'RLS no habilitada'
where exists (select 1 from pg_class where oid=to_regclass('public.review_marks') and not relrowsecurity)
union all
select 'política de acceso directo inesperada'
where exists (select 1 from pg_policies where schemaname='public' and tablename='review_marks')
union all
select 'índice novel/status ausente'
where not exists (select 1 from pg_indexes where schemaname='public' and tablename='review_marks' and indexname='review_marks_novel_status_idx');
-- Resultado esperado: Success. No rows returned.
