-- Consolida os lançamentos históricos da PECHINCHA LIVRE por notinha diária.
-- Não altera datas, produtos, quantidades, preços, valores, pagamentos ou saldos.
begin;

do $$
declare
 targeted integer;
begin
 select count(*) into targeted
 from public.fin_entries
 where type='purchase'
   and supplier='PECHINCHA LIVRE'
   and date in (date '2026-11-03',date '2026-11-04')
   and not cancelled
   and purchase_order_id is null;

 if targeted<>6 then
  raise exception 'Agrupamento cancelado: eram esperados 6 itens históricos e foram encontrados %',targeted;
 end if;

 update public.fin_entries
 set purchase_order_id=case date
  when date '2026-11-03' then 'OC-20261103-1E42A41F'
  when date '2026-11-04' then 'OC-20261104-E6088A08'
 end
 where type='purchase'
   and supplier='PECHINCHA LIVRE'
   and date in (date '2026-11-03',date '2026-11-04')
   and not cancelled
   and purchase_order_id is null;
end $$;

update public.fin_control set revision=revision+1 where id;

commit;
