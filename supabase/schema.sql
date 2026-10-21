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
-- Explorar e destinos (mesmo conteúdo de supabase/migrations/2026-10-20-explorar-destinos.sql)
-- ---------------------------------------------------------------------------
-- Promoções saindo das suas origens (o robô atualiza a cada 6 h)
create table if not exists public.deals (
  id bigint generated always as identity primary key,
  origin text not null,
  destination text not null,
  destination_label text,
  country_code text,
  country_name text,
  depart_date date not null,
  return_date date,
  price numeric not null,
  airline text,
  stops int,
  link text,
  found_at timestamptz not null default now()
);
create index if not exists deals_origin on public.deals (origin, price);

-- Destinos: foto, resumo, pontos turísticos, moeda, idioma, tomada (o robô prepara)
create table if not exists public.destinations (
  code text primary key,                -- código IATA da cidade/aeroporto
  name text,
  country_code text,
  country_name text,
  lat double precision,
  lon double precision,
  qid text,                             -- item do Wikidata
  wiki_url text,
  summary text,
  image text,
  thumb text,
  facts jsonb,                          -- moeda, idiomas, tomadas, voltagem
  attractions jsonb,                    -- pontos turísticos
  attractions_at timestamptz,
  attractions_requested_at timestamptz, -- o app pede; o robô prepara na próxima rodada
  updated_at timestamptz
);
alter table public.destinations
  add column if not exists experiences jsonb,             -- passeios (GetYourGuide, Viator, Civitatis)
  add column if not exists experiences_at timestamptz;

alter table public.settings add column if not exists deals_refreshed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Comparador de hotéis (mesmo conteúdo de supabase/migrations/2026-10-20-hoteis.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.hotel_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  city_code text,
  city_name text not null,
  checkin date not null,
  checkout date not null,
  adults int not null default 2 check (adults between 1 and 8),
  kind text not null default 'hotel' check (kind in ('hotel', 'hostel')),
  stars int check (stars between 1 and 5),         -- só hotéis com essa categoria (null = qualquer)
  status text not null default 'pending',   -- pending | running | done | error
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  results jsonb,
  constraint hotel_dates check (checkout > checkin and checkout - checkin <= 30)
);
create index if not exists hotel_searches_lookup on public.hotel_searches (city_name, checkin, checkout, adults, kind, created_at desc);

alter table public.hotel_searches enable row level security;
drop policy if exists owner_all on public.hotel_searches;
create policy owner_all on public.hotel_searches for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace function public.dispatch_hotel_search() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://api.github.com/repos/partiuviajar/partiuviajar.github.io/actions/workflows/hoteis.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'radar-voos',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('search', new.id::text))
  );
  return new;
end $$;

drop trigger if exists hotel_search_dispatch on public.hotel_searches;
create trigger hotel_search_dispatch after insert on public.hotel_searches
  for each row execute function public.dispatch_hotel_search();

-- ---------------------------------------------------------------------------
-- Guias sob demanda e favoritos (mesmo conteúdo de supabase/migrations/2026-10-20-guias-favoritos.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.guide_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null,                 -- código IATA da cidade
  name text,
  status text not null default 'pending',   -- pending | running | done | error
  ready_at timestamptz,
  error text
);
create index if not exists guide_requests_code on public.guide_requests (code, created_at desc);

create table if not exists public.favorites (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('guide', 'tour', 'hotel')),
  key text not null,                  -- código da cidade, link do passeio ou nome+cidade do hotel
  title text not null,
  subtitle text,
  photo text,
  link text,
  data jsonb,
  unique (kind, key)
);

-- ao pedir um guia, aciona na hora o workflow "Preparar guia" (mesma chave do despertador do robô)
create or replace function public.dispatch_guide_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://api.github.com/repos/partiuviajar/partiuviajar.github.io/actions/workflows/guia.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'radar-voos',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('request', new.id::text))
  );
  return new;
end $$;

drop trigger if exists guide_request_dispatch on public.guide_requests;
create trigger guide_request_dispatch after insert on public.guide_requests
  for each row execute function public.dispatch_guide_request();

-- ---------------------------------------------------------------------------
-- Copiloto (mesmo conteúdo de supabase/migrations/2026-10-20-copiloto.sql)
-- ---------------------------------------------------------------------------
create table if not exists public.copilot_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  answers jsonb not null,             -- respostas do questionário
  status text not null default 'pending',   -- pending | running | done | error
  stage text,                         -- etapa atual, mostrada na tela de espera
  result jsonb,
  error text,
  finished_at timestamptz
);
create index if not exists copilot_requests_created on public.copilot_requests (created_at desc);

alter table public.copilot_requests enable row level security;
drop policy if exists owner_all on public.copilot_requests;
create policy owner_all on public.copilot_requests for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace function public.dispatch_copilot_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://api.github.com/repos/partiuviajar/partiuviajar.github.io/actions/workflows/copiloto.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'radar-voos',
      'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('request', new.id::text))
  );
  return new;
end $$;

drop trigger if exists copilot_request_dispatch on public.copilot_requests;
create trigger copilot_request_dispatch after insert on public.copilot_requests
  for each row execute function public.dispatch_copilot_request();

-- ---------------------------------------------------------------------------
-- Segurança: só o dono acessa pelo app. O robô usa a chave secreta (ignora RLS).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['routes','price_observations','price_snapshots','alerts','push_subscriptions','settings','bot_runs','deals','destinations','hotel_searches','guide_requests','favorites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

revoke all on public.route_trend, public.route_latest from anon;
grant select on public.route_trend, public.route_latest to authenticated;
