# Fornecedores

Nova ferramenta em `/fornecedores/`, com cartão na central e o mesmo login Supabase da central. Não altera as páginas das ferramentas existentes nem o arquivo compartilhado de configuração.

O acesso da interface e das funções de banco é limitado aos UUIDs de Lucas e Paulo indicados pelo proprietário. O cartão não usa as liberações genéricas de `acessos_apps`. Usuários não autorizados também são bloqueados no banco, independentemente do acesso direto à URL.

## Ativação

1. Revisar e aplicar `supabase/migrations/202611040001_fornecedores.sql` no projeto `imlgfmaqmzfonvbmlwpd`. É uma migração aditiva e transacional, de execução única. Não modifica as tabelas existentes.
2. Publicar esta branch pelo fluxo existente da central (Vercel). O site independente no Netlify não é alterado por este commit.
3. Entrar na central como Lucas e Paulo, abrir o cartão Fornecedores e verificar o banco inicialmente vazio. Não importar automaticamente a demonstração do navegador.
4. Validar negação para os outros usuários. A sessão é compartilhada apenas no mesmo domínio da central.

Não colocar chaves secretas ou `service_role` no navegador. `bootstrap.js` reutiliza a chave publicável de `js/config.js`.

## Implementado nesta etapa

Fornecedores, produtos, histórico de preços, compras com um produto por registro, pagamentos, abatimentos, cancelamentos, extrato mensal e consultas. A gravação ocorre em transação com revisão otimista e auditoria de autoria gerada no servidor. Exclusão de movimentos e substituição de preços antigos são bloqueadas no banco.

O rateio dos pagamentos por mês é calculado a partir dos dados persistidos; não marca uma notinha individual como quitada. Retenção de arquivos, agrupamento de múltiplos itens por notinha, importação de planilhas e relatórios avançados continuam sendo evoluções posteriores.

## Verificação

Migração executada e validada em PostgreSQL local via PGlite com simulação de `auth.uid()`: Lucas e Paulo autorizados, Ana negada, acesso direto às tabelas negado, revisão concorrente rejeitada, valor total e quantidade conferidos, preço histórico preservado, cancelamento persistido, reativação/exclusão bloqueadas e auditoria gerada. A sintaxe de todos os scripts foi verificada com `node --check`.

As migrações 001 e 002 foram aplicadas no Supabase remoto. A segunda mantém as permissões e os registros, exige revisão válida, limita o total ao intervalo de precisão suportado e impede cadastros duplicados por caixa/espaços.

## Revisão de qualidade — 04/11/2026

- Seletores com menu próprio, busca a partir de sete opções, teclado, foco visível e campos alinhados; navegação lateral do desktop preservada.
- Entradas monetárias em centavos inteiros, conversão decimal exata e bloqueio de valores inválidos; quantidades inteiras e datas reais.
- Formulários mantidos abertos em falhas, gravação única por vez, IDs estáveis nas tentativas e reconciliação quando a resposta de uma gravação se perde.
- Conflitos entre usuários atualizam a base e exigem nova conferência; gravações confirmadas não são desfeitas por falhas na atualização seguinte.
- Relatórios e CSV usam o mesmo período, saldo anterior e saldo final. O resumo mensal continua mostrando todas as competências.
- Preço atual e sugestão da compra respeitam a data de vigência; históricos continuam preservados.

Executar testes sem dependências: `node --test fornecedores/tests/*.test.mjs` (12 cenários). Também foram executados testes PostgreSQL locais das duas migrações e testes transacionais com reversão no Supabase. Conferências de interface com dados fictícios: seleção, teclado, preço dependente, rejeição de terceira casa decimal, compra de 3 × R$ 0,10 e relatório por período. Layout móvel conferido em 390 × 844, sem transbordamento horizontal.

Essas verificações cobrem os cenários descritos; não constituem garantia de ausência absoluta de erros. Vencimentos negociados e importação continuam fora desta revisão.

## Comprovantes e cabeçalho compacto

A migração 003 cria o bucket privado `fin-comprovantes`, a tabela de metadados e funções de vinculação/consulta. Somente os administradores já autorizados do financeiro podem enviar ou baixar arquivos; políticas restritivas isolam este bucket de políticas permissivas de outras ferramentas. Não há URL pública, atualização, sobrescrita ou exclusão de arquivos pelo navegador.

O formulário de pagamento aceita um PDF, JPG ou PNG opcional, de até 5 MB, validado por formato, assinatura e tamanho. A lista de Pagamentos permite adicionar outros comprovantes e baixar os existentes; pagamentos cancelados preservam a consulta dos arquivos. O pagamento é confirmado antes do upload. Se o arquivo falhar, a mensagem explica que o pagamento foi salvo e mantém o formulário para tentar novamente, com o mesmo ID. Tentativas de upload do mesmo arquivo reutilizam o caminho e a vinculação é idempotente.

O cabeçalho usa ícones de Central, Atualizar e Sair, com rótulos ao passar o mouse ou focar pelo teclado e avatar da conta no desktop. Os rótulos acessíveis permanecem nos botões.

## Retenção de 90 dias — preparada, aguardando ativação

As migrações 004 e 005 e a função `fin-comprovantes-limpar` preparam a limpeza diária às 06:00 UTC. O job `fin-comprovantes-retencao90d` é criado **inativo** e `fin_receipt_retention.enabled` inicia em **false**. A função valida uma chave exclusiva gerada no servidor e guardada no Vault; nenhuma chave é gravada no repositório. A verificação JWT da plataforma permanece habilitada.

A rotina seleciona até 100 comprovantes vinculados por execução, com 90 dias completos desde `created_at`, usa a API de Storage somente no bucket `fin-comprovantes` e marca `deleted_at` apenas após a remoção confirmada. O nome, data, autor e vínculo continuam no histórico. Pagamentos, valores, saldos e demais ferramentas não são alterados. Falhas mantêm o registro elegível para nova tentativa; uma consulta malsucedida impede exclusões. Arquivos órfãos sem vínculo não entram nesta rotina.

`select public.fin_receipt_cleanup_request(true);` dispara uma simulação. O ID retornado permite conferir `status_code`, `content` e `error_msg` em `net._http_response`. A função registra o resumo nos logs do Supabase. Uma execução definitiva solicitada com o controle desativado é recusada com HTTP 409; chamadas com chave incorreta retornam 401.

Após confirmação explícita da exclusão definitiva, a ativação consiste em uma transação que atualiza `fin_receipt_retention.enabled=true` e executa `cron.alter_job` com `active:=true` para este job. Não executar esta etapa como parte das migrações de preparação. Para impedir novas execuções, desativar o job e o controle na mesma transação.

Verificações: 24 testes Node; PostgreSQL local para autenticação, preservação de metadados e bloqueio de reutilização de caminhos removidos; função implantada e simulação real com HTTP 200, zero candidatos/removidos/falhas. A interface mostra o aviso de remoção e não oferece download para arquivos expirados, conferida localmente com dados fictícios. Não foi executada exclusão física real nos testes.

Agora são 17 testes Node, incluindo validação de arquivo, limites, resposta perdida, falha e envio simultâneo. A migração foi testada em PostgreSQL local e aplicada no Supabase; privacidade e negação de acesso foram conferidas remotamente sem anexar documentos reais. O fluxo de seleção, gravação, consulta e download foi conferido em ambiente local isolado com PDF fictício. Exclusão automática após seis meses ainda não está ativada.
