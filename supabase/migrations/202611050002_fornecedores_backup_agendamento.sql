-- Preparação apenas: o destino e a ativação são configurados após teste real.
begin;
do $$declare token text;begin
 select decrypted_secret into token from vault.decrypted_secrets where name='fin_backup_cron_secret';
 if token is null then token:=gen_random_uuid()::text||gen_random_uuid()::text;
  perform vault.create_secret(token,'fin_backup_cron_secret','Autenticação exclusiva do backup de Fornecedores');
 end if;
 update public.fin_backup_config set token_hash=sha256(convert_to(token,'UTF8')) where id;
end $$;
create function public.fin_backup_request() returns bigint
language plpgsql security definer set search_path='' as $$
declare token text;request_id bigint;
begin
 select decrypted_secret into token from vault.decrypted_secrets where name='fin_backup_cron_secret';
 if token is null then raise exception 'Chave de backup não configurada';end if;
 select net.http_post(url:='https://imlgfmaqmzfonvbmlwpd.supabase.co/functions/v1/fin-backup',
 headers:=jsonb_build_object('Content-Type','application/json','apikey','sb_publishable_GLGEnDbAmqYtjiEbZ5KHEQ_HuFfxTdS','x-backup-secret',token),
 body:='{}'::jsonb,timeout_milliseconds:=120000) into request_id;
 return request_id;
end $$;
revoke all on function public.fin_backup_request() from public,anon,authenticated;
grant execute on function public.fin_backup_request() to service_role;
select cron.schedule('fin-backup-fornecedores','*/5 * * * *','select public.fin_backup_request();');
select cron.alter_job((select jobid from cron.job where jobname='fin-backup-fornecedores'),active:=false);
commit;
