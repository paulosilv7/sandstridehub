-- Metas com número automático (faturamento, lucro, pedidos, pares do mês), atualizadas a cada 10 minutos.
alter table public.central_metas add column if not exists fonte text not null default 'manual'
  check (fonte in ('manual','faturamento','lucro','pedidos','pares'));

create or replace function public.metas_atualizar_auto() returns void
language sql security definer set search_path = public as
$$
  update public.central_metas m set atual = round(s.v, 2), atualizado_em = now()
  from (
    select m2.id,
      coalesce((select sum(case m2.fonte when 'faturamento' then r.faturamento when 'lucro' then r.lucro
                                          when 'pedidos' then r.pedidos when 'pares' then r.pares end)
                from public.lucro_resumo_dia r
                where r.dia >= m2.mes and r.dia < (m2.mes + interval '1 month')::date), 0) as v
    from public.central_metas m2 where m2.fonte <> 'manual') s
  where m.id = s.id and m.atual is distinct from round(s.v, 2);
$$;
grant execute on function public.metas_atualizar_auto() to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'metas-atualizar-auto';
select cron.schedule('metas-atualizar-auto', '*/10 * * * *', $$select public.metas_atualizar_auto()$$);
