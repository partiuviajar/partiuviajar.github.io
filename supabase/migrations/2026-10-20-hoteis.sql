-- Comparador de hotéis sob demanda + passeios dos destinos.
-- O app grava um pedido em hotel_searches; o gatilho abaixo dispara na hora o workflow
-- "Busca de hotéis" no GitHub (com a mesma chave do despertador do robô), que preenche os resultados.
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

create table if not exists public.hotel_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  city_code text,
  city_name text not null,
  checkin date not null,
  checkout date not null,
  adults int not null default 2 check (adults between 1 and 8),
  kind text not null default 'hotel' check (kind in ('hotel', 'hostel')),
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
    url := 'https://api.github.com/repos/vitorwangg/radar-voos/actions/workflows/hoteis.yml/dispatches',
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

-- Passeios e experiências de cada destino (GetYourGuide, Viator, Civitatis), preparados pelo robô
alter table public.destinations
  add column if not exists experiences jsonb,
  add column if not exists experiences_at timestamptz;
