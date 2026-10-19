-- Modo "Viagem longa": ida numa janela de datas, volta entre X e Y dias depois.
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

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
