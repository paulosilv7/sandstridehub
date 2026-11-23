-- Gasto diário de ads: uma fonte só.
-- ads_loja_dia (preenchida por ads-sincronizar, relê 10 dias a cada 15 min) passa a ser a fonte; financeiro_ads_dia, que o Financeiro e
-- financeiro_resumo_meses leem, é mantida por gatilho a partir dela. A função financeiro-anuncios (relia só 7 dias a cada 3 h e deixava
-- valores parciais do Mercado Livre congelados) e o cron financeiro-anuncios-3h saem.
-- Só entram dias a partir do primeiro dia que o Financeiro já tem da API: antes disso os ads vêm da planilha e somar de novo duplicaria o mês.

create or replace function public.ads_gasto_para_financeiro() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.gasto is null then return new; end if;
  if new.dia >= coalesce((select min(dia) from public.financeiro_ads_dia), new.dia) then
    insert into public.financeiro_ads_dia (loja_id, dia, valor, atualizado_em)
    values (new.loja_id, new.dia, round(new.gasto, 2), now())
    on conflict (loja_id, dia) do update set valor = excluded.valor, atualizado_em = now();
  end if;
  return new;
end $$;
revoke all on function public.ads_gasto_para_financeiro() from public, anon, authenticated;

drop trigger if exists ads_gasto_para_financeiro on public.ads_loja_dia;
create trigger ads_gasto_para_financeiro after insert or update of gasto on public.ads_loja_dia
  for each row execute function public.ads_gasto_para_financeiro();

-- acerta o que já estava congelado
update public.financeiro_ads_dia f set valor = round(a.gasto, 2), atualizado_em = now()
from public.ads_loja_dia a
where a.loja_id = f.loja_id and a.dia = f.dia and a.gasto is not null and round(a.gasto, 2) <> f.valor;

select cron.unschedule('financeiro-anuncios-3h');
