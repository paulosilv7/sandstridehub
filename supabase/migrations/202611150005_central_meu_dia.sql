-- Central "Meu dia": rotina por pessoa, tarefas com responsável e metas do mês.
create table if not exists public.central_rotinas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  titulo text not null check (char_length(titulo) between 1 and 120),
  dias smallint[] not null default '{0,1,2,3,4,5,6}',  -- 0 = domingo ... 6 = sábado
  ordem int not null default 0,
  ativo boolean not null default true,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now()
);
create table if not exists public.central_rotina_feitos (
  rotina_id uuid not null references public.central_rotinas(id) on delete cascade,
  dia date not null,
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  feito_em timestamptz not null default now(),
  primary key (rotina_id, dia)
);
create table if not exists public.central_tarefas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (char_length(titulo) between 1 and 160),
  responsavel_id uuid not null references auth.users(id) on delete cascade,
  criado_por uuid not null default auth.uid(),
  prazo date,
  app text,
  feita_em timestamptz,
  criado_em timestamptz not null default now()
);
create table if not exists public.central_metas (
  id uuid primary key default gen_random_uuid(),
  mes date not null,                       -- primeiro dia do mês
  titulo text not null check (char_length(titulo) between 1 and 80),
  unidade text not null default 'un' check (unidade in ('un','reais','pct')),
  alvo numeric not null check (alvo > 0),
  atual numeric not null default 0,
  responsavel_id uuid references auth.users(id) on delete set null,
  criado_por uuid default auth.uid(),
  atualizado_em timestamptz not null default now()
);
create index if not exists central_rotinas_usuario on public.central_rotinas(usuario_id) where ativo;
create index if not exists central_feitos_dia on public.central_rotina_feitos(dia);
create index if not exists central_tarefas_resp on public.central_tarefas(responsavel_id) where feita_em is null;
create index if not exists central_metas_mes on public.central_metas(mes);

alter table public.central_rotinas enable row level security;
alter table public.central_rotina_feitos enable row level security;
alter table public.central_tarefas enable row level security;
alter table public.central_metas enable row level security;

-- rotina: a equipe enxerga; cada um mexe na sua e o administrador em todas
create policy "equipe ve rotinas" on public.central_rotinas for select to authenticated using (eh_da_equipe());
create policy "dono ou admin cria rotina" on public.central_rotinas for insert to authenticated with check (eh_da_equipe() and (usuario_id = auth.uid() or eh_admin()));
create policy "dono ou admin altera rotina" on public.central_rotinas for update to authenticated using (usuario_id = auth.uid() or eh_admin()) with check (usuario_id = auth.uid() or eh_admin());
create policy "dono ou admin apaga rotina" on public.central_rotinas for delete to authenticated using (usuario_id = auth.uid() or eh_admin());

-- marcações: só o dono da rotina marca e desmarca
create policy "equipe ve marcacoes" on public.central_rotina_feitos for select to authenticated using (eh_da_equipe());
create policy "dono marca" on public.central_rotina_feitos for insert to authenticated with check (usuario_id = auth.uid() and exists (select 1 from public.central_rotinas r where r.id = rotina_id and r.usuario_id = auth.uid()));
create policy "dono desmarca" on public.central_rotina_feitos for delete to authenticated using (usuario_id = auth.uid());

-- tarefas: a equipe enxerga e cria; responsável, quem criou ou administrador altera e apaga
create policy "equipe ve tarefas" on public.central_tarefas for select to authenticated using (eh_da_equipe());
create policy "equipe cria tarefa" on public.central_tarefas for insert to authenticated with check (eh_da_equipe() and criado_por = auth.uid());
create policy "envolvidos alteram tarefa" on public.central_tarefas for update to authenticated using (responsavel_id = auth.uid() or criado_por = auth.uid() or eh_admin()) with check (eh_da_equipe());
create policy "envolvidos apagam tarefa" on public.central_tarefas for delete to authenticated using (criado_por = auth.uid() or eh_admin());

-- metas: a equipe enxerga; só administrador cria, altera e apaga
create policy "equipe ve metas" on public.central_metas for select to authenticated using (eh_da_equipe());
create policy "admin cria meta" on public.central_metas for insert to authenticated with check (eh_admin());
create policy "admin altera meta" on public.central_metas for update to authenticated using (eh_admin()) with check (eh_admin());
create policy "admin apaga meta" on public.central_metas for delete to authenticated using (eh_admin());
