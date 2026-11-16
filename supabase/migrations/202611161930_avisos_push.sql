-- Avisos no aparelho (Web Push): inscrições, preferências, chaves e gatilhos.
create table if not exists public.push_chaves (
  id smallint primary key default 1 check (id = 1),
  publica text not null, privada text not null, criado_em timestamptz not null default now());
alter table public.push_chaves enable row level security;  -- sem políticas: só a função de envio (service role) lê

create table if not exists public.push_inscricoes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid(),
  endpoint text not null unique, p256dh text not null, auth text not null,
  agente text, criado_em timestamptz not null default now());
alter table public.push_inscricoes enable row level security;
create policy "ver minhas inscricoes" on public.push_inscricoes for select using (usuario_id = auth.uid());
create policy "criar minha inscricao" on public.push_inscricoes for insert with check (usuario_id = auth.uid() and public.eh_da_equipe());
create policy "atualizar minha inscricao" on public.push_inscricoes for update using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
create policy "apagar minha inscricao" on public.push_inscricoes for delete using (usuario_id = auth.uid());

create table if not exists public.push_preferencias (
  usuario_id uuid primary key default auth.uid(),
  tarefas boolean not null default true, resumo boolean not null default true,
  chats boolean not null default true, devolucoes boolean not null default true,
  metas boolean not null default true, atualizado_em timestamptz not null default now());
alter table public.push_preferencias enable row level security;
create policy "ver minhas preferencias" on public.push_preferencias for select using (usuario_id = auth.uid());
create policy "criar minhas preferencias" on public.push_preferencias for insert with check (usuario_id = auth.uid() and public.eh_da_equipe());
create policy "alterar minhas preferencias" on public.push_preferencias for update using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

create table if not exists public.push_enviados (chave text primary key, criado_em timestamptz not null default now());
alter table public.push_enviados enable row level security;

create or replace function public.push_chave_publica() returns text
language sql stable security definer set search_path = public as
$$ select publica from public.push_chaves where id = 1 and public.eh_da_equipe() $$;
grant execute on function public.push_chave_publica() to authenticated;

-- chama a função de envio com o mesmo segredo dos outros avisos
create or replace function public.push_chamar(p_corpo jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as
$$ declare seg text; req bigint;
begin
  select valor into seg from public.lucro_segredo limit 1;
  select net.http_post(url := 'https://imlgfmaqmzfonvbmlwpd.supabase.co/functions/v1/push-enviar',
    headers := jsonb_build_object('Content-Type','application/json','x-lucro-token', seg),
    body := p_corpo, timeout_milliseconds := 60000) into req;
  return req;
end $$;
revoke all on function public.push_chamar(jsonb) from public, anon, authenticated;

create or replace function public.push_teste() returns void
language plpgsql security definer set search_path = public as
$$ begin
  if not public.eh_da_equipe() then raise exception 'sem acesso'; end if;
  perform public.push_chamar(jsonb_build_object('tipo','teste','usuario_id', auth.uid()));
end $$;
grant execute on function public.push_teste() to authenticated;

-- tarefa atribuída a alguém / alterada por outra pessoa
create or replace function public.push_tarefa() returns trigger
language plpgsql security definer set search_path = public as
$$ declare ator uuid := coalesce(auth.uid(), new.criado_por);
begin
  if tg_op = 'INSERT' then
    if new.responsavel_id is distinct from ator then
      perform public.push_chamar(jsonb_build_object('tipo','tarefa','acao','nova','tarefa_id', new.id,'ator', ator));
    end if;
  elsif auth.uid() is not null and new.responsavel_id is distinct from auth.uid()
        and new.feita_em is not distinct from old.feita_em
        and (new.responsavel_id is distinct from old.responsavel_id or new.titulo is distinct from old.titulo
             or new.prazo is distinct from old.prazo or new.importancia is distinct from old.importancia
             or new.descricao is distinct from old.descricao) then
    perform public.push_chamar(jsonb_build_object('tipo','tarefa',
      'acao', case when new.responsavel_id is distinct from old.responsavel_id then 'nova' else 'alterada' end,
      'tarefa_id', new.id,'ator', auth.uid()));
  end if;
  return new;
end $$;
drop trigger if exists ao_mudar_tarefa_push on public.central_tarefas;
create trigger ao_mudar_tarefa_push after insert or update on public.central_tarefas for each row execute function public.push_tarefa();

-- meta do mês batida
create or replace function public.push_meta() returns trigger
language plpgsql security definer set search_path = public as
$$ begin
  if coalesce(new.alvo,0) > 0 and coalesce(new.atual,0) >= new.alvo
     and (tg_op = 'INSERT' or coalesce(old.atual,0) < coalesce(old.alvo,0) or old.alvo is distinct from new.alvo and coalesce(old.atual,0) < new.alvo) then
    perform public.push_chamar(jsonb_build_object('tipo','meta','meta_id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists ao_bater_meta_push on public.central_metas;
create trigger ao_bater_meta_push after insert or update on public.central_metas for each row execute function public.push_meta();

-- chat: a Sandy precisa de uma pessoa
create or replace function public.push_chat() returns trigger
language plpgsql security definer set search_path = public as
$$ begin
  if new.decisao in ('escalou','erro') then
    perform public.push_chamar(jsonb_build_object('tipo','chat','registro_id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists ao_registrar_sandy_push on public.sandy_registros;
create trigger ao_registrar_sandy_push after insert on public.sandy_registros for each row execute function public.push_chat();

-- agenda: resumo das 8h (Brasília) e conferência da meta de lucro do dia
select cron.unschedule(jobid) from cron.job where jobname in ('push-resumo-manha','push-meta-lucro');
select cron.schedule('push-resumo-manha', '0 11 * * *', $$select public.push_chamar('{"tipo":"resumo"}'::jsonb)$$);
select cron.schedule('push-meta-lucro', '*/10 11-23,0-2 * * *', $$select public.push_chamar('{"tipo":"meta_lucro"}'::jsonb)$$);
