// Conecta uma loja da Magalu: recebe o código de autorização do ID Magalu, troca por tokens
// e salva a loja e as credenciais no banco. Só leitura: nada é enviado à Magalu além da troca do código.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("MAGALU_CLIENT_ID") ?? "Owf6JIZiILHfVCirrnetfjmNJsLXULMqmosf5MRJlJ8";
const CLIENT_SECRET = Deno.env.get("MAGALU_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/magalu-callback`;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const texto = (msg: string, status = 200) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// O access token é um JWT: lê só as informações públicas do corpo (sem validar assinatura, a Magalu acabou de emiti-lo).
function corpoDoJwt(token: string): Record<string, any> {
  try {
    const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0))));
  } catch (_) { return {}; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const erro = url.searchParams.get("error");
  if (erro) return texto(`A Magalu recusou a conexão: ${erro}`, 400);
  if (!code || !state) return texto("Faltam informações na conexão. Gere um novo link de conexão e tente de novo.", 400);
  if (!CLIENT_SECRET) return texto("A chave secreta do app da Magalu ainda não foi configurada no Supabase.", 500);

  const limite = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: estado } = await supabase.from("autorizacoes_pendentes").delete().eq("state", state).eq("marketplace", "magalu").gte("criado_em", limite).select("state");
  if (!estado || estado.length === 0) return texto("Link de conexão inválido ou expirado. Gere um novo link e tente de novo.", 400);

  const resp = await fetch("https://id.magalu.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, code, grant_type: "authorization_code" }),
  });
  const tokens: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !tokens.access_token) {
    console.error("magalu-callback: falha ao trocar o código", resp.status, tokens?.error ?? "", tokens?.error_description ?? "");
    return texto("Não foi possível concluir a conexão com a Magalu. Gere um novo link e tente de novo.", 502);
  }

  const jwt = corpoDoJwt(tokens.access_token);
  console.log("magalu-callback: campos do token", Object.keys(jwt).join(","), "escopos", String(tokens.scope ?? "").split(" ").length);
  // Identificador da loja: o tenant (empresa) escolhido no consentimento; se não vier, o sujeito do token.
  const idExterno = String(jwt.tenant_id ?? jwt.tenant ?? jwt.tenant_uuid ?? jwt.sub ?? "");
  if (!idExterno) return texto("Conectou, mas não foi possível identificar a loja no token. Avise o suporte técnico.", 502);
  const nome = String(jwt.tenant_name ?? jwt.name ?? `Magalu ${idExterno.slice(0, 8)}`);

  const { data: loja, error: erroLoja } = await supabase.from("lojas")
    .upsert({ marketplace: "magalu", id_externo: idExterno, nome, ativa: true }, { onConflict: "marketplace,id_externo" }).select("id").single();
  if (erroLoja || !loja) { console.error("magalu-callback: erro ao salvar a loja", erroLoja?.message); return texto("Não foi possível salvar a loja. Tente de novo.", 500); }

  const { error: erroCred } = await supabase.from("credenciais_lojas").upsert({
    loja_id: loja.id,
    token_acesso: tokens.access_token,
    token_renovacao: tokens.refresh_token ?? null,
    expira_em: new Date(Date.now() + (Number(tokens.expires_in) || 7200) * 1000).toISOString(),
    dados_extras: { app_key: CLIENT_ID, escopos: String(tokens.scope ?? ""), campos_jwt: Object.keys(jwt) },
    atualizado_em: new Date().toISOString(),
  }, { onConflict: "loja_id" });
  if (erroCred) { console.error("magalu-callback: erro ao salvar as credenciais", erroCred.message); return texto("Não foi possível salvar o acesso da loja. Tente de novo.", 500); }

  return texto(`Loja "${nome}" da Magalu conectada com sucesso! Pode fechar esta aba.`);
});
