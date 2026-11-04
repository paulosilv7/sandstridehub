-- Sandstride Financeiro. Migração aditiva: nenhuma tabela da central é alterada.
-- Executar uma única vez, no projeto imlgfmaqmzfonvbmlwpd.
begin;
create table public.fin_access (
 user_id uuid primary key references auth.users(id),
 role text not null check (role = 'admin'),
 created_at timestamptz not null default now()
);
create table public.fin_control (
 id boolean primary key default true check(id),
 revision bigint not null default 0
);
insert into public.fin_control(id) values(true);
create table public.fin_suppliers (
 name text primary key check(length(btrim(name)) between 1 and 200),
 created_at timestamptz not null default now()
);
create table public.fin_products (
 id text primary key check(length(id) between 1 and 100),
 supplier text not null references public.fin_suppliers(name),
 name text not null check(length(btrim(name)) between 1 and 200),
 unique(supplier,name),
 created_at timestamptz not null default now()
);
create table public.fin_prices (
 product_id text not null references public.fin_products(id),
 valid_from date not null,
 cents bigint not null check(cents between 1 and 9007199254740991),
 primary key(product_id,valid_from),
 created_at timestamptz not null default now()
);
create table public.fin_entries (
 id text primary key check(length(id) between 1 and 100),
 type text not null check(type in ('purchase','payment','credit')),
 date date not null,
 supplier text not null references public.fin_suppliers(name),
 product text,
 qty bigint,
 unit bigint,
 value bigint not null check(value between 1 and 9007199254740991),
 note text not null default '' check(length(note)<=5000),
 cancelled boolean not null default false,
 created_at timestamptz not null default now(),
 check ((type='purchase' and product is not null and qty is not null and unit is not null and qty>0 and unit>0
         and qty::numeric*unit::numeric=value::numeric)
     or (type<>'purchase' and qty is null and unit is null and product is null))
);
create index fin_entries_supplier_date on public.fin_entries(supplier,date);
create table public.fin_history (
 id bigint generated always as identity primary key,
 actor uuid references auth.users(id),
 at timestamptz not null default now(),
 entity text not null,
 operation text not null,
 old_record jsonb,
 new_record jsonb
);

-- Sem política pública: tabelas só podem ser acessadas pelas funções abaixo.
alter table public.fin_access enable row level security;
alter table public.fin_control enable row level security;
alter table public.fin_suppliers enable row level security;
alter table public.fin_products enable row level security;
alter table public.fin_prices enable row level security;
alter table public.fin_entries enable row level security;
alter table public.fin_history enable row level security;
revoke all on public.fin_access,public.fin_control,public.fin_suppliers,
 public.fin_products,public.fin_prices,public.fin_entries,public.fin_history from anon,authenticated;

create function public.fin_audit_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.fin_history(actor,entity,operation,old_record,new_record)
 values(auth.uid(),tg_table_name,tg_op,
 case when tg_op='INSERT' then null else to_jsonb(old) end,
 case when tg_op='DELETE' then null else to_jsonb(new) end);
 return new;
end $$;
revoke all on function public.fin_audit_trigger() from public,anon,authenticated;
create trigger fin_suppliers_audit after insert or update on public.fin_suppliers
 for each row execute function public.fin_audit_trigger();
create trigger fin_products_audit after insert or update on public.fin_products
 for each row execute function public.fin_audit_trigger();
create trigger fin_prices_audit after insert on public.fin_prices
 for each row execute function public.fin_audit_trigger();
create trigger fin_entries_audit after insert or update on public.fin_entries
 for each row execute function public.fin_audit_trigger();

create function public.fin_read() returns jsonb
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
   'prices',coalesce((select jsonb_agg(jsonb_build_object('date',v.valid_from,'value',v.cents) order by v.valid_from)
     from public.fin_prices v where v.product_id=p.id),'[]'::jsonb)) order by p.created_at,p.id)
   from public.fin_products p),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'type',e.type,'date',e.date,
  'supplier',e.supplier,'product',e.product,'qty',e.qty,'unit',e.unit,'value',e.value,
  'note',e.note,'cancelled',e.cancelled) order by e.date,e.created_at,e.id) from public.fin_entries e),'[]'::jsonb),
 'audit','[]'::jsonb) into result from public.fin_control c where id;
 return result;
end $$;
revoke all on function public.fin_read() from public,anon;
grant execute on function public.fin_read() to authenticated;

create function public.fin_commit(expected_revision bigint, payload jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare current_revision bigint; r jsonb; pr jsonb; old_price public.fin_prices;
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then
  raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';
 end if;
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
 for r in select value from jsonb_array_elements(payload->'suppliers') loop
  if jsonb_typeof(r)<>'string' then raise exception 'Fornecedor inválido'; end if;
  insert into public.fin_suppliers(name) values(r#>>'{}') on conflict do nothing;
 end loop;
 for r in select value from jsonb_array_elements(payload->'products') loop
  if exists(select 1 from public.fin_products p where p.id=r->>'id'
    and (p.supplier is distinct from r->>'supplier' or p.name is distinct from r->>'name')) then
   raise exception 'Alteração de identidade de produto não permitida';
  end if;
  insert into public.fin_products(id,supplier,name) values(r->>'id',r->>'supplier',r->>'name')
   on conflict do nothing;
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
revoke all on function public.fin_commit(bigint,jsonb) from public,anon;
grant execute on function public.fin_commit(bigint,jsonb) to authenticated;

-- Autorização específica solicitada pelo proprietário: somente Lucas e Paulo.
insert into public.fin_access(user_id,role) values
 ('ebccd17d-16d7-46cc-82cd-1622c3fd254d','admin'),
 ('0cd665bf-e4fb-4087-91a7-e5312cbafe6a','admin');
commit;
