#!/usr/bin/env bash
# Baixa do Supabase as funções que ainda não têm cópia neste repositório.
# Uso: ./scripts/baixar-funcoes.sh   (na raiz do repositório, com o Supabase CLI instalado e logado)
set -euo pipefail
REF="imlgfmaqmzfonvbmlwpd"
FUNCOES=(
  ml-callback ml-notificacoes ml-responder convidar-atendente
  lucro-ml-sync lucro-tiktok-sync lucro-shopee-sync
  devol-ml-sincronizar devol-tiktok-sincronizar devol-shopee-sincronizar devol-limpar-fotos
  devol-sandy-analisar devol-ml-agir devol-sandy-opcoes devol-avisar-telegram
  devol-etapas-sincronizar devol-contestar devol-itens devol-ml-envios devol-aceitar-lote devol-conferir
  financeiro-anuncios
)
[ -f supabase/config.toml ] || supabase init   # se perguntar algo, responda n
supabase link --project-ref "$REF"
for f in "${FUNCOES[@]}"; do
  echo "Baixando $f ..."
  supabase functions download "$f" --use-api
done
echo "Pronto. Confira com: git status"
