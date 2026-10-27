# Central Sandstride

Site estático (sem build) com login único e as ferramentas da empresa.

- `/` central de ferramentas, login e quem acessa o quê (administradores)
- `/precificacao/` app de precificação (usa as planilhas do Google como base de dados)
- `supabase/functions/planilha` função que lê e grava nas planilhas com a conta de serviço do Google

Segredos no Supabase (Edge Functions → Secrets): `GOOGLE_SERVICE_ACCOUNT`.
Base de teste: abra `/precificacao/?base=teste`.
