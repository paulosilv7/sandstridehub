-- O mediador do ML fecha a reclamação, mas a loja ainda precisa revisar o produto devolvido (return_review_ok) dentro do prazo.
-- A varredura de revisões (devol-ml-sincronizar) devolvia esses casos para NOVO e esta rotina os mandava de volta para DECIDIDO a cada 15 min,
-- escondendo as revisões pendentes. Agora o caso só vai para DECIDIDO se não houver revisão pendente para a loja.
create or replace function public.devol_fechar_resolvidos()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a int; b int; c int;
begin
  with alvo as (
    select cs.id from devol_casos cs join lojas l on l.id=cs.loja_id
    where l.marketplace='mercado_livre' and cs.arquivado_em is null
      and cs.status in ('NOVO','AGUARDANDO_ANALISE','AGUARDANDO_PROVAS','PREPARADO','RECURSO_DISPONIVEL','COMPLEMENTACAO','EM_ANALISE')
      and not (coalesce(cs.acoes_loja, '{}') && array['return_review_ok','return_review_unified_ok'])
      and (cs.situacao_mkt like 'Fechada%' or exists (select 1 from (select e.dados from devol_eventos e where e.caso_id=cs.id and e.tipo='leitura_marketplace' order by e.id desc limit 1) u where u.dados->>'status_ml'='closed' and u.dados->'resolucao'->>'closed_by'='mediator'))
  ), up as (update devol_casos cs set status='DECIDIDO', situacao_mkt='Encerrada pelo Mercado Livre', prazo_em=null from alvo where cs.id=alvo.id returning 1)
  select count(*) into a from up;
  with up as (update devol_casos cs set status='ENCERRADO', prazo_em=null from lojas l where l.id=cs.loja_id and l.marketplace='shopee' and cs.arquivado_em is null and cs.status in ('NOVO','AGUARDANDO_ANALISE','AGUARDANDO_PROVAS') and cs.tipo_origem='ACCEPTED' returning 1)
  select count(*) into b from up;
  with up as (update devol_casos cs set status='DECIDIDO', situacao_mkt='Pedido de devolução cancelado', prazo_em=null from lojas l where l.id=cs.loja_id and l.marketplace='shopee' and cs.arquivado_em is null and cs.status in ('NOVO','AGUARDANDO_ANALISE','AGUARDANDO_PROVAS','PREPARADO','EM_ANALISE') and cs.tipo_origem in ('CANCELLED','CLOSED') returning 1)
  select count(*) into c from up;
  return jsonb_build_object('ml',a,'shopee_aceitas',b,'shopee_canceladas',c);
end $function$;
