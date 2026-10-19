-- Radar de Voos: estrutura do banco (Supabase / Postgres)
-- Cole tudo no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

create extension if not exists pgcrypto;

-- Dono do app: só os e-mails em private.owner conseguem ler e alterar dados pelo app.
-- (fica fora do código para o e-mail não aparecer no GitHub)
-- Para cadastrar:  insert into private.owner (email) values ('seu@email.com');
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.owner (email text primary key);

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.owner o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

-- ---------------------------------------------------------------------------
-- Rotas monitoradas (no máximo 10 ativas)
-- ---------------------------------------------------------------------------
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  origin text not null,                 -- código IATA (aeroporto ou cidade)
  destination text not null,
  origin_label text,
  destination_label text,
  trip_type text not null default 'round_trip' check (trip_type in ('round_trip', 'one_way')),
  date_mode text not null default 'fixed' check (date_mode in ('fixed', 'month')),
  depart_date date,                     -- data fixa: ida
  return_date date,                     -- data fixa: volta
  month date,                           -- mês inteiro: primeiro dia do mês
  stay_days int check (stay_days between 1 and 60), -- mês inteiro + ida e volta
  adults int not null default 1 check (adults between 1 and 9),
  max_stops int check (max_stops between 0 and 2), -- null = qualquer
  threshold_pct int not null default 15 check (threshold_pct between 3 and 60),
  target_price numeric,                 -- opcional: avisar abaixo deste valor
  check_every_hours int not null default 3 check (check_every_hours between 1 and 24),
  active boolean not null default true,
  last_checked_at timestamptz,
  check_requested_at timestamptz,
  last_error text,
  constraint fixed_dates check (date_mode <> 'fixed' or depart_date is not null),
  constraint fixed_return check (date_mode <> 'fixed' or trip_type = 'one_way' or return_date is not null),
  constraint month_set check (date_mode <> 'month' or month is not null),
  constraint month_stay check (date_mode <> 'month' or trip_type = 'one_way' or stay_days is not null)
);

create or replace function public.limit_active_routes() returns trigger
language plpgsql as $$
begin
  if new.active and (
    select count(*) from public.routes where active and id <> new.id
  ) >= 10 then
    raise exception 'Limite de 10 rotas ativas atingido. Pause ou apague uma rota antes.';
  end if;
  return new;
end $$;

drop trigger if exists routes_limit on public.routes;
create trigger routes_limit before insert or update on public.routes
  for each row execute function public.limit_active_routes();

-- ---------------------------------------------------------------------------
-- Preços brutos, um por fonte e por data, a cada verificação
-- ---------------------------------------------------------------------------
create table if not exists public.price_observations (
  id bigint generated always as identity primary key,
  route_id uuid not null references public.routes(id) on delete cascade,
  observed_at timestamptz not null default now(),
  source text not null,                 -- 'google' | 'aviasales'
  depart_date date not null,
  return_date date,
  price numeric not null,
  airline text,
  stops int,
  duration_min int,
  link text
);
create index if not exists price_obs_route_date on public.price_observations (route_id, depart_date, observed_at desc);

-- ---------------------------------------------------------------------------
-- Melhor preço por data em cada verificação (já com o "preço normal")
-- ---------------------------------------------------------------------------
create table if not exists public.price_snapshots (
  id bigint generated always as identity primary key,
  route_id uuid not null references public.routes(id) on delete cascade,
  checked_at timestamptz not null,
  depart_date date not null,
  return_date date,
  price numeric not null,
  normal_price numeric,
  source text not null,
  airline text,
  stops int,
  link text
);
create index if not exists price_snap_route on public.price_snapshots (route_id, checked_at desc);
create index if not exists price_snap_route_date on public.price_snapshots (route_id, depart_date, checked_at desc);

-- Menor preço de cada verificação (para o gráfico)
create or replace view public.route_trend with (security_invoker = on) as
select route_id, checked_at, min(price) as best_price, min(normal_price) filter (where normal_price is not null) as normal_price
from public.price_snapshots
group by route_id, checked_at;

-- Último preço conhecido de cada data (para o calendário)
create or replace view public.route_latest with (security_invoker = on) as
select distinct on (route_id, depart_date, return_date) *
from public.price_snapshots
order by route_id, depart_date, return_date, checked_at desc;

-- ---------------------------------------------------------------------------
-- Alertas enviados
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  route_id uuid not null references public.routes(id) on delete cascade,
  created_at timestamptz not null default now(),
  depart_date date not null,
  return_date date,
  price numeric not null,
  normal_price numeric,
  pct_below numeric,
  reasons text[] not null default '{}',
  source text,
  airline text,
  link text,
  channels text[] not null default '{}'
);
create index if not exists alerts_route on public.alerts (route_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Aparelhos que recebem notificação do app (PWA)
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Preferências (linha única)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  notify_whatsapp boolean not null default true,
  notify_push boolean not null default true,
  notify_telegram boolean not null default true,
  test_requested_at timestamptz,
  test_done_at timestamptz,
  bot_heartbeat_at timestamptz,         -- última vez que o robô rodou
  bot_channels jsonb                    -- canais configurados no robô
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Histórico de execuções do robô
-- ---------------------------------------------------------------------------
create table if not exists public.bot_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',  -- running | ok | partial | error
  summary text
);

-- ---------------------------------------------------------------------------
-- Viagem longa (mesmo conteúdo de supabase/migrations/2026-10-19-viagem-longa.sql)
-- ---------------------------------------------------------------------------
alter table public.routes
  add column if not exists depart_from date,          -- viagem longa: primeiro dia possível de ida
  add column if not exists depart_to date,            -- viagem longa: último dia possível de ida
  add column if not exists min_stay int,              -- volta no mínimo X dias depois da ida
  add column if not exists max_stay int,              -- volta no máximo Y dias depois da ida
  add column if not exists track_direct boolean not null default false; -- acompanha só diretos em separado

alter table public.routes drop constraint if exists routes_date_mode_check;
alter table public.routes add constraint routes_date_mode_check check (date_mode in ('fixed', 'month', 'long'));
alter table public.routes drop constraint if exists long_dates;
alter table public.routes add constraint long_dates
  check (date_mode <> 'long' or (depart_from is not null and depart_to >= depart_from));
alter table public.routes drop constraint if exists long_stay;
alter table public.routes add constraint long_stay
  check (date_mode <> 'long' or trip_type = 'one_way' or (max_stay between 1 and 330 and coalesce(min_stay, 1) between 1 and max_stay));

-- trecho do preço: null = rota comum; out = só ida; back = só volta; rt = ida e volta; combo = soma de ida + volta
alter table public.price_observations add column if not exists leg text;
alter table public.price_snapshots
  add column if not exists leg text,
  add column if not exists direct_only boolean not null default false;
alter table public.alerts
  add column if not exists leg text,
  add column if not exists direct_only boolean not null default false;
create index if not exists price_snap_route_leg on public.price_snapshots (route_id, leg, checked_at desc);

-- Último preço conhecido de cada data (para o calendário)
create or replace view public.route_latest with (security_invoker = on) as
select distinct on (route_id, leg, direct_only, depart_date, return_date) *
from public.price_snapshots
order by route_id, leg, direct_only, depart_date, return_date, checked_at desc;

-- Menor preço de cada verificação (para o gráfico); na viagem longa, o menor total da viagem
create or replace view public.route_trend with (security_invoker = on) as
select route_id, checked_at,
  min(price) as best_price,
  min(normal_price) filter (where normal_price is not null and (leg is null or leg = 'combo')) as normal_price
from public.price_snapshots
where not direct_only and (leg is null or leg in ('rt', 'combo'))
group by route_id, checked_at;

-- ---------------------------------------------------------------------------
-- Segurança: só o dono acessa pelo app. O robô usa a chave secreta (ignora RLS).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['routes','price_observations','price_snapshots','alerts','push_subscriptions','settings','bot_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

revoke all on public.route_trend, public.route_latest from anon;
grant select on public.route_trend, public.route_latest to authenticated;
