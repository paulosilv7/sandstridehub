// Grava a observação do pedido no marketplace (Mercado Livre e Shopee) quando a Sandy anota uma troca de tamanho/cor.
// Chamada pelo banco (gatilho na mensagem de sistema "OBS DO PEDIDO"). Cabeçalho x-lucro-token.
// TikTok Shop não tem observação do vendedor na API: a equipe anota à mão (o aviso na conversa já diz isso).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const ML_API = "https://api.mercadolibre.com";
const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

async function diag(mensagem: string) {
  console.error("pedido-obs", mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: "pedido-obs", mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------- Mercado Livre ----------------
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) return cred.token_acesso;
  if (!cred?.token_renovacao) return null;
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: cred.token_renovacao }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) {
    await supabase.from("credenciais_lojas").update({
      token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
      expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
    }).eq("loja_id", lojaId);
    return t.access_token;
  }
  const { data: outra } = await ler();
  return valido(outra) ? outra!.token_acesso : null;
}
async function notaML(conv: any, nota: string) {
  const token = await tokenML(conv.loja_id);
  if (!token) throw new Error("conexão com o Mercado Livre precisa ser refeita");
  const pedido = String(conv.id_externo ?? conv.pedido_id_externo ?? "");
  if (!/^\d+$/.test(pedido)) throw new Error("conversa sem número de pedido");
  const r = await fetch(`${ML_API}/orders/${pedido}/notes`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ note: nota.slice(0, 300) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mercado Livre ${r.status}: ${String(j?.message ?? j?.error ?? "").slice(0, 200)}`);
}

// ---------------- Shopee ----------------
async function credShopee(lojaId: string): Promise<{ token: string; shopId: string } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const shopId = String((cred.dados_extras as any)?.shop_id ?? "");
  if (!shopId) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 300_000;
  if (valido(cred)) return { token: cred.token_acesso, shopId };
  if (!cred.token_renovacao) return null;
  const path = "/api/v2/auth/access_token/get", ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}`);
  const r = await fetch(`${HOST}${path}?` + new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), sign }), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: cred.token_renovacao, shop_id: Number(shopId), partner_id: Number(PARTNER_ID) }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok && !t.error && t.access_token) {
    await supabase.from("credenciais_lojas").update({
      token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
      expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
    }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  }
  const { data: outra } = await ler();
  return valido(outra) ? { token: outra!.token_acesso, shopId } : null;
}
async function chamarShopee(metodo: "GET" | "POST", path: string, c: { token: string; shopId: string }, params: Record<string, string> = {}, corpo?: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}${c.token}${c.shopId}`);
  const q = new URLSearchParams({ ...params, partner_id: PARTNER_ID, timestamp: String(ts), access_token: c.token, shop_id: c.shopId, sign });
  const r = await fetch(`${HOST}${path}?${q}`, { method: metodo, headers: { "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} em ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 200)}`);
  return j.response ?? j;
}
async function notaShopee(conv: any, nota: string) {
  const c = await credShopee(conv.loja_id);
  if (!c) throw new Error("conexão com a Shopee precisa ser refeita");
  const sn = String(conv.pedido_id_externo ?? "").trim();
  if (!sn) throw new Error("conversa sem número de pedido");
  // A Shopee tem uma única observação do vendedor e o set_note substitui: lê a atual e acrescenta.
  let atual = "";
  try {
    const d = await chamarShopee("GET", "/api/v2/order/get_order_detail", c, { order_sn_list: sn, response_optional_fields: "note" });
    atual = String(d?.order_list?.[0]?.note ?? "").trim();
  } catch (_) { /* segue só com a nova */ }
  const novo = (atual ? `${atual} | ` : "") + nota;
  await chamarShopee("POST", "/api/v2/order/set_note", c, {}, { order_sn: sn, note: novo.slice(0, 500) });
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  const conversaId = String(corpo.conversa_id ?? "");
  let nota = String(corpo.nota ?? "").trim();
  if (!nota && corpo.mensagem_id) {
    const { data: m } = await supabase.from("mensagens").select("texto").eq("id", corpo.mensagem_id).maybeSingle();
    nota = String(m?.texto ?? "").match(/\):\s*(.*?)\.\s*Anote no pedido/s)?.[1]?.trim() ?? "";
  }
  if (!conversaId || !nota) return new Response(JSON.stringify({ ok: false, erro: "conversa_id e nota obrigatórios" }), { status: 400 });

  const { data: conv } = await supabase.from("conversas")
    .select("id, loja_id, tipo, id_externo, pedido_id_externo, lojas(marketplace)").eq("id", conversaId).maybeSingle();
  if (!conv) return new Response(JSON.stringify({ ok: false, erro: "conversa não encontrada" }), { status: 404 });
  const mk = (Array.isArray(conv.lojas) ? conv.lojas[0] : conv.lojas as any)?.marketplace;
  if (mk !== "mercado_livre" && mk !== "shopee") return new Response(JSON.stringify({ ok: true, ignorado: "marketplace sem observação na API" }), { status: 200 });

  // Teste de conexão: usa um número de pedido que não existe (nada é gravado; só mostra se a permissão e o token funcionam).
  if (corpo.pedido_teste) { conv.id_externo = String(corpo.pedido_teste); conv.pedido_id_externo = String(corpo.pedido_teste); }
  const rotulo = mk === "shopee" ? "Shopee" : "Mercado Livre";
  const texto = `Sandy: ${nota}`;
  let resultado = "";
  try {
    if (corpo.teste) { resultado = "teste (nada gravado)"; }
    else if (mk === "mercado_livre") await notaML(conv, texto);
    else await notaShopee(conv, texto);
    if (!corpo.teste && !corpo.pedido_teste) await supabase.from("mensagens").insert({ conversa_id: conv.id, id_externo: `obs-ok-${crypto.randomUUID()}`, de: "sistema", texto: `✅ OBS gravada no pedido do ${rotulo}: ${nota}`, enviada_em: new Date().toISOString() });
    await diag(`ok ${mk} ${conv.id}: ${nota} ${resultado}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await diag(`falhou ${mk} ${conv.id}: ${msg}`);
    if (!corpo.pedido_teste) await supabase.from("mensagens").insert({ conversa_id: conv.id, id_externo: `obs-erro-${crypto.randomUUID()}`, de: "sistema", texto: `⚠️ Não consegui gravar a OBS no pedido do ${rotulo} (${msg.slice(0, 120)}). Anote no pedido à mão: ${nota}`, enviada_em: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false, erro: msg }), { status: 200 });
  }
});
