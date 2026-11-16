-- Código de autorização do dia do Mercado Livre (coletas/devoluções): chega por e-mail em cada loja,
-- um script no Gmail da loja envia para a função ml-codigo-receber, que grava aqui. A equipe só lê.
create table if not exists public.ml_codigos_dia (
  id uuid primary key default gen_random_uuid(),
  loja_id uuid not null references public.lojas(id) on delete cascade,
  dia date not null,
  codigo text not null check (codigo ~ '^[A-Za-z0-9]{4,16}$'),
  recebido_em timestamptz not null default now(),
  unique (loja_id, dia)
);
alter table public.ml_codigos_dia enable row level security;
create policy "equipe ve codigos do dia" on public.ml_codigos_dia for select to authenticated using (public.eh_da_equipe());
-- sem política de escrita: só a função (service role) grava

-- segredo que o script do Gmail envia; sem política = ninguém lê pela API pública
create table if not exists public.ml_codigo_segredo (id int primary key default 1 check (id = 1), valor text not null);
alter table public.ml_codigo_segredo enable row level security;
insert into public.ml_codigo_segredo (valor)
select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
where not exists (select 1 from public.ml_codigo_segredo);
