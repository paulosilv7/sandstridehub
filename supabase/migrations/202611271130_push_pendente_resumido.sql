-- Aviso do pedido para aprovação: só fornecedor, data, pares e valor total (sem a lista de modelos).
update public.push_textos set corpo = '{data} · {pares} · {total}', variaveis = '{fornecedor} {data} {pares} {total}' where tipo = 'pendente_novo';
