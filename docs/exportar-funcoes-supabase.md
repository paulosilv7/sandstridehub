# Guardar no GitHub as funções do Supabase

Hoje 22 das 39 funções do Supabase existem só lá dentro, sem cópia aqui. Este passo a passo baixa o código e guarda na pasta `supabase/functions/`.

## Antes de começar (uma vez só)
1. Instale o Supabase CLI no computador. No Mac: `brew install supabase/tap/supabase`.
2. Entre na conta: `supabase login` (abre o navegador; use a conta da Sandstride).

## Passo a passo
1. Abra o Terminal na pasta do repositório (`sandstridehub`) e atualize: `git pull`.
2. Rode: `./scripts/baixar-funcoes.sh`. Ele baixa as 22 funções para `supabase/functions/<nome>/index.ts`.
3. Confira o que mudou: `git status` (devem aparecer pastas novas em `supabase/functions/`).
4. Guarde no GitHub:
   ```
   git add supabase/functions
   git commit -m "Backup das funções do Supabase"
   git push
   ```
5. Avise o Claude: ele confere se todas chegaram.

## Cuidados
- Não existem segredos dentro das funções (senhas ficam nas variáveis do Supabase). Mesmo assim, o Claude confere os arquivos antes de considerar concluído.
- As funções do financeiro de fornecedores (`fin-*`) já têm cópia e não entram nesta lista.
- Se o comando `functions download` pedir o Docker, tente atualizar o CLI (`brew upgrade supabase`); a opção `--use-api` dispensa o Docker nas versões recentes.
- Depois de qualquer mudança futura numa função, repita o processo para manter a cópia atualizada.
