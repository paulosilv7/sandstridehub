-- Backup independente no Google Sheets. Não inclui comprovantes nem permissões.
begin;
create table public.fin_backup_config (
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 spreadsheet_id text check(spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
 token_hash bytea,
 last_revision bigint,
 last_success timestamptz,
 last_checked timestamptz,
 last_error text,
 lease_id uuid,
 lease_until timestamptz
);
insert into public.fin_backup_config(id) values(true);
create table public.fin_backup_versions (
 revision bigint primary key,
 captured_at timestamptz not null,
 payload jsonb,
 completed_at timestamptz,
 checksum text,
 check(checksum is null or checksum ~ '^[0-9a-f]{64}$')
);
alter table public.fin_backup_config enable row level security;
alter table public.fin_backup_versions enable row level security;
revoke all on public.fin_backup_config,public.fin_backup_versions from public,anon,authenticated;

-- Uma única consulta, sob a trava de revisão usada por fin_commit, gera a cópia.
create function public.fin_backup_snapshot() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('format','sandstride-fornecedores-v1',
 'revision',(select revision::text from public.fin_control where id),
 'suppliers',coalesce((select jsonb_agg(to_jsonb(t) order by name) from public.fin_suppliers t),'[]'::jsonb),
 'products',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.fin_products t),'[]'::jsonb),
 'prices',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('cents',cents::text) order by product_id,valid_from) from public.fin_prices t),'[]'::jsonb),
 'entries',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('qty',qty::text,'unit',unit::text,'value',value::text) order by date,created_at,id) from public.fin_entries t),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('id',id::text) order by id) from public.fin_history t),'[]'::jsonb));
$$;

create function public.fin_backup_claim(candidate text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.fin_backup_config; v public.fin_backup_versions; rev bigint; lease uuid;
begin
 select * into c from public.fin_backup_config where id for update;
 if c.token_hash is null or c.token_hash<>sha256(convert_to(candidate,'UTF8')) then raise exception 'Backup não autorizado' using errcode='42501';end if;
 if not c.enabled or c.spreadsheet_id is null then return jsonb_build_object('disabled',true);end if;
 if c.lease_until>now() then return jsonb_build_object('busy',true);end if;
 perform 1 from public.fin_control where id for update;
 select revision into rev from public.fin_control where id;
 -- Retoma primeiro uma cópia cuja resposta se perdeu, sem sobrescrevê-la.
 select * into v from public.fin_backup_versions where completed_at is null order by revision limit 1;
 if not found and c.last_revision is distinct from rev then
  insert into public.fin_backup_versions(revision,captured_at,payload)
  values(rev,now(),public.fin_backup_snapshot()) returning * into v;
 end if;
 update public.fin_backup_config set last_checked=now() where id;
 if v.revision is null then return jsonb_build_object('unchanged',true);end if;
 lease:=gen_random_uuid();
 update public.fin_backup_config set lease_id=lease,lease_until=now()+interval '10 minutes' where id;
 return jsonb_build_object('lease',lease,'spreadsheetId',c.spreadsheet_id,'revision',v.revision::text,'capturedAt',v.captured_at,'payload',v.payload);
end $$;

create function public.fin_backup_finish(candidate text,lease uuid,rev bigint,digest text,failure text default null) returns void
language plpgsql security definer set search_path='' as $$
declare c public.fin_backup_config;
begin
 select * into c from public.fin_backup_config where id for update;
 if c.token_hash is null or c.token_hash<>sha256(convert_to(candidate,'UTF8')) then raise exception 'Backup não autorizado' using errcode='42501';end if;
 if c.lease_id is distinct from lease then raise exception 'Execução expirada';end if;
 if failure is null then
  update public.fin_backup_versions set completed_at=now(),checksum=digest,payload=null where revision=rev and completed_at is null;
  if not found then raise exception 'Versão de backup inválida';end if;
  update public.fin_backup_config set last_revision=rev,last_success=now(),last_error=null,lease_id=null,lease_until=null where id;
 else
  update public.fin_backup_config set last_error=left(failure,300),lease_id=null,lease_until=null where id;
 end if;
end $$;

create function public.fin_backup_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.fin_access where user_id=auth.uid()) then raise exception 'Acesso não autorizado' using errcode='42501';end if;
 return (select jsonb_build_object('enabled',enabled,'spreadsheetId',spreadsheet_id,'lastRevision',last_revision::text,'currentRevision',(select revision::text from public.fin_control where id),'lastSuccess',last_success,'lastChecked',last_checked,'error',last_error) from public.fin_backup_config where id);
end $$;
revoke all on function public.fin_backup_snapshot(),public.fin_backup_claim(text),public.fin_backup_finish(text,uuid,bigint,text,text),public.fin_backup_status() from public,anon,authenticated;
grant execute on function public.fin_backup_claim(text),public.fin_backup_finish(text,uuid,bigint,text,text) to service_role;
grant execute on function public.fin_backup_status() to authenticated;
commit;
