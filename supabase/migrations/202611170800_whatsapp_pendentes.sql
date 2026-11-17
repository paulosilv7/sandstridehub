-- WhatsApp dos fornecedores -> lançamentos PENDENTES em Fornecedores.
-- Migração ADITIVA: só cria objetos novos (wa_*). Não altera fin_* nem nenhuma tabela existente.
-- A leitura é só leitura: nada é enviado ao WhatsApp. Compra só nasce quando uma pessoa aprova
-- na tela de Fornecedores (que grava pelo fin_commit, com as travas de sempre).
begin;

-- Quem pode ver/editar pendentes: o mesmo grupo que já usa o financeiro (fin_access).
create function public.wa_acesso() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.fin_access where user_id=auth.uid())
$$;
revoke all on function public.wa_acesso() from public,anon;
grant execute on function public.wa_acesso() to authenticated,service_role;

-- Texto comparável: minúsculas e espaços simples (apelidos de modelo).
create function public.wa_norm(t text) returns text
language sql immutable set search_path='' as $$
 select lower(regexp_replace(btrim(coalesce(t,'')),'\s+',' ','g'))
$$;

-- Grupos permitidos (um por fornecedor). Mensagem de outro grupo é descartada.
create table public.wa_grupos(
 jid text primary key check(jid like '%@g.us'),
 fornecedor text not null references public.fin_suppliers(name),
 formato text not null check(formato in ('pechincha','wbox')),
 produto_padrao text references public.fin_products(id), -- usado quando a mensagem só traz a quantidade (W-Box)
 remetentes text[] not null default '{}',                -- vazio = sem filtro de remetente (só para a fase de teste)
 ativo boolean not null default true,
 criado_em timestamptz not null default now()
);

-- Só mensagens que passaram no filtro. O resto nunca é gravado.
create table public.wa_mensagens(
 id text primary key,                                    -- ID da mensagem no WhatsApp (evita duplicar)
 grupo text not null references public.wa_grupos(jid),
 remetente text,
 enviada_em timestamptz not null,
 dia date not null,                                      -- data do lançamento (a escrita na mensagem; senão o dia do envio em São Paulo)
 texto text not null check(length(texto)<=5000),
 itens jsonb,                                            -- leitura por regra: [{"modelo":"VulcStar","qtd":113},{"cancelados":3}] ou [{"qtd":255}]
 total_declarado bigint check(total_declarado is null or total_declarado>=0), -- centavos, quando a mensagem traz Total
 status text not null check(status in ('valida','revisao','apagada')),
 criado_em timestamptz not null default now()
);
create index wa_mensagens_dia on public.wa_mensagens(grupo,dia,enviada_em);

-- Contador de mensagens descartadas por grupo/dia (sem texto), para conferir que o filtro está saudável.
create table public.wa_descartes(
 grupo text not null,
 dia date not null,
 motivo text not null,
 n integer not null default 0,
 primary key(grupo,dia,motivo)
);

-- Um lançamento pendente por fornecedor e data.
create table public.wa_pendentes(
 id uuid primary key default gen_random_uuid(),
 fornecedor text not null references public.fin_suppliers(name),
 data date not null,
 status text not null default 'aberto' check(status in ('aberto','aprovado','descartado')),
 total_declarado bigint,
 editado boolean not null default false,                 -- se a pessoa mexeu, um fechamento novo não sobrescreve
 aviso text,
 order_id text check(order_id is null or order_id ~ '^OC-[0-9]{8}-[A-F0-9]{8}$'),
 aprovado_em timestamptz,
 aprovado_por uuid,
 criado_em timestamptz not null default now(),
 atualizado_em timestamptz not null default now(),
 unique(fornecedor,data)
);

create table public.wa_pendentes_itens(
 id uuid primary key default gen_random_uuid(),
 pendente_id uuid not null references public.wa_pendentes(id) on delete cascade,
 tipo text not null check(tipo in ('linha','abate')),
 modelo_texto text,                                      -- como veio na mensagem
 produto_id text references public.fin_products(id),     -- modelo escolhido/reconhecido
 qtd integer not null check(qtd>0 and qtd<=100000),
 ordem integer not null default 0
);
create index wa_pendentes_itens_pend on public.wa_pendentes_itens(pendente_id,ordem);

-- Apelidos: "Mizon RMax" -> Tênis Rmax 90. Aprende quando a pessoa escolhe o modelo na aprovação.
create table public.wa_apelidos(
 fornecedor text not null references public.fin_suppliers(name),
 apelido text not null,
 produto_id text not null references public.fin_products(id),
 primary key(fornecedor,apelido)
);
insert into public.wa_apelidos(fornecedor,apelido,produto_id)
select 'PECHINCHA LIVRE',v.a,p.id from (values
 ('vulcstar','VulcStar'),('mizon rmax','Tênis Rmax 90'),('rmax','Tênis Rmax 90'),
 ('revelation','Revelation'),('room x','Room X')
) v(a,n) join public.fin_products p on p.supplier='PECHINCHA LIVRE' and p.name=v.n;

-- Acesso: RLS ligado em tudo. Escrita pelo recebimento usa service_role (ignora RLS).
alter table public.wa_grupos enable row level security;
alter table public.wa_mensagens enable row level security;
alter table public.wa_descartes enable row level security;
alter table public.wa_pendentes enable row level security;
alter table public.wa_pendentes_itens enable row level security;
alter table public.wa_apelidos enable row level security;
revoke all on public.wa_grupos,public.wa_mensagens,public.wa_descartes,public.wa_pendentes,public.wa_pendentes_itens,public.wa_apelidos from public,anon;
grant select,update on public.wa_grupos to authenticated;
grant select on public.wa_mensagens,public.wa_descartes to authenticated;
grant select,update on public.wa_pendentes to authenticated;
grant select,insert,update,delete on public.wa_pendentes_itens,public.wa_apelidos to authenticated;
create policy wa_grupos_ler on public.wa_grupos for select to authenticated using(public.wa_acesso());
create policy wa_grupos_editar on public.wa_grupos for update to authenticated using(public.wa_acesso()) with check(public.wa_acesso());
create policy wa_mensagens_ler on public.wa_mensagens for select to authenticated using(public.wa_acesso());
create policy wa_descartes_ler on public.wa_descartes for select to authenticated using(public.wa_acesso());
create policy wa_pendentes_ler on public.wa_pendentes for select to authenticated using(public.wa_acesso());
create policy wa_pendentes_editar on public.wa_pendentes for update to authenticated using(public.wa_acesso()) with check(public.wa_acesso());
create policy wa_itens_tudo on public.wa_pendentes_itens for all to authenticated using(public.wa_acesso()) with check(public.wa_acesso());
create policy wa_apelidos_tudo on public.wa_apelidos for all to authenticated using(public.wa_acesso()) with check(public.wa_acesso());

-- Fechamento do dia: monta/atualiza o pendente de cada fornecedor.
--   pechincha: vale a ÚLTIMA mensagem do dia (cada mensagem é o total do dia).
--   wbox: SOMA as quantidades de todas as mensagens do dia.
-- Pendente já aprovado nunca é alterado: só ganha um aviso. Pendente editado à mão também não é sobrescrito.
create function public.wa_fechar_dia(p_dia date default null,p_fornecedor text default null) returns integer
language plpgsql security definer set search_path='' as $$
declare g record;m record;e jsonb;v_dia date:=coalesce(p_dia,(now() at time zone 'America/Sao_Paulo')::date);
 v_id uuid;v_st text;v_edit boolean;v_n integer:=0;v_ord integer;v_total bigint;v_soma integer;
begin
 for g in select * from public.wa_grupos where ativo and (p_fornecedor is null or fornecedor=p_fornecedor) loop
  if not exists(select 1 from public.wa_mensagens where grupo=g.jid and dia=v_dia and status='valida') then
   -- Se as mensagens foram apagadas no WhatsApp, o pendente aberto avisa em vez de ficar com números velhos.
   update public.wa_pendentes set aviso='As mensagens deste dia foram apagadas no WhatsApp. Confira antes de aprovar.',atualizado_em=now()
    where fornecedor=g.fornecedor and data=v_dia and status='aberto';
   continue;
  end if;
  select id,status,editado into v_id,v_st,v_edit from public.wa_pendentes where fornecedor=g.fornecedor and data=v_dia;
  if v_st in('aprovado','descartado') then
   update public.wa_pendentes set aviso='Chegou mensagem nova depois do fechamento. Confira no WhatsApp.',atualizado_em=now() where id=v_id;
   continue;
  end if;
  if v_st='aberto' and v_edit then
   update public.wa_pendentes set aviso='Chegou mensagem nova depois da sua edição. Confira antes de aprovar.',atualizado_em=now() where id=v_id;
   continue;
  end if;
  if v_id is null then
   insert into public.wa_pendentes(fornecedor,data) values(g.fornecedor,v_dia) returning id into v_id;
  else
   delete from public.wa_pendentes_itens where pendente_id=v_id;
  end if;
  v_ord:=0;v_total:=null;
  if g.formato='pechincha' then
   select * into m from public.wa_mensagens where grupo=g.jid and dia=v_dia and status='valida' order by enviada_em desc,criado_em desc limit 1;
   v_total:=m.total_declarado;
   for e in select * from jsonb_array_elements(coalesce(m.itens,'[]'::jsonb)) loop
    v_ord:=v_ord+1;
    if e ? 'cancelados' then
     insert into public.wa_pendentes_itens(pendente_id,tipo,modelo_texto,qtd,ordem) values(v_id,'abate','Pares cancelados',(e->>'cancelados')::int,v_ord);
    else
     insert into public.wa_pendentes_itens(pendente_id,tipo,modelo_texto,produto_id,qtd,ordem)
     select v_id,'linha',e->>'modelo',
      coalesce((select a.produto_id from public.wa_apelidos a where a.fornecedor=g.fornecedor and a.apelido=public.wa_norm(e->>'modelo')),
               (select p.id from public.fin_products p where p.supplier=g.fornecedor and public.wa_norm(p.name)=public.wa_norm(e->>'modelo') limit 1)),
      (e->>'qtd')::int,v_ord;
    end if;
   end loop;
  else
   select coalesce(sum((x->>'qtd')::int),0) into v_soma from public.wa_mensagens w,jsonb_array_elements(coalesce(w.itens,'[]'::jsonb)) x
    where w.grupo=g.jid and w.dia=v_dia and w.status='valida';
   if v_soma>0 then
    insert into public.wa_pendentes_itens(pendente_id,tipo,modelo_texto,produto_id,qtd,ordem) values(v_id,'linha','Soma do dia',g.produto_padrao,v_soma,1);
   end if;
  end if;
  update public.wa_pendentes set total_declarado=v_total,aviso=null,atualizado_em=now() where id=v_id;
  v_n:=v_n+1;
 end loop;
 return v_n;
end $$;
revoke all on function public.wa_fechar_dia(date,text) from public,anon,authenticated;
grant execute on function public.wa_fechar_dia(date,text) to service_role;

-- Conta mensagem descartada (sem guardar texto). Também mostra o ID de grupos ainda não cadastrados.
create function public.wa_contar_descarte(p_grupo text,p_dia date,p_motivo text) returns void
language sql security definer set search_path='' as $$
 insert into public.wa_descartes(grupo,dia,motivo,n) values(p_grupo,p_dia,p_motivo,1)
 on conflict(grupo,dia,motivo) do update set n=public.wa_descartes.n+1
$$;
revoke all on function public.wa_contar_descarte(text,date,text) from public,anon,authenticated;
grant execute on function public.wa_contar_descarte(text,date,text) to service_role;

-- Fechamento diário às 17h de São Paulo (20h UTC; o Brasil não usa horário de verão).
select cron.schedule('wa-fechar-dia','0 20 * * *','select public.wa_fechar_dia();');

commit;
