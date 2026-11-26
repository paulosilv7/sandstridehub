-- Magalu entra como quarto marketplace do hub.
alter table public.lojas drop constraint if exists lojas_marketplace_check;
alter table public.lojas add constraint lojas_marketplace_check
  check (marketplace = any (array['mercado_livre'::text, 'shopee'::text, 'tiktok_shop'::text, 'magalu'::text]));
