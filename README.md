# Central Sandstride

Site estático (sem build) com login único e as ferramentas da empresa.

- `/` central de ferramentas, login e quem acessa o quê (administradores)
- `/precificacao/` app de precificação (usa as planilhas do Google como base de dados)
- `supabase/functions/planilha` função que lê e grava nas planilhas com a conta de serviço do Google

Segredos no Supabase (Edge Functions → Secrets): `GOOGLE_SERVICE_ACCOUNT`.
Base de teste: abra `/precificacao/?base=teste`.

## Design
Todas as telas seguem o Briefing de design Sandstride v2 (aprovado em 14/11/2026).
- `css/sistema.css` base do briefing: tokens nos temas claro e escuro, listrado, valor com centavos apagados, tag, botão, seletor em pílula e movimento. Carregar antes do css de cada ferramenta.
- A Central (`index.html`, `css/hub.css`, `js/hub.js`) é a primeira tela migrada. As demais ferramentas ainda usam `css/design.css` e `css/dock.css` e entram uma por vez.
