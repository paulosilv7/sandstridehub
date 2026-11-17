-- Memória da Sandy: fila de aprendizados para aprovar + histórico com desfazer.
-- ADITIVA: não muda como a Sandy responde hoje (sandy-atender continua lendo sandy_conhecimento do mesmo jeito).
-- Aprender = alguém (ou a própria Sandy) PROPÕE; só administrador (Paulo, Lucas) APROVA, e toda mudança na base fica registrada e pode ser desfeita.
begin;

-- Metadados do que a Sandy sabe: de onde veio e quando conferir de novo (regra de marketplace muda).
alter table public.sandy_conhecimento
 add column origem text not null default 'manual',
 add column proposta_id uuid,
 add column revisar_em date;

-- Histórico de versões: registra qualquer mudança, venha de onde vier (tela, Telegram, SQL).
create table public.sandy_conhecimento_hist(
 id bigint generated always as identity primary key,
 conhecimento_id uuid not null,
 acao text not null check(acao in ('criou','editou','desativou','ativou','apagou')),
 antes jsonb,
 depois jsonb,
 por uuid,
 em timestamptz not null default now()
);
create index sandy_conhecimento_hist_em on public.sandy_conhecimento_hist(em desc);

create function public.sandy_conhecimento_log() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_acao text;
begin
 if tg_op='INSERT' then
  insert into public.sandy_conhecimento_hist(conhecimento_id,acao,depois,por) values(new.id,'criou',to_jsonb(new),auth.uid());
 elsif tg_op='DELETE' then
  insert into public.sandy_conhecimento_hist(conhecimento_id,acao,antes,por) values(old.id,'apagou',to_jsonb(old),auth.uid());
 else
  if (old.titulo,old.texto,old.escopo,old.ativo) is not distinct from (new.titulo,new.texto,new.escopo,new.ativo) then return null; end if;
  v_acao:=case when old.ativo and not new.ativo then 'desativou' when not old.ativo and new.ativo then 'ativou' else 'editou' end;
  insert into public.sandy_conhecimento_hist(conhecimento_id,acao,antes,depois,por) values(new.id,v_acao,to_jsonb(old),to_jsonb(new),auth.uid());
 end if;
 return null;
end $$;
revoke all on function public.sandy_conhecimento_log() from public,anon,authenticated;
create trigger sandy_conhecimento_historico after insert or update or delete on public.sandy_conhecimento
 for each row execute function public.sandy_conhecimento_log();

-- Propostas de aprendizado (nada vale na Sandy até um administrador aprovar).
create table public.sandy_propostas(
 id uuid primary key default gen_random_uuid(),
 titulo text not null check(char_length(titulo) between 1 and 120),
 texto text not null check(char_length(texto) between 1 and 4000),
 escopo text not null default 'todas' check(escopo in ('todas','mercado_livre','shopee','tiktok_shop')),
 conhecimento_id uuid references public.sandy_conhecimento(id) on delete set null, -- preenchido quando é revisão de algo que ela já sabe
 origem text not null check(origem in ('correcao_chat','telegram','devolucao','manual','sandy','ads','fornecedores')),
 evidencia text check(evidencia is null or char_length(evidencia)<=2000),          -- por que aprendeu (sem dados pessoais de cliente)
 origem_ref jsonb,                                                                  -- ex.: {"conversa_id":"..."} para conferir
 status text not null default 'pendente' check(status in ('pendente','aprovada','recusada')),
 decidido_por uuid references auth.users(id) on delete set null,
 decidido_em timestamptz,
 motivo_recusa text check(motivo_recusa is null or char_length(motivo_recusa)<=1000),
 criado_por uuid references auth.users(id) on delete set null,
 criado_em timestamptz not null default now()
);
create index sandy_propostas_status on public.sandy_propostas(status,criado_em desc);
-- Mesma proposta pendente não entra duas vezes.
create unique index sandy_propostas_sem_repeticao on public.sandy_propostas((md5(lower(btrim(titulo))||'|'||lower(btrim(texto))))) where status='pendente';

alter table public.sandy_propostas enable row level security;
alter table public.sandy_conhecimento_hist enable row level security;
revoke all on public.sandy_propostas,public.sandy_conhecimento_hist from public,anon;
grant select on public.sandy_propostas,public.sandy_conhecimento_hist to authenticated;
create policy sandy_propostas_ler on public.sandy_propostas for select to authenticated using(public.eh_admin());
create policy sandy_conhecimento_hist_ler on public.sandy_conhecimento_hist for select to authenticated using(public.eh_admin());

-- Qualquer pessoa da equipe (ou uma função da Sandy) pode PROPOR. Não entra na base.
create function public.sandy_propor(p_titulo text,p_texto text,p_escopo text default 'todas',p_origem text default 'manual',
 p_evidencia text default null,p_ref jsonb default null,p_conhecimento_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if auth.uid() is not null and not public.eh_da_equipe() then raise exception 'Sem acesso' using errcode='42501'; end if;
 begin
  insert into public.sandy_propostas(titulo,texto,escopo,origem,evidencia,origem_ref,conhecimento_id,criado_por)
  values(btrim(p_titulo),btrim(p_texto),coalesce(p_escopo,'todas'),p_origem,nullif(btrim(coalesce(p_evidencia,'')),''),p_ref,p_conhecimento_id,auth.uid())
  returning id into v_id;
 exception when unique_violation then
  select id into v_id from public.sandy_propostas where status='pendente'
   and lower(btrim(titulo))=lower(btrim(p_titulo)) and lower(btrim(texto))=lower(btrim(p_texto)) limit 1;
 end;
 return v_id;
end $$;
revoke all on function public.sandy_propor(text,text,text,text,text,jsonb,uuid) from public,anon;
grant execute on function public.sandy_propor(text,text,text,text,text,jsonb,uuid) to authenticated,service_role;

-- Só administrador decide. Aprovar cria (ou atualiza) o item na base; pode editar antes de aprovar.
create function public.sandy_decidir(p_id uuid,p_acao text,p_titulo text default null,p_texto text default null,
 p_escopo text default null,p_motivo text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.sandy_propostas;v_titulo text;v_texto text;v_escopo text;v_k uuid;
begin
 if auth.uid() is null or not public.eh_admin() then raise exception 'Só administradores aprovam aprendizados' using errcode='42501'; end if;
 if p_acao not in ('aprovar','recusar') then raise exception 'Ação inválida'; end if;
 select * into p from public.sandy_propostas where id=p_id for update;
 if not found then raise exception 'Proposta não encontrada'; end if;
 if p.status<>'pendente' then raise exception 'Esta proposta já foi decidida por outra pessoa' using errcode='40001'; end if;
 if p_acao='recusar' then
  update public.sandy_propostas set status='recusada',decidido_por=auth.uid(),decidido_em=now(),
   motivo_recusa=nullif(btrim(coalesce(p_motivo,'')),'') where id=p_id;
  return null;
 end if;
 v_titulo:=coalesce(nullif(btrim(coalesce(p_titulo,'')),''),p.titulo);
 v_texto:=coalesce(nullif(btrim(coalesce(p_texto,'')),''),p.texto);
 v_escopo:=coalesce(nullif(p_escopo,''),p.escopo);
 if v_escopo not in ('todas','mercado_livre','shopee','tiktok_shop') then raise exception 'Escopo inválido'; end if;
 if char_length(v_titulo)>120 or char_length(v_texto)>4000 then raise exception 'Título ou texto longo demais'; end if;
 if p.conhecimento_id is not null and exists(select 1 from public.sandy_conhecimento where id=p.conhecimento_id) then
  update public.sandy_conhecimento set titulo=v_titulo,texto=v_texto,escopo=v_escopo,ativo=true,origem='proposta',
   proposta_id=p.id,atualizado_em=now() where id=p.conhecimento_id returning id into v_k;
 else
  insert into public.sandy_conhecimento(titulo,texto,escopo,ativo,criado_por,origem,proposta_id)
  values(v_titulo,v_texto,v_escopo,true,auth.uid(),'proposta',p.id) returning id into v_k;
 end if;
 update public.sandy_propostas set status='aprovada',decidido_por=auth.uid(),decidido_em=now(),conhecimento_id=v_k where id=p_id;
 return v_k;
end $$;
revoke all on function public.sandy_decidir(uuid,text,text,text,text,text) from public,anon;
grant execute on function public.sandy_decidir(uuid,text,text,text,text,text) to authenticated;

-- Desfazer uma mudança: volta o item ao estado de antes (ou desativa o que foi criado). A volta também fica no histórico.
create function public.sandy_restaurar(p_hist bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare h public.sandy_conhecimento_hist;
begin
 if auth.uid() is null or not public.eh_admin() then raise exception 'Só administradores desfazem mudanças' using errcode='42501'; end if;
 select * into h from public.sandy_conhecimento_hist where id=p_hist;
 if not found then raise exception 'Mudança não encontrada'; end if;
 if h.acao='criou' then
  update public.sandy_conhecimento set ativo=false,atualizado_em=now() where id=h.conhecimento_id;
 elsif h.antes is not null then
  insert into public.sandy_conhecimento
   select * from jsonb_populate_record(null::public.sandy_conhecimento,h.antes)
  on conflict(id) do update set titulo=excluded.titulo,texto=excluded.texto,escopo=excluded.escopo,ativo=excluded.ativo,
   revisar_em=excluded.revisar_em,atualizado_em=now();
 else
  raise exception 'Esta mudança não pode ser desfeita';
 end if;
 return h.conhecimento_id;
end $$;
revoke all on function public.sandy_restaurar(bigint) from public,anon;
grant execute on function public.sandy_restaurar(bigint) to authenticated;

commit;
