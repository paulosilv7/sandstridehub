-- Preparação somente: não agenda nem executa exclusão.
begin;
alter table public.fin_receipts add column deleted_at timestamptz;
create index fin_receipts_retention on public.fin_receipts(created_at) where deleted_at is null;
grant select,update on public.fin_receipts to service_role;
create table public.fin_receipt_retention(id boolean primary key default true check(id),enabled boolean not null default false,token_hash bytea);
insert into public.fin_receipt_retention(id) values(true);
alter table public.fin_receipt_retention enable row level security;
revoke all on public.fin_receipt_retention from public,anon,authenticated;
create function public.fin_receipt_cleanup_auth(candidate text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('valid',coalesce(token_hash=sha256(convert_to(candidate,'UTF8')),false),'enabled',enabled) from public.fin_receipt_retention where id;
$$;
revoke all on function public.fin_receipt_cleanup_auth(text) from public,anon,authenticated;
grant execute on function public.fin_receipt_cleanup_auth(text) to service_role;
create or replace function public.fin_receipt_access(object_path text,for_upload boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.fin_access where user_id=auth.uid())
 and exists(select 1 from public.fin_entries where id=split_part(object_path,'/',1) and type='payment' and (not for_upload or not cancelled))
 and not exists(select 1 from public.fin_receipts where path=object_path and deleted_at is not null);
$$;
create or replace function public.fin_receipts_read() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'entryId',entry_id,'path',path,'name',name,'mime',mime,'size',size,'createdAt',created_at,'deletedAt',deleted_at) order by created_at,id) from public.fin_receipts),'[]'::jsonb);
end $$;
commit;
