-- Actualización de una base existente: sesiones con identidad y bloqueo de Procesador
-- por inactividad (docs/privacidad.md, Fase 0).
-- Es la parte nueva de supabase/schema.sql; ejecutar el schema.sql completo también sirve.
--
-- Idempotente: se puede ejecutar varias veces. No borra ni modifica datos existentes:
-- añade tres tablas (cada una protegida justo después de crearse: RLS sin políticas,
-- cerrada a anon y authenticated) y las funciones que usa el servidor. Todo en una
-- transacción: si algo falla, no se aplica nada.
--
-- Al desplegar el código que la usa, las sesiones abiertas dejan de valer (el formato del
-- token cambia) y hay que volver a entrar una vez.

begin;

create or replace function public.touch_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

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

-- <sesiones>
-- ---------------------------------------------------------------------------
-- Sesiones y bloqueo de Procesador (docs/privacidad.md)
-- ---------------------------------------------------------------------------
-- Ajustes de la aplicación: una sola fila. En multiusuario pasará a ser una fila por usuario.
create table if not exists public.app_settings (
  id               boolean primary key default true check (id),
  -- Minutos sin actividad tras los que Procesador se bloquea y pide APP_PASSWORD.
  app_idle_minutes integer not null default 15 check (app_idle_minutes in (15, 30, 60, 120, 240)),
  updated_at       timestamptz not null default now()
);
select public.procesador_secure_table('public.app_settings', true);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- Una fila por inicio de sesión. La cookie lleva su id firmado; cerrar sesión la revoca aquí.
create table if not exists public.app_sessions (
  id               uuid primary key default gen_random_uuid(),
  -- Vacío mientras Procesador tenga un solo usuario; el de Supabase Auth en multiusuario.
  user_id          uuid,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  last_activity_at timestamptz not null default now(),
  -- No nulo: Procesador bloqueado en esta sesión (la cookie sigue valiendo, los datos no).
  app_locked_at    timestamptz,
  revoked_at       timestamptz
);
create index if not exists app_sessions_expires_idx on public.app_sessions(expires_at);
select public.procesador_secure_table('public.app_sessions', false);

-- Intentos fallidos de una credencial: 'app' (entrar, desbloquear, recuperar) o 'novel:<id>'.
create table if not exists public.credential_attempts (
  key           text primary key,
  failures      integer not null default 0,
  blocked_until timestamptz,
  updated_at    timestamptz not null default now()
);
select public.procesador_secure_table('public.credential_attempts', true);

-- Comprueba una sesión y, con p_touch, anota actividad (como mucho cada 30 s).
-- Pasado el plazo de inactividad (más 2 minutos de margen, para que el navegador bloquee
-- antes y alcance a guardar) bloquea Procesador en esa sesión.
-- Devuelve state: 'ok' | 'locked' | 'revoked', y los minutos y milisegundos que quedan.
create or replace function public.session_touch(p_session uuid, p_touch boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare
  s public.app_sessions;
  v_minutes integer := coalesce((select app_idle_minutes from public.app_settings where id), 15);
  v_idle interval := make_interval(mins => v_minutes);
begin
  select * into s from public.app_sessions where id = p_session for update;
  if not found or s.revoked_at is not null or s.expires_at <= now() then
    return jsonb_build_object('state', 'revoked');
  end if;
  if s.app_locked_at is null and s.last_activity_at < now() - v_idle - interval '2 minutes' then
    update public.app_sessions set app_locked_at = now() where id = p_session;
    s.app_locked_at := now();
  end if;
  if s.app_locked_at is not null then
    return jsonb_build_object('state', 'locked', 'idle_minutes', v_minutes);
  end if;
  if p_touch and s.last_activity_at < now() - interval '30 seconds' then
    update public.app_sessions set last_activity_at = now() where id = p_session;
    s.last_activity_at := now();
  end if;
  return jsonb_build_object('state', 'ok', 'idle_minutes', v_minutes,
    'remaining_ms', greatest(0, floor(extract(epoch from s.last_activity_at + v_idle - now()) * 1000))::bigint);
end $$;

-- «Bloquear Procesador» (true) o desbloquearlo tras comprobar APP_PASSWORD (false).
create or replace function public.session_set_locked(p_session uuid, p_locked boolean)
returns void language plpgsql set search_path = '' as $$
begin
  update public.app_sessions
     set app_locked_at = case when p_locked then coalesce(app_locked_at, now()) end,
         last_activity_at = now()
   where id = p_session and revoked_at is null;
end $$;

-- Cierra una sesión para siempre.
create or replace function public.session_revoke(p_session uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.app_sessions set revoked_at = coalesce(revoked_at, now()) where id = p_session;
end $$;

-- Un intento fallido. A partir del quinto, espera de 30 s que se duplica hasta 15 minutos.
-- Devuelve hasta cuándo queda bloqueada la credencial (null: puede reintentar ya).
create or replace function public.credential_failure(p_key text)
returns timestamptz language sql set search_path = '' as $$
  insert into public.credential_attempts as a (key, failures) values (p_key, 1)
  on conflict (key) do update set
    failures = a.failures + 1,
    blocked_until = case when a.failures + 1 >= 5
      then now() + least(interval '15 minutes', interval '30 seconds' * power(2, a.failures + 1 - 5))
      end
  returning blocked_until;
$$;

-- Un acierto borra el historial de fallos.
create or replace function public.credential_success(p_key text)
returns void language sql set search_path = '' as $$
  delete from public.credential_attempts where key = p_key;
$$;

-- Limpieza, al entrar: sesiones caducadas o cerradas hace más de un día, y fallos viejos.
create or replace function public.purge_sessions()
returns void language sql set search_path = '' as $$
  delete from public.app_sessions where expires_at < now() or revoked_at < now() - interval '1 day';
  delete from public.credential_attempts
   where updated_at < now() - interval '1 day' and (blocked_until is null or blocked_until < now());
$$;

revoke execute on function public.session_touch(uuid, boolean), public.session_set_locked(uuid, boolean),
  public.session_revoke(uuid), public.credential_failure(text), public.credential_success(text),
  public.purge_sessions() from public, anon, authenticated;
grant execute on function public.session_touch(uuid, boolean), public.session_set_locked(uuid, boolean),
  public.session_revoke(uuid), public.credential_failure(text), public.credential_success(text),
  public.purge_sessions() to service_role;
-- </sesiones>

commit;
