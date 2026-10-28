// Conecta uma loja da Shopee: leva para a autorização, recebe o código, troca por tokens e salva loja + credenciais.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

// Chamada pública (sem token de loja): troca de código e renovação.
async function publica(path: string, corpo: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}`);
  const r = await fetch(`${HOST}${path}?` + new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), sign }), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...corpo, partner_id: Number(PARTNER_ID) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} em ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 200)}`);
  return j;
}

// Chamada de loja (com token).
async function loja(metodo: "GET" | "POST", path: string, token: string, shopId: string, params: Record<string, string> = {}, corpo?: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}${token}${shopId}`);
  const q = new URLSearchParams({ ...params, partner_id: PARTNER_ID, timestamp: String(ts), access_token: token, shop_id: shopId, sign });
  const r = await fetch(`${HOST}${path}?${q}`, {
    method: metodo, headers: { "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} em ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 200)}`);
  return j.response ?? j;
}

// Token válido da loja, renovando perto do vencimento. A Shopee troca o token de renovação a cada uso.
async function credenciais(lojaId: string, origem: string): Promise<{ token: string; shopId: string } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const shopId = String((cred.dados_extras as any)?.shop_id ?? "");
  if (!shopId) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 300_000;
  if (valido(cred)) return { token: cred.token_acesso, shopId };
  if (!cred.token_renovacao) return null;
  try {
    const t = await publica("/api/v2/auth/access_token/get", { refresh_token: cred.token_renovacao, shop_id: Number(shopId) });
    await supabase.from("credenciais_lojas").update({
      token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
      expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
    }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  } catch (e) {
    const { data: outra } = await ler();
    if (valido(outra)) return { token: outra!.token_acesso, shopId };
    await diag(origem, `falha ao renovar o token: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const SELF = "https://imlgfmaqmzfonvbmlwpd.supabase.co/functions/v1/shopee-callback";
const texto = (msg: string, status = 200) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? url.searchParams.get("iniciar");
  if (!KEY || !PARTNER_ID) return texto("A Shopee ainda não foi configurada no Supabase (ID do parceiro ou chave).", 500);
  if (!state) return texto("Faltam informações. Gere um novo link de conexão.", 400);
  const limite = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  // 1) Início: confere o código de segurança e leva para a autorização da Shopee.
  if (url.searchParams.has("iniciar")) {
    const { data: ok } = await supabase.from("autorizacoes_pendentes").select("state").eq("state", state).eq("marketplace", "shopee").gte("criado_em", limite).maybeSingle();
    if (!ok) return texto("Link de conexão inválido ou expirado. Gere um novo link.", 400);
    const path = "/api/v2/shop/auth_partner";
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}`);
    const destino = `${HOST}${path}?` + new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), sign, redirect: `${SELF}?state=${state}` });
    return new Response(null, { status: 302, headers: { Location: destino } });
  }

  // 2) Retorno da Shopee com o código da loja.
  const code = url.searchParams.get("code");
  const shopId = url.searchParams.get("shop_id");
  if (!code || !shopId) return texto("A Shopee não devolveu o código da loja. Gere um novo link e tente de novo.", 400);
  const { data: estado } = await supabase.from("autorizacoes_pendentes").delete().eq("state", state).eq("marketplace", "shopee").gte("criado_em", limite).select("state");
  if (!estado || estado.length === 0) return texto("Link de conexão inválido ou expirado. Gere um novo link.", 400);

  try {
    const t = await publica("/api/v2/auth/token/get", { code, shop_id: Number(shopId) });
    if (!t.access_token) throw new Error("sem access_token na resposta");
    let nome = `Loja Shopee ${shopId}`;
    try {
      const info = await loja("GET", "/api/v2/shop/get_shop_info", t.access_token, shopId);
      if (info?.shop_name) nome = String(info.shop_name);
    } catch (e) { await diag("shopee-callback", `nome da loja: ${e instanceof Error ? e.message : e}`); }

    const { data: l, error: eL } = await supabase.from("lojas").upsert(
      { marketplace: "shopee", id_externo: String(shopId), nome, ativa: true }, { onConflict: "marketplace,id_externo" },
    ).select("id").single();
    if (eL || !l) { await diag("shopee-callback", `erro ao salvar a loja: ${eL?.message}`); return texto("Não foi possível salvar a loja. Tente de novo.", 500); }
    const { error: eC } = await supabase.from("credenciais_lojas").upsert({
      loja_id: l.id, token_acesso: t.access_token, token_renovacao: t.refresh_token ?? null,
      expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(),
      dados_extras: { shop_id: String(shopId) }, atualizado_em: new Date().toISOString(),
    }, { onConflict: "loja_id" });
    if (eC) { await diag("shopee-callback", `erro ao salvar credenciais: ${eC.message}`); return texto("Não foi possível salvar o acesso da loja. Tente de novo.", 500); }
    return texto(`Loja "${nome}" conectada com sucesso! Pode fechar esta aba.`);
  } catch (e) {
    await diag("shopee-callback", `erro: ${e instanceof Error ? e.message : String(e)}`);
    return texto("Algo deu errado ao conectar. Gere um novo link e tente de novo.", 500);
  }
});
