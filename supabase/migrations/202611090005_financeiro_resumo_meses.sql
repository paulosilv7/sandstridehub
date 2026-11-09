-- Financeiro > Histórico: o que saiu em cada mês (pago a fornecedores e despesas do resultado, com anúncios lidos),
-- para calcular "recebi − fornecedores − despesas" mês a mês. Mesmo controle de acesso do Financeiro (fin_geral_ok).
create or replace function public.financeiro_resumo_meses()
returns table (mes text, fornecedores numeric, despesas numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.fin_geral_ok() then raise exception 'sem permissão'; end if;
  return query
  with ms as (select to_char(g,'YYYY-MM') m from generate_series(date '2026-01-01', date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date, interval '1 month') g),
  f as (select to_char(date_trunc('month', e.date),'YYYY-MM') m, sum(e.value)/100.0 v from public.fin_entries e
        where e.type = 'payment' and not coalesce(e.cancelled,false) group by 1),
  d as (select to_char(date_trunc('month', coalesce(x.mes_conta, x.data)),'YYYY-MM') m, sum(x.valor) v from public.financeiro_despesas x
        where x.categoria in (select c.nome from public.financeiro_categorias c where c.entra_resultado) group by 1),
  a as (select to_char(date_trunc('month', r.dia),'YYYY-MM') m, sum(r.valor) v from public.financeiro_ads_dia r
        where exists (select 1 from public.financeiro_categorias c where c.nome = 'Ads' and c.entra_resultado) group by 1)
  select ms.m, round(coalesce(f.v,0),2), round(coalesce(d.v,0) + coalesce(a.v,0),2)
  from ms left join f on f.m = ms.m left join d on d.m = ms.m left join a on a.m = ms.m order by ms.m;
end $$;
revoke all on function public.financeiro_resumo_meses() from public, anon;
grant execute on function public.financeiro_resumo_meses() to authenticated;
