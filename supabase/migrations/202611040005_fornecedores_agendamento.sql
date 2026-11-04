-- Prepara agendamento INATIVO. A ativação definitiva exige conferência separada.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$declare token text;begin
 select decrypted_secret into token from vault.decrypted_secrets where name='fin_receipt_cron_secret';
 if token is null then
  token:=gen_random_uuid()::text||gen_random_uuid()::text;
  perform vault.create_secret(token,'fin_receipt_cron_secret','Autenticação exclusiva da retenção de comprovantes');
 end if;
 update public.fin_receipt_retention set token_hash=sha256(convert_to(token,'UTF8')) where id;
end $$;
create function public.fin_receipt_cleanup_request(simulate boolean default true) returns bigint
language plpgsql security definer set search_path='' as $$
declare token text;request_id bigint;
begin
 select decrypted_secret into token from vault.decrypted_secrets where name='fin_receipt_cron_secret';
 if token is null then raise exception 'Chave de agendamento não configurada';end if;
 select net.http_post(
  url:='https://imlgfmaqmzfonvbmlwpd.supabase.co/functions/v1/fin-comprovantes-limpar',
  headers:=jsonb_build_object('Content-Type','application/json','apikey','sb_publishable_GLGEnDbAmqYtjiEbZ5KHEQ_HuFfxTdS','x-cleanup-secret',token),
  body:=jsonb_build_object('dryRun',simulate),timeout_milliseconds:=120000
 ) into request_id;
 return request_id;
end $$;
revoke all on function public.fin_receipt_cleanup_request(boolean) from public,anon,authenticated;
grant execute on function public.fin_receipt_cleanup_request(boolean) to service_role;
select cron.schedule('fin-comprovantes-retencao90d','0 6 * * *','select public.fin_receipt_cleanup_request(false);');
select cron.alter_job((select jobid from cron.job where jobname='fin-comprovantes-retencao90d'),active:=false);
commit;
