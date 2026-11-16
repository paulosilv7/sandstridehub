-- Descrição e checklist (subtarefas) nas tarefas da Central
alter table public.central_tarefas add column if not exists descricao text check (descricao is null or char_length(descricao) <= 4000);

create table if not exists public.central_tarefa_itens (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid not null references public.central_tarefas(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 300),
  feito boolean not null default false,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists central_tarefa_itens_tarefa_idx on public.central_tarefa_itens (tarefa_id, ordem);
alter table public.central_tarefa_itens enable row level security;

create policy "equipe ve itens da tarefa" on public.central_tarefa_itens for select to authenticated using (public.eh_da_equipe());
create policy "envolvidos criam itens" on public.central_tarefa_itens for insert to authenticated
  with check (exists (select 1 from public.central_tarefas t where t.id = tarefa_id and (t.responsavel_id = auth.uid() or t.criado_por = auth.uid() or public.eh_admin())));
create policy "envolvidos alteram itens" on public.central_tarefa_itens for update to authenticated
  using (exists (select 1 from public.central_tarefas t where t.id = tarefa_id and (t.responsavel_id = auth.uid() or t.criado_por = auth.uid() or public.eh_admin())))
  with check (public.eh_da_equipe());
create policy "envolvidos apagam itens" on public.central_tarefa_itens for delete to authenticated
  using (exists (select 1 from public.central_tarefas t where t.id = tarefa_id and (t.responsavel_id = auth.uid() or t.criado_por = auth.uid() or public.eh_admin())));
