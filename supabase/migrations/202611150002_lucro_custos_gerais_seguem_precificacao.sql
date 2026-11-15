-- Lucro ao vivo passa a seguir os custos gerais da Precificação (prec_custos_gerais).
-- Mudou o valor lá, entra uma linha nova aqui valendo a partir de hoje; o histórico fica.
create or replace function public.lucro_sincronizar_custos_gerais() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; atual numeric; novo numeric; un text; nm text; mudou integer := 0;
        hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  for r in select chave, valor, unidade from public.prec_custos_gerais where chave in ('ads','embalagem','nfe','outros')
  loop
    nm := case r.chave when 'ads' then 'Anúncios (ads)' when 'embalagem' then 'Embalagem' when 'nfe' then 'NF-e' else 'Outros' end;
    un := case when r.unidade ilike '%par%' then 'par' else 'pedido' end;
    novo := r.valor::numeric;
    if novo is null then continue; end if;
    select valor into atual from public.lucro_custos_gerais
     where loja_id is null and nome = nm and unidade = un and vigente_desde <= hoje
     order by vigente_desde desc limit 1;
    if atual is distinct from novo then
      delete from public.lucro_custos_gerais where loja_id is null and nome = nm and vigente_desde = hoje;
      insert into public.lucro_custos_gerais(loja_id, nome, valor, unidade, vigente_desde) values (null, nm, novo, un, hoje);
      mudou := mudou + 1;
    end if;
  end loop;
  if mudou > 0 then
    -- pedidos de hoje já carimbados passam a valer com os custos novos; dias anteriores ficam como estavam
    update public.lucro_pedidos set
      custos_gerais_par = public.lucro_gerais_par(loja_id, dia, 'par'),
      custos_gerais_pedido = public.lucro_gerais_par(loja_id, dia, 'pedido')
     where dia = hoje;
    perform public.lucro_calcular_dia(hoje);
  end if;
  return mudou;
end $$;

create or replace function public.lucro_trg_custos_gerais() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.lucro_sincronizar_custos_gerais(); return null; end $$;

drop trigger if exists lucro_gerais_segue_prec on public.prec_custos_gerais;
create trigger lucro_gerais_segue_prec after insert or update of valor, unidade on public.prec_custos_gerais
  for each statement execute function public.lucro_trg_custos_gerais();

select public.lucro_sincronizar_custos_gerais();

update public.lucro_pedidos set
  custos_gerais_par = public.lucro_gerais_par(loja_id, dia, 'par'),
  custos_gerais_pedido = public.lucro_gerais_par(loja_id, dia, 'pedido')
 where dia = (now() at time zone 'America/Sao_Paulo')::date;
select public.lucro_calcular_dia((now() at time zone 'America/Sao_Paulo')::date);
