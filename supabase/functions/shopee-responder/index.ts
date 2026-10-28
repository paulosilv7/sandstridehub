// Envia a resposta da equipe para o chat da Shopee e grava a mensagem. Só a equipe pode usar.
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class ErroNegocio extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

async function tratar(req: Request): Promise<Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new ErroNegocio("Faça login para responder.", 401);
  const { data: u, error: eu } = await supabase.auth.getUser(jwt);
  if (eu || !u?.user) throw new ErroNegocio("Sessão expirada. Entre de novo.", 401);
  const { data: membro } = await supabase.from("equipe").select("usuario_id, nome").eq("usuario_id", u.user.id).maybeSingle();
  if (!membro) throw new ErroNegocio("Você não faz parte da equipe.", 403);

  const corpo: any = await req.json().catch(() => ({}));
  const conversaId = String(corpo.conversa_id ?? "");
  const texto = String(corpo.texto ?? "").trim();
  if (!conversaId) throw new ErroNegocio("Conversa não informada.");
  if (!texto) throw new ErroNegocio("Escreva uma mensagem. Por enquanto a Shopee aceita só texto por aqui.");
  if (texto.length > 2000) throw new ErroNegocio("A mensagem está grande demais (máximo 2000 caracteres).");

  const { data: conv } = await supabase.from("conversas")
    .select("id, loja_id, id_externo, cliente_id_externo, bloqueada, motivo_bloqueio, atendente_id, atendida_por_ia, lojas(marketplace)")
    .eq("id", conversaId).maybeSingle();
  if (!conv) throw new ErroNegocio("Conversa não encontrada.", 404);
  const lj: any = Array.isArray(conv.lojas) ? conv.lojas[0] : conv.lojas;
  if (lj?.marketplace !== "shopee") throw new ErroNegocio("Esta conversa não é da Shopee.", 400);
  if (conv.bloqueada) throw new ErroNegocio(conv.motivo_bloqueio ?? "O marketplace bloqueou as respostas desta conversa.", 409);
  if (conv.atendida_por_ia) throw new ErroNegocio("A Sandy está atendendo esta conversa. Assuma a conversa antes de responder.", 409);
  if (conv.atendente_id && conv.atendente_id !== membro.usuario_id) throw new ErroNegocio("Outra pessoa está atendendo esta conversa. Assuma a conversa antes de responder.", 409);

  const cred = await credenciais(conv.loja_id, "shopee-responder");
  if (!cred) throw new ErroNegocio("A conexão com a Shopee precisa ser refeita.", 502);

  let compradorId = conv.cliente_id_externo;
  if (!compradorId) {
    try {
      const c = await loja("GET", "/api/v2/sellerchat/get_one_conversation", cred.token, cred.shopId, { conversation_id: conv.id_externo });
      compradorId = c?.to_id != null ? String(c.to_id) : null;
      if (compradorId) await supabase.from("conversas").update({ cliente_id_externo: compradorId }).eq("id", conv.id);
    } catch (_) { /* tratado abaixo */ }
  }
  if (!compradorId) throw new ErroNegocio("Não consegui identificar o comprador desta conversa.", 502);

  let r: any;
  try {
    r = await loja("POST", "/api/v2/sellerchat/send_message", cred.token, cred.shopId, {}, {
      to_id: Number(compradorId), message_type: "text", content: { text: texto },
    });
  } catch (e) {
    console.error("shopee-responder:", e instanceof Error ? e.message : e);
    throw new ErroNegocio(`A Shopee recusou o envio${e instanceof Error ? `: ${e.message.slice(0, 160)}` : ""}.`, 502);
  }
  const idReal = r?.message_id ?? null;
  const idExterno = idReal ? String(idReal) : `local-${crypto.randomUUID()}`;
  const { data: msg, error: em } = await supabase.from("mensagens").upsert({
    conversa_id: conv.id, id_externo: idExterno, de: "loja", texto, anexos: [],
    enviada_em: new Date().toISOString(), enviada_por: membro.usuario_id, enviada_por_ia: false, estado: "enviada",
  }, { onConflict: "conversa_id,id_externo" }).select("id").single();
  if (em) console.error("shopee-responder: enviou, mas falhou ao gravar", em.message);
  await supabase.from("conversas").update({ atendente_id: membro.usuario_id, atendida_por_ia: false, escalada_motivo: null }).eq("id", conv.id);
  return resp({ ok: true, mensagem_id: msg?.id ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try { return await tratar(req); } catch (e) {
    if (e instanceof ErroNegocio) return resp({ ok: false, erro: e.message }, e.status);
    console.error("shopee-responder: erro inesperado", e instanceof Error ? e.message : String(e));
    return resp({ ok: false, erro: "Algo deu errado ao enviar. Tente de novo." }, 500);
  }
});
