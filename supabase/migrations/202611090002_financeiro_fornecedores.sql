-- Financeiro lê o módulo Fornecedores (somente leitura).
-- Por fornecedor: comprado e pago dentro do período e o saldo ainda a pagar
-- (compras − pagamentos − créditos, até o fim do período). Cancelados ficam de fora.
-- Mesmo controle de acesso das demais funções do Financeiro (fin_geral_ok).
create or replace function public.financeiro_fornecedores(p_ini date, p_fim date)
returns table(fornecedor text, comprado numeric, pago numeric, saldo numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not public.fin_geral_ok() then raise exception 'sem permissão'; end if;
  return query
  select e.supplier,
    coalesce(sum(e.value) filter (where e.type = 'purchase' and e.date >= p_ini and e.date < p_fim), 0) / 100.0,
    coalesce(sum(e.value) filter (where e.type = 'payment'  and e.date >= p_ini and e.date < p_fim), 0) / 100.0,
    (coalesce(sum(e.value) filter (where e.type = 'purchase'), 0)
     - coalesce(sum(e.value) filter (where e.type in ('payment','credit')), 0)) / 100.0
  from public.fin_entries e
  where not coalesce(e.cancelled, false) and e.date < p_fim
  group by e.supplier
  order by 4 desc, 1;
end $$;
revoke all on function public.financeiro_fornecedores(date, date) from public, anon;
grant execute on function public.financeiro_fornecedores(date, date) to authenticated;
