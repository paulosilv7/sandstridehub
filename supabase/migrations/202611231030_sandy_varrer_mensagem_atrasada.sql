-- Mensagem que o marketplace entregou atrasada (ex.: a leitura do ML ficou parada à noite e a pergunta das 01h20 só entrou às 08h05)
-- nunca era atendida: a Sandy só olhava a hora em que o cliente escreveu. Agora também vale a hora em que a mensagem chegou ao sistema,
-- desde que a conversa já existisse (não é histórico importado) e a mensagem seja das últimas 24 h.
create or replace function public.sandy_varrer()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r record;
begin
  if not exists (select 1 from public.configuracoes where chave='sandy_ativa' and valor='true') then return; end if;
  for r in
    select c.id from public.conversas c join public.lojas l on l.id=c.loja_id
    where l.sandy_ativa and c.atendente_id is null and not coalesce(c.bloqueada,false)
      and c.ultima_mensagem_de='cliente' and c.aguardando_resposta
      and (
        c.ultima_mensagem_em between now()-interval '25 minutes' and now()-interval '2 minutes'
        or exists (select 1 from public.mensagens m where m.conversa_id=c.id and m.de='cliente' and m.enviada_em=c.ultima_mensagem_em
                   and m.criado_em between now()-interval '25 minutes' and now()-interval '2 minutes'
                   and m.enviada_em > now()-interval '24 hours' and m.criado_em - c.criado_em > interval '2 minutes')
      )
      and c.escalada_motivo is null
      and not exists (select 1 from public.sandy_registros g where g.conversa_id=c.id and g.criado_em > c.ultima_mensagem_em)
    limit 10
  loop
    perform public.sandy_disparar(r.id);
  end loop;
end $function$;
