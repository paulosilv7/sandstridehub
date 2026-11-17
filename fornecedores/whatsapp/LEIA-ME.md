# WhatsApp dos fornecedores (leitura) — instalação no PC da empresa (Windows)

A Sandy só LÊ os grupos. Nada é enviado ao WhatsApp. O PC só faz chamadas de saída ao Supabase.

## 1. Preparar o Windows (uma vez)
1. Instalar o **Docker Desktop** e ativar "Start Docker Desktop when you sign in to your computer" (Configurações > General).
2. Impedir que o PC durma: no PowerShell como administrador, `powercfg /change standby-timeout-ac 0` e `powercfg /change hibernate-timeout-ac 0`.
3. Criar a pasta `C:\waha` e colocar nela `docker-compose.yml` e o arquivo `.env` (com as duas chaves recebidas).

## 2. Subir
No PowerShell, dentro de `C:\waha`: `docker compose up -d`.
Abrir `http://localhost:3000`, iniciar a sessão `default` e ler o QR Code com o **chip dedicado** (WhatsApp > Aparelhos conectados).

## 3. Entrar nos grupos
Pôr o chip dedicado nos grupos da W-Box e da Pechincha Livre. Ele só lê; não escreve.

## 4. Conferir
- `docker compose ps` deve mostrar `waha-fornecedores` como `running`.
- Mandar uma mensagem de teste no formato de lançamento e ver aparecer no quadro "Pendentes do WhatsApp", no Painel de Fornecedores, logo abaixo do saldo devedor total (depois do fechamento das 17h, ou na hora se já passou das 17h).

## Atualizar / reiniciar
`docker compose pull` e `docker compose up -d`. O login do WhatsApp fica em `waha-sessions` e não se perde.

## A confirmar no primeiro teste (não verificado ainda)
- Qual campo do WAHA traz o remetente em grupo (o Supabase grava o que chegar para a gente preencher os remetentes autorizados).
- Se a engine NOWEB lê grupos de forma estável; se não, trocar para WEBJS no compose.
- Se há como o WAHA não guardar mensagens em disco.
- Configuração de novas tentativas do webhook no WAHA.
