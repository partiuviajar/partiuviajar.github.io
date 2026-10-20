-- Filtro de estrelas na busca de hotéis.
-- Cole no SQL Editor do Supabase e clique em Run. Pode rodar de novo sem problema.
alter table public.hotel_searches add column if not exists stars int check (stars between 1 and 5);
