-- Estoque dentro do banco (antes: planilha SISTEMA ESTOQUE). Tabelas + funções de uso do app.
create table if not exists public.est_produtos (
  codigo text primary key,
  marca text not null,            -- era a "ABA" da planilha (W-BOX, PECHINCHA LIVRE...)
  produto text not null,          -- modelo
  cor text not null,
  custo numeric not null default 0,
  foto text,                      -- 'sb:arquivo.jpg' (storage fotos-estoque) ou id do Drive (legado)
  ativo boolean not null default true,
  fornecedor_produto text,        -- fin_products.id: de onde vem o custo
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create table if not exists public.est_grade (
  codigo text not null references public.est_produtos(codigo) on update cascade on delete cascade,
  tamanho text not null,
  quantidade integer not null default 0 check (quantidade >= 0),
  primary key (codigo, tamanho)
);
create table if not exists public.est_historico (
  id bigserial primary key,
  quando timestamptz not null,
  usuario text not null,
  codigo text not null,
  tamanho text not null,
  antes integer not null,
  depois integer not null,
  diferenca integer not null,
  origem text not null default 'app'   -- 'planilha' = importado
);
create index if not exists est_historico_quando on public.est_historico (quando desc);
create index if not exists est_historico_codigo on public.est_historico (codigo);

alter table public.est_produtos enable row level security;
alter table public.est_grade enable row level security;
alter table public.est_historico enable row level security;
do $$ declare t text; begin
  foreach t in array array['est_produtos','est_grade','est_historico'] loop
    execute format('drop policy if exists %I on public.%I', t||'_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.tem_acesso(''estoque'') or public.tem_acesso(''precificacao'') or public.tem_acesso(''financeiro''))', t||'_ler', t);
  end loop;
end $$;

-- custo vem do Fornecedores (preço mais recente) para os modelos ligados
create or replace function public.est_sincronizar_custos() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.est_produtos e set custo = x.preco, atualizado_em = now()
    from (select ep.codigo, (select fx.cents / 100.0 from public.fin_prices fx
                              where fx.product_id::text = ep.fornecedor_produto
                                and fx.valid_from <= (now() at time zone 'America/Sao_Paulo')::date
                              order by fx.valid_from desc, fx.created_at desc limit 1) as preco
            from public.est_produtos ep where ep.fornecedor_produto is not null) x
   where e.codigo = x.codigo and x.preco is not null and e.custo is distinct from x.preco;
  get diagnostics n = row_count;
  return n;
end $$;
create or replace function public.est_trg_custos() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.est_sincronizar_custos(); return null; end $$;
drop trigger if exists est_custo_segue_fornecedor on public.fin_prices;
create trigger est_custo_segue_fornecedor after insert or update of cents, valid_from on public.fin_prices
  for each statement execute function public.est_trg_custos();

-- ===== funções do app =====
create or replace function public.est_totais() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('pares', coalesce(sum(g.quantidade),0), 'valor', round(coalesce(sum(g.quantidade * p.custo),0), 2))
    from public.est_grade g join public.est_produtos p on p.codigo = g.codigo where p.ativo $$;

create or replace function public.est_resumo() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (public.tem_acesso('estoque') or public.tem_acesso('financeiro') or public.tem_acesso('precificacao')) then raise exception 'sem permissão'; end if;
  return public.est_totais();
end $$;

create or replace function public.est_iniciar() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.tem_acesso('estoque') then raise exception 'sem permissão'; end if;
  return jsonb_build_object('admin', public.eh_admin(), 'totais', public.est_totais(),
    'produtos', coalesce((select jsonb_agg(jsonb_build_object(
        'codigo', p.codigo, 'marca', p.marca, 'produto', p.produto, 'cor', p.cor, 'custo', p.custo, 'foto', coalesce(p.foto,''),
        'grade', (select coalesce(jsonb_agg(g.tamanho order by nullif(regexp_replace(g.tamanho,'[^0-9.]','','g'),'')::numeric nulls last, g.tamanho), '[]') from public.est_grade g where g.codigo = p.codigo),
        'qtds',  (select coalesce(jsonb_agg(g.quantidade order by nullif(regexp_replace(g.tamanho,'[^0-9.]','','g'),'')::numeric nulls last, g.tamanho), '[]') from public.est_grade g where g.codigo = p.codigo),
        'contado', (select (extract(epoch from max(h.quando)) * 1000)::bigint from public.est_historico h where h.codigo = p.codigo)
      ) order by p.marca, p.produto, p.cor) from public.est_produtos p where p.ativo), '[]'));
end $$;

create or replace function public.est_lancar(p_lista jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare prod jsonb; it jsonb; cod text; tam text; dep integer; ant integer; quando timestamptz := now(); email text := coalesce(auth.jwt()->>'email', 'sistema');
begin
  if auth.uid() is not null and not public.tem_acesso('estoque') then raise exception 'sem permissão'; end if;
  if jsonb_typeof(p_lista) <> 'array' or jsonb_array_length(p_lista) = 0 or jsonb_array_length(p_lista) > 200 then raise exception 'Nada para lançar.'; end if;
  for prod in select * from jsonb_array_elements(p_lista) loop
    cod := trim(prod->>'codigo');
    for it in select * from jsonb_array_elements(coalesce(prod->'itens','[]')) loop
      tam := trim(it->>'tamanho'); dep := round((it->>'depois')::numeric)::integer;
      if dep < 0 or dep > 100000 then raise exception 'Quantidade inválida no tamanho %.', tam; end if;
      select quantidade into ant from public.est_grade where codigo = cod and tamanho = tam for update;
      if not found then raise exception 'Tamanho % não existe em %.', tam, cod; end if;
      update public.est_grade set quantidade = dep where codigo = cod and tamanho = tam;
      insert into public.est_historico(quando, usuario, codigo, tamanho, antes, depois, diferenca) values (quando, email, cod, tam, ant, dep, dep - ant);
    end loop;
  end loop;
  return jsonb_build_object('quando', to_char(quando at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI'), 'contado', (extract(epoch from quando) * 1000)::bigint, 'totais', public.est_totais());
end $$;

create or replace function public.est_historico(p_n integer default 200) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.tem_acesso('estoque') then raise exception 'sem permissão'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'quando')::bigint desc) from (
    select jsonb_build_object('quando', (extract(epoch from h.quando) * 1000)::bigint, 'usuario', h.usuario, 'codigo', h.codigo,
             'produto', coalesce(p.produto, h.codigo), 'cor', coalesce(p.cor, ''),
             'itens', jsonb_agg(jsonb_build_object('tamanho', h.tamanho, 'antes', h.antes, 'depois', h.depois) order by h.id)) x
      from public.est_historico h left join public.est_produtos p on p.codigo = h.codigo
     group by h.quando, h.usuario, h.codigo, p.produto, p.cor
     order by h.quando desc limit greatest(least(coalesce(p_n, 200), 500), 1)) s), '[]');
end $$;

create or replace function public.est_buscar_produto(p_codigo text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.tem_acesso('estoque') then raise exception 'sem permissão'; end if;
  return (select jsonb_build_object('codigo', p.codigo, 'produto', p.produto, 'cor', p.cor, 'foto', coalesce(p.foto,''),
      'tamanhos', (select coalesce(jsonb_agg(jsonb_build_object('tamanho', g.tamanho, 'quantidade', g.quantidade) order by nullif(regexp_replace(g.tamanho,'[^0-9.]','','g'),'')::numeric nulls last, g.tamanho), '[]') from public.est_grade g where g.codigo = p.codigo))
    from public.est_produtos p where p.codigo = trim(p_codigo) and p.ativo);
end $$;

-- cadastro: {marca, produto, custo, cores:[{cor, tamanhos:[...], foto}]} (só administrador)
create or replace function public.est_cadastrar(p_dados jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare marca text; modelo text; custo numeric; c jsonb; cor text; tams text[]; base text; cod text; k integer; t text; criados jsonb := '[]'; fornec text;
begin
  if not public.eh_admin() then raise exception 'Só administradores podem cadastrar ou editar produtos.'; end if;
  marca := upper(regexp_replace(trim(p_dados->>'marca'), '\s+', ' ', 'g')); modelo := upper(regexp_replace(trim(p_dados->>'produto'), '\s+', ' ', 'g'));
  if marca = '' or modelo = '' then raise exception 'Informe a marca e o modelo.'; end if;
  custo := greatest(coalesce((p_dados->>'custo')::numeric, 0), 0);
  select fornecedor_produto into fornec from public.est_produtos where upper(est_produtos.marca) = marca and upper(est_produtos.produto) = modelo and fornecedor_produto is not null limit 1;
  for c in select * from jsonb_array_elements(coalesce(p_dados->'cores','[]')) loop
    cor := upper(regexp_replace(trim(c->>'cor'), '\s+', ' ', 'g'));
    if cor = '' then raise exception 'Cor sem nome.'; end if;
    select coalesce(array_agg(trim(x)) filter (where trim(x) <> ''), '{}') into tams from jsonb_array_elements_text(coalesce(c->'tamanhos','[]')) x;
    if coalesce(array_length(tams,1),0) = 0 then raise exception 'Informe os tamanhos de %.', cor; end if;
    if exists (select 1 from public.est_produtos where upper(est_produtos.marca) = marca and upper(est_produtos.produto) = modelo and est_produtos.cor = cor and ativo) then raise exception '% % já está cadastrado.', modelo, cor; end if;
    base := regexp_replace(modelo, '[^A-Z0-9]', '', 'g') || '-' || case cor when 'VERMELHO' then 'VML' when 'VERDE' then 'VRD' when 'PRETO/BRANCO' then 'PTB' when 'BRANCO/PRETO' then 'BPT'
            else coalesce(nullif(left(regexp_replace(cor, '[^A-Z]', '', 'g'), 3), ''), 'COR') end;
    cod := base; k := 2; while exists (select 1 from public.est_produtos where codigo = cod) loop cod := base || k; k := k + 1; end loop;
    insert into public.est_produtos(codigo, marca, produto, cor, custo, foto, fornecedor_produto) values (cod, marca, modelo, cor, custo, nullif(c->>'foto',''), fornec);
    foreach t in array tams loop insert into public.est_grade(codigo, tamanho, quantidade) values (cod, t, 0) on conflict do nothing; end loop;
    criados := criados || jsonb_build_array(cod);
  end loop;
  if fornec is not null then perform public.est_sincronizar_custos(); end if;
  return jsonb_build_object('codigos', criados);
end $$;

-- edição: {codigo, produto?, cor?, custo?, custoTodas?, foto?, remover?:[...], adicionar?:[...], arquivar?:bool} (só administrador)
create or replace function public.est_editar(p_dados jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare cod text := trim(p_dados->>'codigo'); x public.est_produtos%rowtype; novo_modelo text; nova_cor text; t text;
begin
  if not public.eh_admin() then raise exception 'Só administradores podem cadastrar ou editar produtos.'; end if;
  select * into x from public.est_produtos where codigo = cod;
  if not found then raise exception 'Produto não encontrado.'; end if;
  if coalesce((p_dados->>'arquivar')::boolean, false) then
    update public.est_produtos set ativo = false, atualizado_em = now() where codigo = cod;
  else
    novo_modelo := coalesce(nullif(upper(regexp_replace(trim(p_dados->>'produto'), '\s+', ' ', 'g')), ''), x.produto);
    nova_cor := coalesce(nullif(upper(regexp_replace(trim(p_dados->>'cor'), '\s+', ' ', 'g')), ''), x.cor);
    if novo_modelo <> x.produto then update public.est_produtos set produto = novo_modelo, atualizado_em = now() where marca = x.marca and produto = x.produto; end if;
    if nova_cor <> x.cor then update public.est_produtos set cor = nova_cor, atualizado_em = now() where codigo = cod; end if;
    if p_dados ? 'custo' and p_dados->>'custo' is not null then
      if coalesce((p_dados->>'custoTodas')::boolean, false) then update public.est_produtos set custo = greatest((p_dados->>'custo')::numeric, 0), atualizado_em = now() where marca = x.marca and produto = novo_modelo;
      else update public.est_produtos set custo = greatest((p_dados->>'custo')::numeric, 0), atualizado_em = now() where codigo = cod; end if;
    end if;
    if nullif(p_dados->>'foto','') is not null then update public.est_produtos set foto = p_dados->>'foto', atualizado_em = now() where codigo = cod; end if;
    for t in select jsonb_array_elements_text(coalesce(p_dados->'remover','[]')) loop delete from public.est_grade where codigo = cod and tamanho = trim(t); end loop;
    for t in select jsonb_array_elements_text(coalesce(p_dados->'adicionar','[]')) loop
      if trim(t) <> '' then insert into public.est_grade(codigo, tamanho, quantidade) values (cod, trim(t), 0) on conflict do nothing; end if;
    end loop;
  end if;
  return public.est_iniciar();
end $$;

-- Precificação lê o estoque no mesmo formato da antiga aba PRODUTOS da planilha
create or replace function public.est_planilha_produtos() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not (public.tem_acesso('estoque') or public.tem_acesso('precificacao')) then raise exception 'sem permissão'; end if;
  return jsonb_build_array(jsonb_build_array('CÓDIGO','ABA','PRODUTO','COR','CUSTO UNITÁRIO (R$)','QUANTIDADE EM ESTOQUE','VALOR EM ESTOQUE (R$)','FOTO (ID NO DRIVE)'))
    || coalesce((select jsonb_agg(jsonb_build_array(p.codigo, p.marca, p.produto, p.cor, 'R$ ' || replace(to_char(p.custo, 'FM99990.00'), '.', ','), q.qtd::text, '', coalesce(p.foto,'')) order by p.marca, p.produto, p.cor)
                  from public.est_produtos p left join lateral (select coalesce(sum(g.quantidade),0) qtd from public.est_grade g where g.codigo = p.codigo) q on true where p.ativo), '[]');
end $$;
