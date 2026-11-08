#!/usr/bin/env bash
# Confere se as funções do Supabase estão guardadas em supabase/functions/ e se nenhuma tem segredo escrito no código.
# Uso: ./scripts/conferir-funcoes.sh   (na raiz do repositório)
cd "$(dirname "$0")/.."
ESPERADAS=(
  ml-callback ml-notificacoes ml-responder convidar-atendente
  lucro-ml-sync lucro-tiktok-sync lucro-shopee-sync
  devol-ml-sincronizar devol-tiktok-sincronizar devol-shopee-sincronizar devol-limpar-fotos
  devol-sandy-analisar devol-ml-agir devol-sandy-opcoes devol-avisar-telegram
  devol-etapas-sincronizar devol-contestar devol-itens devol-ml-envios devol-aceitar-lote devol-conferir
  financeiro-anuncios
)
faltam=0
for f in "${ESPERADAS[@]}"; do
  if [ -s "supabase/functions/$f/index.ts" ]; then echo "ok      $f"; else echo "FALTA   $f"; faltam=$((faltam+1)); fi
done
echo "---"
echo "Faltando: $faltam de ${#ESPERADAS[@]}"
echo "Procurando segredos escritos no código (chaves, tokens longos)..."
if grep -rEn "(eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|[0-9]{8,10}:[A-Za-z0-9_-]{30,}|service_role[\"' ]*[:=][\"' ]*[A-Za-z0-9._-]{30,})" supabase/functions --include=*.ts --include=*.mjs; then
  echo "ATENÇÃO: há possíveis segredos acima. Não faça push antes de avisar o Claude."; exit 1
else
  echo "Nenhum segredo encontrado."
fi
[ "$faltam" -eq 0 ]
