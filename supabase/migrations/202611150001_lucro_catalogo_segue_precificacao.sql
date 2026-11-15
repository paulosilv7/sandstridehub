-- Lucro ao vivo passa a seguir o catálogo e os custos da Precificação (banco), sem planilha.
-- Função lucro_sincronizar_catalogo(): cria/atualiza lucro_produtos e grava novo custo (vigente desde hoje) em lucro_custos
-- quando o custo na Precificação muda; kit sem custo próprio = custo do produto unitário x unidades. Histórico antigo é preservado.
-- Gatilho em prec_produtos chama a função a cada mudança de custo, unidades, ativo, nome, marca ou foto.
-- (corpo aplicado no banco via migração lucro_catalogo_segue_precificacao)

create or replace function public.lucro_sincronizar_catalogo() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; atual numeric; pid uuid; mudou integer := 0; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  for r in
    select pp.id_produto, pp.nome, pp.marca, pp.unidades, pp.ativo, pp.foto,
           coalesce(pp.custo, u.custo * pp.unidades) as custo_total
      from public.prec_produtos pp
      left join public.prec_produtos u
        on u.unidades = 1 and u.custo is not null
       and regexp_replace(u.id_produto, '-[0-9]+$', '') = regexp_replace(pp.id_produto, '-[0-9]+$', '')
     where pp.id_produto is not null
  loop
    select id into pid from public.lucro_produtos where codigo_planilha = r.id_produto;
    if pid is null then
      insert into public.lucro_produtos(nome, marca, eh_kit, pares, ativo, codigo_planilha, foto)
      values (r.nome, r.marca, coalesce(r.unidades,1) > 1, coalesce(r.unidades,1)::int, coalesce(r.ativo,true), r.id_produto, r.foto)
      returning id into pid;
      mudou := mudou + 1;
    else
      update public.lucro_produtos set nome = r.nome, marca = r.marca, eh_kit = coalesce(r.unidades,1) > 1,
             pares = coalesce(r.unidades,1)::int, ativo = coalesce(r.ativo,true), foto = coalesce(r.foto, foto)
       where id = pid and (nome, marca, pares, ativo, foto) is distinct from (r.nome, r.marca, coalesce(r.unidades,1)::int, coalesce(r.ativo,true), coalesce(r.foto, foto));
    end if;
    if r.custo_total is not null then
      select custo into atual from public.lucro_custos where produto_id = pid and vigente_desde <= hoje order by vigente_desde desc limit 1;
      if atual is distinct from r.custo_total then
        delete from public.lucro_custos where produto_id = pid and vigente_desde = hoje;
        insert into public.lucro_custos(produto_id, custo, vigente_desde) values (pid, r.custo_total, hoje);
        mudou := mudou + 1;
      end if;
    end if;
  end loop;
  if mudou > 0 then perform public.lucro_calcular_dia(hoje); end if;
  return mudou;
end $$;

create or replace function public.lucro_trg_catalogo() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.lucro_sincronizar_catalogo(); return null; end $$;

drop trigger if exists lucro_catalogo_segue_prec on public.prec_produtos;
create trigger lucro_catalogo_segue_prec after insert or update of custo, unidades, ativo, nome, marca, foto on public.prec_produtos
for each statement execute function public.lucro_trg_catalogo();

revoke all on function public.lucro_sincronizar_catalogo() from public, anon, authenticated;
