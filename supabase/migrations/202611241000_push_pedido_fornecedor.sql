-- Aviso no aparelho quando um pedido (ordem de compra) ao fornecedor é lançado no sistema.
alter table public.push_preferencias add column if not exists compras boolean not null default true;

insert into public.push_textos (tipo, nome, titulo, corpo, variaveis)
values ('compra_lancada', 'Pedido lançado ao fornecedor', '🛒 Pedido lançado: {fornecedor}', '{pares} · {total} · {data}', '{fornecedor} {pares} {total} {data}')
on conflict (tipo) do nothing;

-- Dispara uma vez por ordem de compra nova (statement-level: uma gravação com vários itens = um aviso)
create or replace function public.push_compra() returns trigger
language plpgsql security definer set search_path = public as
$$ declare o text;
begin
  for o in select distinct coalesce(purchase_order_id, id) from novos where type = 'purchase' and not coalesce(cancelled, false) loop
    perform public.push_chamar(jsonb_build_object('tipo','compra','ordem', o));
  end loop;
  return null;
end $$;
drop trigger if exists ao_lancar_compra_push on public.fin_entries;
create trigger ao_lancar_compra_push after insert on public.fin_entries
  referencing new table as novos for each statement execute function public.push_compra();
