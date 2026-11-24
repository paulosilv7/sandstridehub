-- Vigência de preço livre: permite datas anteriores à última, corrigir o valor de uma vigência e trocar a data.
-- Compras e pagamentos já lançados guardam o próprio valor; só a sugestão de preço nas próximas compras muda.
-- Toda alteração e exclusão de preço fica no histórico (fin_history).
begin;

create or replace function public.fin_commit(expected_revision bigint, payload jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare current_revision bigint; r jsonb; pr jsonb; inactive_data jsonb;
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then
  raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';
 end if;
 if expected_revision is null or expected_revision<0 then raise exception 'Revisão obrigatória para evitar sobrescritas' using errcode='40001';end if;
 select revision into current_revision from public.fin_control where id for update;
 if current_revision<>expected_revision then
  raise exception 'Outro usuário atualizou os dados. Recarregue e repita o lançamento.' using errcode='40001';
 end if;
 inactive_data:=coalesce(payload->'inactiveSuppliers','[]'::jsonb);
 if jsonb_typeof(payload->'suppliers') is distinct from 'array'
  or jsonb_typeof(inactive_data) is distinct from 'array'
  or jsonb_typeof(payload->'products') is distinct from 'array'
  or jsonb_typeof(payload->'entries') is distinct from 'array' then
  raise exception 'Estrutura inválida';
 end if;
 if exists(select 1 from jsonb_array_elements(inactive_data) i
   where jsonb_typeof(i)<>'string' or not exists(
    select 1 from jsonb_array_elements(payload->'suppliers') s where s#>>'{}'=i#>>'{}')) then
  raise exception 'Situação de fornecedor inválida';
 end if;
 if exists(select 1 from public.fin_entries e where not exists(
   select 1 from jsonb_array_elements(payload->'entries') j where j->>'id'=e.id)) then
  raise exception 'Registros financeiros não podem ser excluídos; utilize cancelamento.';
 end if;
 if (select count(*) from jsonb_array_elements(payload->'entries')) <>
  (select count(distinct j->>'id') from jsonb_array_elements(payload->'entries') j) then
  raise exception 'Registros duplicados';
 end if;
 if exists(select 1 from jsonb_array_elements(payload->'entries') j
   where j ? 'purchaseOrderId' and j->'purchaseOrderId'<>'null'::jsonb and (
    jsonb_typeof(j->'purchaseOrderId')<>'string'
    or j->>'type'<>'purchase'
    or (j->>'purchaseOrderId') !~ '^OC-[0-9]{8}-[A-F0-9]{8}$')) then
  raise exception 'Ordem de compra inválida';
 end if;
 if exists(select 1 from jsonb_array_elements(payload->'entries') j
   where nullif(j->>'purchaseOrderId','') is not null
   group by j->>'purchaseOrderId'
   having count(distinct jsonb_build_array(j->>'supplier',j->>'date'))>1) then
  raise exception 'Itens da ordem de compra devem ter o mesmo fornecedor e a mesma data';
 end if;
 if exists(select 1 from public.fin_entries e
   join jsonb_array_elements(payload->'entries') j on j->>'id'=e.id
   where e.purchase_order_id is distinct from nullif(j->>'purchaseOrderId','')) then
  raise exception 'A ordem de compra de um lançamento não pode ser alterada';
 end if;
 if (select coalesce(sum((j->>'value')::numeric),0) from jsonb_array_elements(payload->'entries') j where not coalesce((j->>'cancelled')::boolean,false))>9007199254740991 then raise exception 'O total excede o limite de precisão permitido';end if;
 for r in select value from jsonb_array_elements(payload->'suppliers') loop
  if jsonb_typeof(r)<>'string' then raise exception 'Fornecedor inválido'; end if;
  insert into public.fin_suppliers(name) values(r#>>'{}') on conflict(name) do nothing;
 end loop;
 update public.fin_suppliers s set active=not exists(
   select 1 from jsonb_array_elements(inactive_data) i where i#>>'{}'=s.name)
 where exists(select 1 from jsonb_array_elements(payload->'suppliers') j where j#>>'{}'=s.name)
   and s.active is distinct from (not exists(
    select 1 from jsonb_array_elements(inactive_data) i where i#>>'{}'=s.name));
 for r in select value from jsonb_array_elements(payload->'products') loop
  if jsonb_typeof(coalesce(r->'active','true'::jsonb)) is distinct from 'boolean' then
   raise exception 'Situação de produto inválida';
  end if;
  if exists(select 1 from public.fin_products p where p.id=r->>'id'
    and (p.supplier is distinct from r->>'supplier' or p.name is distinct from r->>'name')) then
   raise exception 'Alteração de identidade de produto não permitida';
  end if;
  if not exists(select 1 from public.fin_products p where p.id=r->>'id')
    and not exists(select 1 from public.fin_suppliers s where s.name=r->>'supplier' and s.active) then
   raise exception 'Reative o fornecedor antes de cadastrar um produto';
  end if;
  insert into public.fin_products as p(id,supplier,name,active)
   values(r->>'id',r->>'supplier',r->>'name',coalesce((r->>'active')::boolean,true))
  on conflict(id) do update set active=excluded.active
  where p.active is distinct from excluded.active;
  if jsonb_typeof(r->'prices') is distinct from 'array' or jsonb_array_length(r->'prices')=0 then
   raise exception 'Produto sem preço';
  end if;
  for pr in select value from jsonb_array_elements(r->'prices') loop
   -- Vigência livre: aceita datas anteriores, corrige o valor de uma data existente e a troca de data (a linha antiga some do payload).
   insert into public.fin_prices(product_id,valid_from,cents)
    values(r->>'id',(pr->>'date')::date,(pr->>'value')::bigint)
   on conflict(product_id,valid_from) do update set cents=excluded.cents
   where public.fin_prices.cents is distinct from excluded.cents;
  end loop;
  delete from public.fin_prices v where v.product_id=r->>'id'
   and v.valid_from not in (select (x->>'date')::date from jsonb_array_elements(r->'prices') x);
 end loop;
 for r in select value from jsonb_array_elements(payload->'entries') loop
  if exists(select 1 from public.fin_entries e where e.id=r->>'id' and e.cancelled
    and not coalesce((r->>'cancelled')::boolean,false)) then
   raise exception 'Lançamento cancelado não pode ser reativado';
  end if;
  if r->>'type'='purchase' and not exists(select 1 from public.fin_products p
   where p.supplier=r->>'supplier' and p.name=r->>'product') then
   raise exception 'Produto não pertence ao fornecedor';
  end if;
  if r->>'type'='purchase' and not exists(select 1 from public.fin_entries e where e.id=r->>'id')
    and not exists(select 1 from public.fin_suppliers s where s.name=r->>'supplier' and s.active) then
   raise exception 'Reative o fornecedor antes de registrar uma compra';
  end if;
  insert into public.fin_entries as e(id,type,date,supplier,product,qty,unit,value,note,cancelled,purchase_order_id)
   values(r->>'id',r->>'type',(r->>'date')::date,r->>'supplier',r->>'product',
    (r->>'qty')::bigint,(r->>'unit')::bigint,(r->>'value')::bigint,
    coalesce(r->>'note',''),coalesce((r->>'cancelled')::boolean,false),nullif(r->>'purchaseOrderId',''))
  on conflict(id) do update set type=excluded.type,date=excluded.date,supplier=excluded.supplier,
    product=excluded.product,qty=excluded.qty,unit=excluded.unit,value=excluded.value,
    note=excluded.note,cancelled=excluded.cancelled,purchase_order_id=excluded.purchase_order_id
  where (e.type,e.date,e.supplier,e.product,e.qty,e.unit,e.value,e.note,e.cancelled,e.purchase_order_id)
   is distinct from (excluded.type,excluded.date,excluded.supplier,excluded.product,excluded.qty,
    excluded.unit,excluded.value,excluded.note,excluded.cancelled,excluded.purchase_order_id);
 end loop;
 update public.fin_control set revision=revision+1 where id returning revision into current_revision;
 return current_revision;
end $$;


drop trigger if exists fin_prices_audit on public.fin_prices;
create trigger fin_prices_audit after insert or update or delete on public.fin_prices
 for each row execute function public.fin_audit_trigger();

drop trigger if exists est_custo_segue_fornecedor on public.fin_prices;
create trigger est_custo_segue_fornecedor after insert or update of cents, valid_from or delete on public.fin_prices
 for each statement execute function public.est_trg_custos();

revoke all on function public.fin_commit(bigint,jsonb) from public,anon;
grant execute on function public.fin_commit(bigint,jsonb) to authenticated;

commit;
