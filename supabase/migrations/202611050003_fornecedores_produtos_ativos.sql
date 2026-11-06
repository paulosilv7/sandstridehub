-- Permite inativar produtos sem apagar preços ou compras históricas.
begin;

alter table public.fin_products
 add column active boolean not null default true;

create or replace function public.fin_read() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then
  raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';
 end if;
 select jsonb_build_object(
 'revision',c.revision,
 'suppliers',coalesce((select jsonb_agg(name order by name) from public.fin_suppliers),'[]'::jsonb),
 'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'supplier',p.supplier,'name',p.name,
   'active',p.active,
   'prices',coalesce((select jsonb_agg(jsonb_build_object('date',v.valid_from,'value',v.cents) order by v.valid_from)
     from public.fin_prices v where v.product_id=p.id),'[]'::jsonb)) order by p.created_at,p.id)
   from public.fin_products p),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'type',e.type,'date',e.date,
  'supplier',e.supplier,'product',e.product,'qty',e.qty,'unit',e.unit,'value',e.value,
  'note',e.note,'cancelled',e.cancelled) order by e.date,e.created_at,e.id) from public.fin_entries e),'[]'::jsonb),
 'audit','[]'::jsonb) into result from public.fin_control c where id;
 return result;
end $$;

create or replace function public.fin_commit(expected_revision bigint, payload jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare current_revision bigint; r jsonb; pr jsonb; old_price public.fin_prices;
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then
  raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';
 end if;
 if expected_revision is null or expected_revision<0 then raise exception 'Revisão obrigatória para evitar sobrescritas' using errcode='40001';end if;
 select revision into current_revision from public.fin_control where id for update;
 if current_revision<>expected_revision then
  raise exception 'Outro usuário atualizou os dados. Recarregue e repita o lançamento.' using errcode='40001';
 end if;
 if jsonb_typeof(payload->'suppliers') is distinct from 'array'
  or jsonb_typeof(payload->'products') is distinct from 'array'
  or jsonb_typeof(payload->'entries') is distinct from 'array' then
  raise exception 'Estrutura inválida';
 end if;
 if exists(select 1 from public.fin_entries e where not exists(
   select 1 from jsonb_array_elements(payload->'entries') j where j->>'id'=e.id)) then
  raise exception 'Registros financeiros não podem ser excluídos; utilize cancelamento.';
 end if;
 if (select count(*) from jsonb_array_elements(payload->'entries')) <>
  (select count(distinct j->>'id') from jsonb_array_elements(payload->'entries') j) then
  raise exception 'Registros duplicados';
 end if;
 if (select coalesce(sum((j->>'value')::numeric),0) from jsonb_array_elements(payload->'entries') j where not coalesce((j->>'cancelled')::boolean,false))>9007199254740991 then raise exception 'O total excede o limite de precisão permitido';end if;
 for r in select value from jsonb_array_elements(payload->'suppliers') loop
  if jsonb_typeof(r)<>'string' then raise exception 'Fornecedor inválido'; end if;
  insert into public.fin_suppliers(name) values(r#>>'{}') on conflict(name) do nothing;
 end loop;
 for r in select value from jsonb_array_elements(payload->'products') loop
  if jsonb_typeof(coalesce(r->'active','true'::jsonb)) is distinct from 'boolean' then
   raise exception 'Situação de produto inválida';
  end if;
  if exists(select 1 from public.fin_products p where p.id=r->>'id'
    and (p.supplier is distinct from r->>'supplier' or p.name is distinct from r->>'name')) then
   raise exception 'Alteração de identidade de produto não permitida';
  end if;
  insert into public.fin_products as p(id,supplier,name,active)
   values(r->>'id',r->>'supplier',r->>'name',coalesce((r->>'active')::boolean,true))
  on conflict(id) do update set active=excluded.active
  where p.active is distinct from excluded.active;
  if jsonb_typeof(r->'prices') is distinct from 'array' or jsonb_array_length(r->'prices')=0 then
   raise exception 'Produto sem preço';
  end if;
  for pr in select value from jsonb_array_elements(r->'prices') loop
   select * into old_price from public.fin_prices where product_id=r->>'id' and valid_from=(pr->>'date')::date;
   if found and old_price.cents<>(pr->>'value')::bigint then
    raise exception 'Preços históricos não podem ser substituídos';
   end if;
   if not found and exists(select 1 from public.fin_prices where product_id=r->>'id'
      and valid_from>=(pr->>'date')::date) then
    raise exception 'A nova vigência deve ser posterior ao último preço';
   end if;
   insert into public.fin_prices(product_id,valid_from,cents)
    values(r->>'id',(pr->>'date')::date,(pr->>'value')::bigint) on conflict do nothing;
  end loop;
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
  insert into public.fin_entries as e(id,type,date,supplier,product,qty,unit,value,note,cancelled)
   values(r->>'id',r->>'type',(r->>'date')::date,r->>'supplier',r->>'product',
    (r->>'qty')::bigint,(r->>'unit')::bigint,(r->>'value')::bigint,
    coalesce(r->>'note',''),coalesce((r->>'cancelled')::boolean,false))
  on conflict(id) do update set type=excluded.type,date=excluded.date,supplier=excluded.supplier,
    product=excluded.product,qty=excluded.qty,unit=excluded.unit,value=excluded.value,
    note=excluded.note,cancelled=excluded.cancelled
  where (e.type,e.date,e.supplier,e.product,e.qty,e.unit,e.value,e.note,e.cancelled)
   is distinct from (excluded.type,excluded.date,excluded.supplier,excluded.product,excluded.qty,
    excluded.unit,excluded.value,excluded.note,excluded.cancelled);
 end loop;
 update public.fin_control set revision=revision+1 where id returning revision into current_revision;
 return current_revision;
end $$;

revoke all on function public.fin_read() from public,anon;
grant execute on function public.fin_read() to authenticated;
revoke all on function public.fin_commit(bigint,jsonb) from public,anon;
grant execute on function public.fin_commit(bigint,jsonb) to authenticated;

commit;
