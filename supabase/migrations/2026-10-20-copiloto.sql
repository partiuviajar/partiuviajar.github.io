-- Copiloto ✨: pedidos de sugestão de viagem (questionário → 2 opções que cabem no orçamento).
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

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
