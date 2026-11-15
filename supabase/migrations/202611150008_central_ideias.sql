-- Caixa de ideias da Central. SQL aplicado via apply_migration `central_ideias`.
create table if not exists public.central_ideias (
  id uuid primary key default gen_random_uuid(),
  texto text not null check (char_length(texto) between 1 and 2000),
  autor_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  estado text not null default 'nova' check (estado in ('nova','organizada','guardada','descartada')),
  proposta jsonb,            -- { resumo, itens: [{ id, tipo, titulo, detalhe, ..., estado }] }
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists central_ideias_estado on public.central_ideias(estado, criado_em desc);
alter table public.central_ideias enable row level security;
create policy "equipe ve ideias" on public.central_ideias for select to authenticated using (eh_da_equipe());
create policy "equipe cria ideia" on public.central_ideias for insert to authenticated with check (eh_da_equipe() and autor_id = auth.uid());
create policy "autor ou admin altera ideia" on public.central_ideias for update to authenticated using (autor_id = auth.uid() or eh_admin()) with check (autor_id = auth.uid() or eh_admin());
create policy "autor ou admin apaga ideia" on public.central_ideias for delete to authenticated using (autor_id = auth.uid() or eh_admin());
