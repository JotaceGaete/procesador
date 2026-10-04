-- Verificación de sólo lectura: qué le falta a una base existente respecto de schema.sql.
-- No modifica nada. Ejecutar en Supabase → SQL Editor antes y después de aplicar schema.sql.
-- Resultado vacío = la base está al día.
with expected(kind, object) as (
  values
    ('tabla', 'novels'), ('tabla', 'chapters'), ('tabla', 'characters'), ('tabla', 'relationships'),
    ('tabla', 'places'), ('tabla', 'facts'), ('tabla', 'fact_characters'), ('tabla', 'assets'),
    ('tabla', 'character_images'), ('tabla', 'manuscript_images'),
    -- Consejero, fases 1 a 4 (la fase 5 no cambió el esquema)
    ('tabla', 'ai_usage'), ('tabla', 'story_threads'), ('tabla', 'chapter_digests'), ('tabla', 'novel_digests'),
    ('tabla', 'advisor_conversations'), ('tabla', 'advisor_messages'), ('tabla', 'advisor_observations'),
    ('columna', 'novels.auto_digest'), ('columna', 'assets.orientation'), ('columna', 'chapters.revision'),
    ('columna', 'facts.status'), ('columna', 'chapter_digests.text_sketch'), ('columna', 'advisor_observations.position'),
    ('función', 'duplicate_novel'), ('función', 'sync_chapter_images'), ('función', 'replace_asset_uses'),
    ('función', 'finalize_asset'), ('función', 'novel_outline'), ('función', 'library')
)
select e.kind, e.object, 'falta' as estado
from expected e
where (e.kind = 'tabla' and to_regclass('public.' || e.object) is null)
   or (e.kind = 'columna' and not exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = split_part(e.object, '.', 1) and column_name = split_part(e.object, '.', 2)))
   or (e.kind = 'función' and not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = e.object))
union all
-- Tablas de la app sin RLS activado (deben tenerlo todas).
select 'rls', c.relname, 'sin RLS'
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  and c.relname in (select object from expected where kind = 'tabla')
union all
-- duplicate_novel debe copiar el interruptor auto_digest (versión de la fase 2 en adelante).
select 'función', 'duplicate_novel', 'versión anterior a la fase 2'
where exists (select 1 from pg_proc where proname = 'duplicate_novel')
  and not exists (select 1 from pg_proc where proname = 'duplicate_novel' and prosrc like '%auto_digest%');
