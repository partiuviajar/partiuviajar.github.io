-- Explorar promoções + informações dos destinos.
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

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

alter table public.settings add column if not exists deals_refreshed_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['deals','destinations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;
