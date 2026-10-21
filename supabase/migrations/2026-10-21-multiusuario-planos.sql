-- Multiusuário + planos (Viajante Iniciante / Viajante Apaixonado / Mochileiro Pro) + painel do administrador.
-- Cada pessoa vê só o que é dela; guias, promoções e passeios são compartilhados.
-- Limites dos planos conferidos no próprio banco. Cadastro livre, mas a conta só funciona depois de aprovada.
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

-- ---------------------------------------------------------------------------
-- Perfis
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  plan text not null default 'basic' check (plan in ('basic', 'silver', 'gold')),
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'pending' check (status in ('pending', 'active', 'blocked')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  notified_at timestamptz            -- o robô já avisou o administrador sobre este cadastro
);

-- dono do app (private.owner) vira administrador com tudo liberado
create or replace function public.is_owner_email(e text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.owner o where lower(o.email) = lower(coalesce(e, '')))
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare own boolean := public.is_owner_email(new.email);
begin
  insert into public.profiles (id, email, name, role, status, plan)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'name', ''),
          case when own then 'admin' else 'user' end,
          case when own then 'active' else 'pending' end,
          case when own then 'gold' else 'basic' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- contas que já existem
insert into public.profiles (id, email, name, role, status, plan, notified_at)
select u.id, u.email, nullif(u.raw_user_meta_data ->> 'name', ''),
       case when public.is_owner_email(u.email) then 'admin' else 'user' end,
       case when public.is_owner_email(u.email) then 'active' else 'pending' end,
       case when public.is_owner_email(u.email) then 'gold' else 'basic' end,
       now()
from auth.users u
on conflict (id) do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.status = 'active')
$$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active')
$$;

-- compatibilidade: as regras antigas chamavam is_owner()
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
$$;

-- plano efetivo (administrador = tudo do Mochileiro Pro)
create or replace function public.plan_of(uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p.role = 'admin' then 'gold' else p.plan end from public.profiles p where p.id = uid
$$;

-- limites de cada plano (o app usa os mesmos números)
create or replace function public.plan_limits(p text) returns jsonb
language sql immutable as $$
  select case p
    when 'gold'   then '{"routes": 10, "copilot_month": 10, "copilot_week": null, "guide_favs": null, "min_interval": 1, "whatsapp": true}'
    when 'silver' then '{"routes": 5,  "copilot_month": 4,  "copilot_week": 1,    "guide_favs": null, "min_interval": 3, "whatsapp": true}'
    else               '{"routes": 2,  "copilot_month": 1,  "copilot_week": null, "guide_favs": 3,    "min_interval": 3, "whatsapp": false}'
  end::jsonb
$$;

-- ---------------------------------------------------------------------------
-- Dono de cada coisa (user_id); o que já existe fica com o administrador
-- ---------------------------------------------------------------------------
do $$
declare t text; owner_id uuid;
begin
  select p.id into owner_id from public.profiles p where p.role = 'admin' order by p.created_at limit 1;
  foreach t in array array['routes', 'push_subscriptions', 'favorites', 'hotel_searches', 'copilot_requests', 'guide_requests'] loop
    execute format('alter table public.%I add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid()', t);
    if owner_id is not null then
      execute format('update public.%I set user_id = %L where user_id is null', t, owner_id);
    end if;
    execute format('create index if not exists %I on public.%I (user_id)', t || '_user_idx', t);
  end loop;
end $$;

-- favoritos: o mesmo item pode ser favorito de pessoas diferentes
alter table public.favorites drop constraint if exists favorites_kind_key_key;
create unique index if not exists favorites_user_kind_key on public.favorites (user_id, kind, key);

-- ---------------------------------------------------------------------------
-- Limites dos planos (conferidos no banco)
-- ---------------------------------------------------------------------------
create or replace function public.limit_active_routes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim jsonb; plan_name text; n int;
begin
  if new.user_id is null then new.user_id := auth.uid(); end if;
  plan_name := coalesce(public.plan_of(new.user_id), 'basic');
  lim := public.plan_limits(plan_name);
  if new.active then
    select count(*) into n from public.routes where active and user_id = new.user_id and id <> new.id;
    if n >= (lim ->> 'routes')::int then
      raise exception 'LIMITE_ROTAS:%:%', plan_name, lim ->> 'routes';
    end if;
  end if;
  if new.check_every_hours < (lim ->> 'min_interval')::int then
    raise exception 'LIMITE_INTERVALO:%:%', plan_name, lim ->> 'min_interval';
  end if;
  return new;
end $$;

drop trigger if exists routes_limit on public.routes;
create trigger routes_limit before insert or update on public.routes
  for each row execute function public.limit_active_routes();

create or replace function public.limit_guide_favorites() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim int; n int; plan_name text;
begin
  if new.user_id is null then new.user_id := auth.uid(); end if;
  if new.kind <> 'guide' then return new; end if;
  plan_name := coalesce(public.plan_of(new.user_id), 'basic');
  lim := (public.plan_limits(plan_name) ->> 'guide_favs')::int;
  if lim is null then return new; end if;
  select count(*) into n from public.favorites where user_id = new.user_id and kind = 'guide';
  if n >= lim then raise exception 'LIMITE_FAVORITOS:%:%', plan_name, lim; end if;
  return new;
end $$;

drop trigger if exists favorites_limit on public.favorites;
create trigger favorites_limit before insert on public.favorites
  for each row execute function public.limit_guide_favorites();

create or replace function public.limit_copilot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim jsonb; plan_name text; n_month int; n_week int;
begin
  if new.user_id is null then new.user_id := auth.uid(); end if;
  plan_name := coalesce(public.plan_of(new.user_id), 'basic');
  lim := public.plan_limits(plan_name);
  select count(*) into n_month from public.copilot_requests
   where user_id = new.user_id and created_at >= date_trunc('month', now()) and status <> 'error';
  if n_month >= (lim ->> 'copilot_month')::int then
    raise exception 'LIMITE_COPILOTO_MES:%:%', plan_name, lim ->> 'copilot_month';
  end if;
  if lim ->> 'copilot_week' is not null then
    select count(*) into n_week from public.copilot_requests
     where user_id = new.user_id and created_at >= date_trunc('week', now()) and status <> 'error';
    if n_week >= (lim ->> 'copilot_week')::int then
      raise exception 'LIMITE_COPILOTO_SEMANA:%:%', plan_name, lim ->> 'copilot_week';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists copilot_limit on public.copilot_requests;
create trigger copilot_limit before insert on public.copilot_requests
  for each row execute function public.limit_copilot();

-- ---------------------------------------------------------------------------
-- Pedidos de upgrade (assistente "Fazer upgrade" → painel do administrador)
-- ---------------------------------------------------------------------------
create table if not exists public.upgrade_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text,
  name text,
  from_plan text,
  to_plan text not null check (to_plan in ('basic', 'silver', 'gold')),
  message text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  handled_at timestamptz,
  notified_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Regras de acesso (RLS)
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.upgrade_requests enable row level security;

do $$
declare t text;
begin
  -- tira as regras antigas "só o dono"
  foreach t in array array['routes','price_observations','price_snapshots','alerts','push_subscriptions','settings','bot_runs',
                           'deals','destinations','hotel_searches','guide_requests','favorites','copilot_requests'] loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('drop policy if exists read_active on public.%I', t);
    execute format('drop policy if exists write_active on public.%I', t);
    execute format('drop policy if exists admin_all on public.%I', t);
  end loop;
  -- o que é de cada pessoa
  foreach t in array array['routes','push_subscriptions','favorites','hotel_searches','copilot_requests'] loop
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = auth.uid() and public.is_active()) with check (user_id = auth.uid() and public.is_active())', t);
  end loop;
  -- compartilhado entre todos os aprovados
  foreach t in array array['deals','destinations','guide_requests'] loop
    execute format('create policy read_active on public.%I for select to authenticated using (public.is_active())', t);
  end loop;
end $$;

-- preços e alertas: de quem é dono da rota
create policy own_rows on public.price_observations for all to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id and r.user_id = auth.uid()) and public.is_active());
create policy own_rows on public.price_snapshots for all to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id and r.user_id = auth.uid()) and public.is_active());
create policy own_rows on public.alerts for all to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id and r.user_id = auth.uid()) and public.is_active());
-- destinos e pedidos de guia: qualquer aprovado pode pedir/preparar
create policy write_active on public.destinations for insert to authenticated with check (public.is_active());
drop policy if exists write_active_upd on public.destinations;
create policy write_active_upd on public.destinations for update to authenticated using (public.is_active()) with check (public.is_active());
create policy write_active on public.guide_requests for insert to authenticated with check (public.is_active());
-- configurações do robô: todos leem (status do robô), só o administrador muda
create policy read_active on public.settings for select to authenticated using (public.is_active());
create policy admin_all on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy admin_all on public.bot_runs for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- perfis: cada um vê o seu; o administrador vê e muda todos
drop policy if exists own_profile on public.profiles;
drop policy if exists admin_all on public.profiles;
create policy own_profile on public.profiles for select to authenticated using (id = auth.uid());
create policy admin_all on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- pedidos de upgrade: cada um cria e vê os seus; o administrador vê e responde todos
drop policy if exists own_rows on public.upgrade_requests;
drop policy if exists admin_all on public.upgrade_requests;
create policy own_rows on public.upgrade_requests for select to authenticated using (user_id = auth.uid());
drop policy if exists own_insert on public.upgrade_requests;
create policy own_insert on public.upgrade_requests for insert to authenticated with check (user_id = auth.uid());
create policy admin_all on public.upgrade_requests for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Funções do app
-- ---------------------------------------------------------------------------
-- último acesso (mostrado no painel do administrador)
create or replace function public.touch_last_seen() returns void
language sql security definer set search_path = '' as $$
  update public.profiles set last_seen_at = now() where id = auth.uid()
$$;

-- painel do administrador: contas com números de uso
create or replace function public.admin_users() returns table (
  id uuid, email text, name text, plan text, role text, status text, created_at timestamptz, last_seen_at timestamptz,
  routes_active int, copilot_month int, guide_favs int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'apenas administrador'; end if;
  return query
  select p.id, p.email, p.name, p.plan, p.role, p.status, p.created_at, p.last_seen_at,
    (select count(*)::int from public.routes r where r.user_id = p.id and r.active),
    (select count(*)::int from public.copilot_requests c where c.user_id = p.id and c.created_at >= date_trunc('month', now())),
    (select count(*)::int from public.favorites f where f.user_id = p.id and f.kind = 'guide')
  from public.profiles p
  order by (p.status = 'pending') desc, p.created_at desc;
end $$;

-- remover uma conta de vez (apaga também as rotas, favoritos etc.)
create or replace function public.admin_delete_user(uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'apenas administrador'; end if;
  if uid = auth.uid() then raise exception 'você não pode remover a própria conta'; end if;
  delete from auth.users where id = uid;
end $$;

-- uso do plano de quem está logado (para mostrar "1 de 2 rotas", cadeados etc.)
create or replace function public.my_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', public.plan_of(auth.uid()),
    'routes_active', (select count(*) from public.routes r where r.user_id = auth.uid() and r.active),
    'copilot_month', (select count(*) from public.copilot_requests c where c.user_id = auth.uid() and c.created_at >= date_trunc('month', now()) and c.status <> 'error'),
    'copilot_week', (select count(*) from public.copilot_requests c where c.user_id = auth.uid() and c.created_at >= date_trunc('week', now()) and c.status <> 'error'),
    'guide_favs', (select count(*) from public.favorites f where f.user_id = auth.uid() and f.kind = 'guide')
  )
$$;
