-- Pedidos de guia sob demanda + favoritos (guias, passeios e hospedagens).
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

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

do $$
declare t text;
begin
  foreach t in array array['guide_requests','favorites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- ao pedir um guia, aciona na hora o workflow "Preparar guia" (mesma chave do despertador do robô)
create or replace function public.dispatch_guide_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://api.github.com/repos/vitorwangg/radar-voos/actions/workflows/guia.yml/dispatches',
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
