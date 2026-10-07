-- Actualización de una base existente: novelas protegidas (docs/privacidad.md, Fase 1).
-- Requiere supabase/actualizar-sesiones.sql (Fase 0) aplicado antes.
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes:
-- añade dos tablas (protegidas al crearse: RLS sin políticas, cerradas a anon y
-- authenticated), un trigger en app_sessions y las funciones que usa el servidor.
-- library() y duplicate_novel() no cambian: library(uuid) y duplicate_novel_with_protection()
-- son nuevas, así que el código anterior sigue funcionando con la base ya actualizada.
-- Todo en una transacción: si algo falla, no se aplica nada.

begin;

do $$ begin
  if to_regclass('public.app_sessions') is null then
    raise exception 'Falta supabase/actualizar-sesiones.sql: ejecútalo antes (o ejecuta schema.sql completo).';
  end if;
end $$;

-- <protegidas-tablas>
-- ---------------------------------------------------------------------------
-- Novelas protegidas (docs/privacidad.md): tablas
-- ---------------------------------------------------------------------------
-- La credencial de una novela protegida. Nunca el PIN: su hash scrypt (con pepper del servidor).
create table if not exists public.novel_protection (
  novel_id           uuid primary key references public.novels(id) on delete cascade,
  secret_hash        text not null,
  secret_kind        text not null check (secret_kind in ('pin', 'password')),
  pepper_version     smallint not null default 1,
  -- Sube al cambiar el PIN: los desbloqueos anteriores dejan de valer.
  credential_version integer not null default 1,
  idle_minutes       integer not null default 15 check (idle_minutes in (5, 15, 30, 60)),
  lock_on_hide       boolean not null default false,
  hide_title         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
select public.procesador_secure_table('public.novel_protection', true);

-- Una novela desbloqueada en una sesión. Bloquear es borrar la fila.
create table if not exists public.novel_unlocks (
  session_id          uuid not null references public.app_sessions(id) on delete cascade,
  novel_id            uuid not null references public.novels(id) on delete cascade,
  credential_version  integer not null,
  unlocked_at         timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  -- Como mucho 8 horas seguidas, aunque haya actividad.
  absolute_expires_at timestamptz not null,
  primary key (session_id, novel_id)
);
create index if not exists novel_unlocks_novel_idx on public.novel_unlocks(novel_id);
select public.procesador_secure_table('public.novel_unlocks', false);

-- Bloquear Procesador o cerrar la sesión vuelve a bloquear todas sus novelas.
create or replace function public.forget_session_unlocks() returns trigger
language plpgsql set search_path = '' as $$
begin
  delete from public.novel_unlocks where session_id = new.id;
  return new;
end $$;
drop trigger if exists app_sessions_forget_unlocks on public.app_sessions;
create trigger app_sessions_forget_unlocks after update of app_locked_at, revoked_at on public.app_sessions
  for each row when ((old.app_locked_at is null and new.app_locked_at is not null)
                     or (old.revoked_at is null and new.revoked_at is not null))
  execute function public.forget_session_unlocks();
revoke execute on function public.forget_session_unlocks() from public, anon, authenticated;
-- </protegidas-tablas>

-- <protegidas-funciones>
-- ---------------------------------------------------------------------------
-- Novelas protegidas (docs/privacidad.md): funciones del servidor
-- ---------------------------------------------------------------------------

-- ¿Puede esta sesión usar la novela? state: 'open' (sin protección) · 'unlocked' · 'locked'.
-- Un desbloqueo vencido (inactividad + 2 min de margen, 8 h, PIN cambiado) se borra.
-- Con p_touch anota actividad (como mucho cada 30 s). Bloqueada, devuelve sólo lo que la
-- pantalla de desbloqueo muestra: el título (salvo si está oculto) y el tipo de credencial.
create or replace function public.novel_access(p_session uuid, p_novel uuid, p_touch boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  -- record, not %rowtype: the function is created even where the tables don't exist yet.
  p record;
  u record;
  v_idle interval;
  v_locked jsonb;
begin
  select * into p from public.novel_protection where novel_id = p_novel;
  if not found then return jsonb_build_object('state', 'open'); end if;
  v_idle := make_interval(mins => p.idle_minutes);
  v_locked := jsonb_build_object('state', 'locked', 'kind', p.secret_kind, 'hide_title', p.hide_title,
    'title', case when p.hide_title then null else (select title from public.novels where id = p_novel) end);
  select * into u from public.novel_unlocks where session_id = p_session and novel_id = p_novel for update;
  if not found then return v_locked; end if;
  if u.credential_version <> p.credential_version or u.absolute_expires_at <= now()
     or u.last_activity_at < now() - v_idle - interval '2 minutes' then
    delete from public.novel_unlocks where session_id = p_session and novel_id = p_novel;
    return v_locked;
  end if;
  if p_touch and u.last_activity_at < now() - interval '30 seconds' then
    update public.novel_unlocks set last_activity_at = now() where session_id = p_session and novel_id = p_novel;
    u.last_activity_at := now();
  end if;
  return jsonb_build_object('state', 'unlocked', 'kind', p.secret_kind, 'hide_title', p.hide_title,
    'idle_minutes', p.idle_minutes, 'lock_on_hide', p.lock_on_hide,
    'remaining_ms', greatest(0, floor(extract(epoch from least(u.last_activity_at + v_idle, u.absolute_expires_at) - now()) * 1000))::bigint);
end $$;

-- Tras comprobar el PIN (en el servidor): la novela queda desbloqueada en esta sesión.
create or replace function public.novel_unlock(p_session uuid, p_novel uuid)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.novel_unlocks (session_id, novel_id, credential_version, absolute_expires_at)
  select p_session, p_novel, credential_version, now() + interval '8 hours'
  from public.novel_protection where novel_id = p_novel
  on conflict (session_id, novel_id) do update
    set credential_version = excluded.credential_version, unlocked_at = now(), last_activity_at = now(),
        absolute_expires_at = excluded.absolute_expires_at;
end $$;

-- Proteger una novela, o cambiar su PIN: el hash nuevo invalida todo desbloqueo anterior
-- (en cualquier sesión y dispositivo) y deja la novela desbloqueada sólo en esta sesión.
create or replace function public.novel_protect(p_session uuid, p_novel uuid, p_hash text, p_kind text, p_pepper smallint)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.novel_protection (novel_id, secret_hash, secret_kind, pepper_version)
  values (p_novel, p_hash, p_kind, p_pepper)
  on conflict (novel_id) do update
    set secret_hash = excluded.secret_hash, secret_kind = excluded.secret_kind,
        pepper_version = excluded.pepper_version,
        credential_version = public.novel_protection.credential_version + 1;
  delete from public.novel_unlocks where novel_id = p_novel;
  perform public.novel_unlock(p_session, p_novel);
end $$;

-- Quitar la protección (con el PIN, o con APP_PASSWORD como recuperación).
create or replace function public.novel_unprotect(p_novel uuid)
returns void language plpgsql set search_path = '' as $$
begin
  delete from public.novel_unlocks where novel_id = p_novel;
  delete from public.novel_protection where novel_id = p_novel;
end $$;

-- Biblioteca para una sesión: las novelas bloqueadas no dicen cuánto tienen, y las de título
-- oculto no dicen cómo se llaman. Una por una, con la misma regla que novel_access.
create or replace function public.library(p_session uuid)
returns table (id uuid, title text, updated_at timestamptz, chapters integer, words integer,
               protected boolean, locked boolean, title_hidden boolean)
language plpgsql stable set search_path = '' as $$
begin
  return query
  select l.id,
         case when p.hide_title then null else l.title end,
         l.updated_at,
         case when p.novel_id is null or u.novel_id is not null then l.chapters end,
         case when p.novel_id is null or u.novel_id is not null then l.words end,
         p.novel_id is not null,
         p.novel_id is not null and u.novel_id is null,
         coalesce(p.hide_title, false)
  from public.library() l
  left join public.novel_protection p on p.novel_id = l.id
  left join public.novel_unlocks u
    on u.novel_id = l.id and u.session_id = p_session
   and u.credential_version = p.credential_version and u.absolute_expires_at > now()
   and u.last_activity_at > now() - make_interval(mins => p.idle_minutes) - interval '2 minutes'
  order by l.updated_at desc;
end $$;

-- Duplicar una novela protegida: la copia nace protegida con el mismo PIN y opciones, en la
-- misma transacción (nunca existe una copia sin proteger), y bloqueada.
create or replace function public.duplicate_novel_with_protection(p_novel uuid, p_title text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_result jsonb := public.duplicate_novel(p_novel, p_title);
begin
  if v_result is not null then
    insert into public.novel_protection (novel_id, secret_hash, secret_kind, pepper_version, idle_minutes,
                                         lock_on_hide, hide_title)
    select (v_result ->> 'id')::uuid, secret_hash, secret_kind, pepper_version, idle_minutes, lock_on_hide, hide_title
    from public.novel_protection where novel_id = p_novel;
  end if;
  return v_result;
end $$;

revoke execute on function public.novel_access(uuid, uuid, boolean),
  public.novel_unlock(uuid, uuid), public.novel_protect(uuid, uuid, text, text, smallint),
  public.novel_unprotect(uuid), public.library(uuid), public.duplicate_novel_with_protection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.novel_access(uuid, uuid, boolean), public.novel_unlock(uuid, uuid),
  public.novel_protect(uuid, uuid, text, text, smallint), public.novel_unprotect(uuid), public.library(uuid),
  public.duplicate_novel_with_protection(uuid, text)
  to service_role;
-- </protegidas-funciones>

commit;
