// Conecta uma loja do Mercado Livre: recebe o código de autorização,
// troca por tokens e salva a loja e as credenciais no banco.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/ml-callback`;

const supabase = createClient(
  SUPABASE_URL,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function texto(msg: string, status = 200) {
  return new Response(msg, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const erro = url.searchParams.get("error");

  if (erro) return texto(`O Mercado Livre recusou a conexão: ${erro}`, 400);
  if (!code || !state) {
    return texto(
      "Faltam informações na conexão. Gere um novo link de conexão e tente de novo.",
      400,
    );
  }
  if (!CLIENT_SECRET) {
    return texto("A chave secreta do app ainda não foi configurada no Supabase.", 500);
  }

  // O código de segurança vale uma vez só e expira em 30 minutos.
  const limite = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: estado } = await supabase
    .from("autorizacoes_pendentes")
    .delete()
    .eq("state", state)
    .eq("marketplace", "mercado_livre")
    .gte("criado_em", limite)
    .select("state");
  if (!estado || estado.length === 0) {
    return texto("Link de conexão inválido ou expirado. Gere um novo link e tente de novo.", 400);
  }

  // Troca o código por tokens de acesso.
  const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  // deno-lint-ignore no-explicit-any
  const tokens: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(
      "ml-callback: falha ao trocar o código",
      resp.status,
      tokens?.error,
      tokens?.message,
    );
    return texto(
      "Não foi possível concluir a conexão com o Mercado Livre. Gere um novo link e tente de novo.",
      502,
    );
  }

  // Descobre qual loja acabou de autorizar.
  const me = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  // deno-lint-ignore no-explicit-any
  const perfil: any = await me.json().catch(() => ({}));
  const idExterno = String(perfil?.id ?? tokens.user_id ?? "");
  if (!me.ok || !idExterno) {
    console.error("ml-callback: não foi possível ler o perfil", me.status);
    return texto("Conectou, mas não foi possível ler os dados da loja. Tente de novo.", 502);
  }
  const nome = perfil?.nickname ?? `Loja ${idExterno}`;

  const { data: loja, error: erroLoja } = await supabase
    .from("lojas")
    .upsert(
      { marketplace: "mercado_livre", id_externo: idExterno, nome, ativa: true },
      { onConflict: "marketplace,id_externo" },
    )
    .select("id")
    .single();
  if (erroLoja || !loja) {
    console.error("ml-callback: erro ao salvar a loja", erroLoja?.message);
    return texto("Não foi possível salvar a loja. Tente de novo.", 500);
  }

  const { error: erroCred } = await supabase.from("credenciais_lojas").upsert(
    {
      loja_id: loja.id,
      token_acesso: tokens.access_token,
      token_renovacao: tokens.refresh_token ?? null,
      expira_em: new Date(Date.now() + (tokens.expires_in ?? 21600) * 1000).toISOString(),
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "loja_id" },
  );
  if (erroCred) {
    console.error("ml-callback: erro ao salvar as credenciais", erroCred.message);
    return texto("Não foi possível salvar o acesso da loja. Tente de novo.", 500);
  }

  return texto(`Loja "${nome}" conectada com sucesso! Pode fechar esta aba.`);
});
