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

O rateio dos pagamentos por mês é calculado a partir dos dados persistidos; não marca uma notinha individual como quitada. Comprovantes, retenção de arquivos, agrupamento de múltiplos itens por notinha, importação de planilhas e relatórios avançados continuam sendo evoluções posteriores.

## Verificação

Migração executada e validada em PostgreSQL local via PGlite com simulação de `auth.uid()`: Lucas e Paulo autorizados, Ana negada, acesso direto às tabelas negado, revisão concorrente rejeitada, valor total e quantidade conferidos, preço histórico preservado, cancelamento persistido, reativação/exclusão bloqueadas e auditoria gerada. A sintaxe de todos os scripts foi verificada com `node --check`.

Pendente: aplicação no Supabase remoto, teste de login real e validação visual da página integrada à central. A interface base foi previamente publicada e conferida no protótipo independente.
