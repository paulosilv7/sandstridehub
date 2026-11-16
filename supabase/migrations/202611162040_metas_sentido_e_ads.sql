-- Metas "quanto menor, melhor" + fontes automáticas do Gestor de Ads (custo por pedido e gasto)
alter table public.central_metas add column if not exists sentido text not null default 'subir' check (sentido in ('subir','descer'));
alter table public.central_metas drop constraint if exists central_metas_fonte_check;
alter table public.central_metas add constraint central_metas_fonte_check
  check (fonte in ('manual','faturamento','lucro','pedidos','pares','custo_ads_pedido','gasto_ads'));
-- metas_atualizar_auto() e push_meta() atualizadas (ver migração aplicada "metas_sentido_e_ads")
