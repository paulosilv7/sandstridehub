-- Financeiro > Histórico: "vendi × recebi" por mês e marketplace (jan–out/2026, lido das APIs dos marketplaces).
-- Os números brutos ficam em financeiro_hist_coleta (sem acesso direto); a tela lê pela função abaixo.
create table if not exists public.financeiro_hist_coleta (
  mes text not null, mp text not null, loja text not null, parte int not null default 0,
  dados jsonb not null, coletado_em timestamptz not null default now(),
  primary key (mes, mp, loja, parte)
);
alter table public.financeiro_hist_coleta enable row level security;

create or replace view public.financeiro_hist_mensal as
select mes, mp, loja,
  coalesce(sum((dados->>'faturamento')::numeric) filter (where not (mp='sp' and parte=0)),0) as vendido,
  coalesce(sum((dados->>'liquido')::numeric) filter (where not (mp='sp' and parte=0)),0) as liquido,
  coalesce(sum((dados->>'pedidos')::numeric) filter (where not (mp='sp' and parte=0)),0) as pedidos,
  coalesce(sum((dados->>'devolucoes')::numeric),0) as devolucoes,
  coalesce(sum((dados->>'recebido')::numeric) filter (where parte = 0),0) as recebido
from public.financeiro_hist_coleta group by mes, mp, loja;
alter view public.financeiro_hist_mensal set (security_invoker = true);

create or replace function public.financeiro_historico()
returns table (mes text, mp text, loja text, vendido numeric, liquido numeric, pedidos numeric, devolucoes numeric, recebido numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.fin_geral_ok() then raise exception 'sem permissão'; end if;
  return query select h.mes, h.mp, h.loja, round(h.vendido,2), round(h.liquido,2), h.pedidos, round(h.devolucoes,2), round(h.recebido,2)
               from public.financeiro_hist_mensal h order by h.mes, h.mp, h.loja;
end $$;
revoke all on function public.financeiro_historico() from public, anon;
grant execute on function public.financeiro_historico() to authenticated;
