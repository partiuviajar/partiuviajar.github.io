-- Guia Local 📸: foto ou nome de um lugar → a história contada como guia (função guia-local).
-- local_places: lugares já explicados, compartilhados entre todos (economiza a IA).
-- local_visits: o histórico de cada pessoa ("Seus lugares").
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.

-- banco ainda sem multiusuário: "conta ativa" = o dono do app (a migração de multiusuário substitui esta função)
do $$ begin
  if to_regprocedure('public.is_active()') is null then
    execute 'create function public.is_active() returns boolean language sql stable security definer set search_path = '' as $f$ select public.is_owner() $f$';
  end if;
end $$;

create table if not exists public.local_places (
  key text primary key,               -- "pt:Escadaria Selarón" (idioma:título da Wikipédia)
  title text not null,
  data jsonb not null,                -- o guia pronto (história, destaques, fotos, dicas…)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.local_visits (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  place_key text not null,
  title text not null,
  subtitle text,
  photo text,
  mode text,                          -- photo | text | nearby
  query text
);
create index if not exists local_visits_user on public.local_visits (user_id, created_at desc);

alter table public.local_places enable row level security;
drop policy if exists read_active on public.local_places;
drop policy if exists write_active on public.local_places;
drop policy if exists write_active_upd on public.local_places;
create policy read_active on public.local_places for select to authenticated using (public.is_active());
create policy write_active on public.local_places for insert to authenticated with check (public.is_active());
create policy write_active_upd on public.local_places for update to authenticated using (public.is_active()) with check (public.is_active());

alter table public.local_visits enable row level security;
drop policy if exists own_rows on public.local_visits;
create policy own_rows on public.local_visits for all to authenticated
  using (user_id = auth.uid() and public.is_active()) with check (user_id = auth.uid() and public.is_active());

-- favoritos também guardam lugares do Guia Local
alter table public.favorites drop constraint if exists favorites_kind_check;
alter table public.favorites add constraint favorites_kind_check check (kind in ('guide', 'tour', 'hotel', 'local'));
