# Backup de Fornecedores

Destino privado: Google Sheets, documento `182yKDy7L4qhqBhu7ILRCfw5y-By4JMa-nMECznPQJxw`.
Somente dados desta ferramenta: fornecedores, produtos, preços com vigência, lançamentos
(inclusive cancelados), datas de criação e auditoria. Não inclui comprovantes, usuários,
credenciais, permissões nem dados das outras ferramentas. Não é backup completo do projeto Supabase.

## Funcionamento

O job `fin-backup-fornecedores` verifica alterações a cada cinco minutos, no servidor.
A função obtém uma posição consistente sob a mesma trava de revisão de `fin_commit`.
Alterações posteriores entram na execução seguinte. Não depende do navegador aberto.
O intervalo representa uma janela de possível perda: uma alteração ainda não copiada
não está protegida no Google. Indisponibilidade dos serviços pode ampliar essa janela.

A aba Resumo apresenta totais e saldos por fornecedor. Fornecedores, Produtos, Precos,
Lancamentos e Historico são abas de consulta, com valores em reais e datas brasileiras.
A aba Controle e os IDs de lançamento ficam ocultos na consulta principal. As abas ocultas `v_REVISÃO` contêm
o JSON integral da posição e o SHA-256. Uma nova revisão cria uma nova aba, sem apagar
as anteriores. Se não houve alteração, a execução apenas atualiza a verificação;
não duplica cópias idênticas. Alterações entre verificações ficam na auditoria da próxima
posição; não se promete uma versão independente por clique nem recuperação por segundo.

A escrita das abas e da nova versão ocorre em um batch atômico do Sheets. A função
relê a versão, valida o hash e compara o texto antes de confirmar o sucesso no banco.
Se a resposta se perder, a mesma versão é conferida e reutilizada. Se houver falha,
o payload pendente permanece no banco para nova tentativa. Após confirmação, o payload
temporário é liberado; revisão, hash e datas permanecem no controle.

O aviso no site mostra pendência, falha ou a última cópia confirmada. A verificação do
aviso é feita ao carregar/salvar e a cada minuto. Nenhuma chave é entregue ao navegador.
O cron usa uma chave própria no Vault; a verificação JWT da Edge Function permanece ligada.
O usuário comum não pode ler as tabelas de controle nem invocar a rotina do servidor.

## Implantação e operação

1. Aplicar `202611050001_fornecedores_backup.sql` e
   `202611050002_fornecedores_backup_agendamento.sql` uma vez. O cron nasce inativo.
2. Implantar `fin-backup` com `index.ts` e `backup.mjs` (ou bundle equivalente).
3. Compartilhar somente o novo documento com a conta de serviço existente, como editor.
4. Configurar `fin_backup_config.spreadsheet_id` e `enabled=true`, fazer uma primeira
   execução com `select public.fin_backup_request()`, conferir a resposta específica
   em `net._http_response` e reler a versão no Google.
5. Ativar somente esse job com `cron.alter_job`. Não reaplicar a migração de agendamento
   sobre a instalação ativa, pois ela desativa o job por padrão.

Não publicar a planilha por link nem adicionar o documento à lista pública da função
`planilha`. O backup usa autorização própria, independente dessa ponte.
Não editar as abas automáticas ou excluí-las. Versões são ocultas apenas para organização,
não como proteção de acesso. Quem tem acesso ao arquivo pode consultar as versões.
Não há expurgo automático. Se a posição JSON ultrapassar 8 MB, ou houver limite do Google,
a função interrompe a confirmação e o site avisa; será necessário ampliar/rotacionar
o destino, preservando o arquivo anterior. Verificar a cópia antes de importar em volume.

## Recuperação

Nunca sobrescrever a produção como primeiro teste. Se necessário, reinstalar as migrações
da ferramenta em um projeto isolado. Ler a aba `v_REVISÃO`, coluna A, preservando a ordem,
e salvar a resposta de valores da API como JSON (`{"values":[...]}`). Executar:

```
node fornecedores/restore-backup.mjs versao.json conferencia.sql
```

O utilitário valida formato e SHA-256, e gera SQL para um schema `fin_restore_REVISÃO`
separado; não abre conexão, não apaga dados e não mexe nas tabelas de produção.
Executar no ambiente isolado e conferir contagens, vínculos, cancelamentos, preços e
saldos antes de planejar uma restauração de produção. Permissões e contas devem ser
recriadas separadamente. O script recusa sobrescrever um arquivo SQL já existente.

## Validação

`node --test fornecedores/tests/*.test.mjs`: 31 testes, incluindo perda de resposta,
retomada, falha Google, cópia divergente, caracteres Unicode, IDs grandes e valores exatos.
Migração validada em PostgreSQL local (PGlite), incluindo isolamento de acessos,
trava/lease, confirmação e recuperação de todas as tabelas em estruturas separadas.
A primeira versão real vazia também foi relida do Google e teve o SHA-256 conferido.
