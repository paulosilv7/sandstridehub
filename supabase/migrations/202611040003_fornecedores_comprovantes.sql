-- Comprovantes privados, sem alterar os saldos nem as permissões existentes.
begin;
create table public.fin_receipts(
 id uuid primary key default gen_random_uuid(),
 entry_id text not null references public.fin_entries(id),
 path text not null unique,
 name text not null check(length(name) between 1 and 200),
 mime text not null check(mime in ('application/pdf','image/jpeg','image/png')),
 size bigint not null check(size between 1 and 5242880),
 created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id)
);
create index fin_receipts_entry on public.fin_receipts(entry_id);
alter table public.fin_receipts enable row level security;
revoke all on public.fin_receipts from anon,authenticated;
create function public.fin_receipt_access(object_path text,for_upload boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.fin_access where user_id=auth.uid())
 and exists(select 1 from public.fin_entries where id=split_part(object_path,'/',1) and type='payment' and (not for_upload or not cancelled));
$$;
revoke all on function public.fin_receipt_access(text,boolean) from public,anon;
grant execute on function public.fin_receipt_access(text,boolean) to authenticated,anon;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('fin-comprovantes','fin-comprovantes',false,5242880,array['application/pdf','image/jpeg','image/png']);
create policy fin_receipt_upload on storage.objects for insert to authenticated
 with check(bucket_id='fin-comprovantes' and public.fin_receipt_access(name,true)
 and name ~ '^[^/]{1,100}/[0-9a-f-]{36}\.(pdf|png|jpg)$');
create policy fin_receipt_download on storage.objects for select to authenticated
 using(bucket_id='fin-comprovantes' and public.fin_receipt_access(name,false));
-- Políticas restritivas isolam este bucket mesmo se outra ferramenta tiver uma
-- política permissiva de Storage. Os demais buckets mantêm o comportamento atual.
create policy fin_receipt_guard_read on storage.objects as restrictive for select to public
 using(bucket_id<>'fin-comprovantes' or public.fin_receipt_access(name,false));
create policy fin_receipt_guard_insert on storage.objects as restrictive for insert to public
 with check(bucket_id<>'fin-comprovantes' or (public.fin_receipt_access(name,true) and name ~ '^[^/]{1,100}/[0-9a-f-]{36}\.(pdf|png|jpg)$'));
create policy fin_receipt_guard_update on storage.objects as restrictive for update to public
 using(bucket_id<>'fin-comprovantes') with check(bucket_id<>'fin-comprovantes');
create policy fin_receipt_guard_delete on storage.objects as restrictive for delete to public
 using(bucket_id<>'fin-comprovantes');
create function public.fin_receipts_read() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then raise exception 'Acesso ao financeiro não autorizado' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'entryId',entry_id,'path',path,'name',name,'mime',mime,'size',size,'createdAt',created_at) order by created_at,id) from public.fin_receipts),'[]'::jsonb);
end $$;
create function public.fin_receipt_link(entry_id text,object_path text,file_name text,mime_type text,byte_size bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actual jsonb; result public.fin_receipts;
begin
 if not public.fin_receipt_access(object_path,true) or split_part(object_path,'/',1) is distinct from entry_id then raise exception 'Pagamento não autorizado para anexo' using errcode='42501';end if;
 if object_path !~ '^[^/]{1,100}/[0-9a-f-]{36}\.(pdf|png|jpg)$' then raise exception 'Caminho de comprovante inválido';end if;
 select metadata into actual from storage.objects where bucket_id='fin-comprovantes' and name=object_path;
 if not found then raise exception 'O arquivo ainda não foi recebido. Tente enviar novamente.';end if;
 if (actual->>'size')::bigint is distinct from byte_size or actual->>'mimetype' is distinct from mime_type then raise exception 'Os dados do arquivo não conferem';end if;
 insert into public.fin_receipts as r(entry_id,path,name,mime,size,created_by)
 values(entry_id,object_path,file_name,mime_type,byte_size,auth.uid()) on conflict(path) do nothing;
 select * into result from public.fin_receipts where path=object_path;
 return jsonb_build_object('id',result.id,'entryId',result.entry_id,'path',result.path,'name',result.name,'mime',result.mime,'size',result.size,'createdAt',result.created_at);
end $$;
revoke all on function public.fin_receipts_read() from public,anon;
revoke all on function public.fin_receipt_link(text,text,text,text,bigint) from public,anon;
grant execute on function public.fin_receipts_read() to authenticated;
grant execute on function public.fin_receipt_link(text,text,text,text,bigint) to authenticated;
commit;
