-- O aviso de pedido ao fornecedor passa a sair quando o pedido chega para aprovação (pendente do WhatsApp),
-- para a equipe conferir pela própria notificação. Sai o aviso do lançamento aprovado.
drop trigger if exists ao_lancar_compra_push on public.fin_entries;
drop function if exists public.push_compra();

update public.push_textos set tipo = 'pendente_novo', nome = 'Pedido para aprovação',
  titulo = '📋 Pedido para aprovar: {fornecedor}', corpo = '{data} · {pares} · {total} · {itens}',
  variaveis = '{fornecedor} {data} {pares} {total} {itens}' where tipo = 'compra_lancada';
insert into public.push_textos (tipo, nome, titulo, corpo, variaveis)
values ('pendente_novo', 'Pedido para aprovação', '📋 Pedido para aprovar: {fornecedor}', '{data} · {pares} · {total} · {itens}', '{fornecedor} {data} {pares} {total} {itens}')
on conflict (tipo) do nothing;

-- Itens são gravados na mesma transação do pendente; o envio sai depois do commit, então já os encontra.
create or replace function public.push_pendente() returns trigger
language plpgsql security definer set search_path = public as
$$ declare o uuid;
begin
  for o in select id from novos where status = 'aberto' loop
    perform public.push_chamar(jsonb_build_object('tipo','pendente','id', o));
  end loop;
  return null;
end $$;
drop trigger if exists ao_chegar_pendente_push on public.wa_pendentes;
create trigger ao_chegar_pendente_push after insert on public.wa_pendentes
  referencing new table as novos for each statement execute function public.push_pendente();
