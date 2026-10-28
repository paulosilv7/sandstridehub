// Recebe os avisos (push) da Shopee: novas mensagens do chat. Responde 200 na hora e processa em segundo plano.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
// Os avisos (push) são assinados com a "Live Push Partner Key", que é outra chave.
const PUSH_KEY = Deno.env.get("SHOPEE_PUSH_KEY") ?? "";

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

const PUSH_URL = Deno.env.get("SHOPEE_PUSH_URL") ?? "https://imlgfmaqmzfonvbmlwpd.supabase.co/functions/v1/shopee-notificacoes";

function converter(m: any): { texto: string | null; anexos: any[] } {
  const tipo = String(m.message_type ?? "").toLowerCase();
  const c = m.content ?? {};
  if (tipo === "text") return { texto: c.text ?? null, anexos: [] };
  if (tipo === "image") return { texto: null, anexos: [{ tipo: "img", nome: "imagem", url: c.url ?? c.thumb_url ?? null }] };
  if (tipo === "video") return { texto: null, anexos: [{ tipo: "arq", nome: "vídeo" }] };
  if (tipo === "sticker") return { texto: "[figurinha]", anexos: [] };
  if (tipo === "item" || tipo === "item_list") return { texto: "[Produto enviado]", anexos: [] };
  if (tipo === "order") return { texto: `[Pedido] ${c.order_sn ?? ""}`.trim(), anexos: [] };
  return { texto: `[${tipo || "mensagem"}]`, anexos: [] };
}

async function sincronizar(shopId: string, conversaId: string) {
  const { data: l } = await supabase.from("lojas").select("id").eq("marketplace", "shopee").eq("id_externo", shopId).maybeSingle();
  if (!l) { await diag("shopee-notificacoes", `loja ${shopId} não conectada`); return; }
  const cred = await credenciais(l.id, "shopee-notificacoes");
  if (!cred) { await diag("shopee-notificacoes", `sem credenciais para a loja ${shopId}`); return; }

  const resp = await loja("GET", "/api/v2/sellerchat/get_message", cred.token, cred.shopId, { conversation_id: conversaId, page_size: "25" });
  const msgs: any[] = (resp?.messages ?? []).slice().sort((a: any, b: any) => Number(a.created_timestamp) - Number(b.created_timestamp));

  let nome: string | null = null, clienteId: string | null = null;
  const { data: existente } = await supabase.from("conversas").select("id, cliente_nome, cliente_id_externo").eq("loja_id", l.id).eq("tipo", "chat").eq("id_externo", conversaId).maybeSingle();
  if (!existente?.cliente_id_externo || !existente?.cliente_nome || existente.cliente_nome === "Cliente Shopee") {
    try {
      const c = await loja("GET", "/api/v2/sellerchat/get_one_conversation", cred.token, cred.shopId, { conversation_id: conversaId });
      nome = c?.to_name ?? null; clienteId = c?.to_id != null ? String(c.to_id) : null;
    } catch (e) { await diag("shopee-notificacoes", `detalhes da conversa: ${e instanceof Error ? e.message : e}`); }
  }
  if (!clienteId) {
    const dele = msgs.find((m) => String(m.from_id) !== cred.shopId && String(m.from_shop_id ?? "") !== cred.shopId);
    if (dele?.from_id != null) clienteId = String(dele.from_id);
  }

  let convId = existente?.id as string | undefined;
  if (!convId) {
    const { data: nova, error } = await supabase.from("conversas").upsert(
      { loja_id: l.id, tipo: "chat", id_externo: conversaId, cliente_nome: nome ?? "Cliente Shopee", cliente_id_externo: clienteId },
      { onConflict: "loja_id,tipo,id_externo" },
    ).select("id").single();
    if (error || !nova) { await diag("shopee-notificacoes", `erro ao criar conversa: ${error?.message}`); return; }
    convId = nova.id;
  } else if ((nome && existente?.cliente_nome !== nome) || (clienteId && !existente?.cliente_id_externo)) {
    await supabase.from("conversas").update({ ...(nome ? { cliente_nome: nome } : {}), ...(clienteId && !existente?.cliente_id_externo ? { cliente_id_externo: clienteId } : {}) }).eq("id", convId);
  }

  for (const m of msgs) {
    const deLoja = String(m.from_shop_id ?? "") === cred.shopId || String(m.from_id) === cred.shopId;
    const de = deLoja ? "loja" : "cliente";
    const conv = converter(m);
    const ts = Number(m.created_timestamp);
    const quando = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
    const id = String(m.message_id);
    if (de === "loja") {
      const { data: ja } = await supabase.from("mensagens").select("id").eq("conversa_id", convId).eq("id_externo", id).maybeSingle();
      if (ja) continue;
      const { data: local } = await supabase.from("mensagens").select("id, enviada_em").eq("conversa_id", convId).like("id_externo", "local-%").eq("texto", conv.texto ?? "").order("enviada_em", { ascending: false }).limit(1);
      if (local?.[0] && Math.abs(new Date(local[0].enviada_em).getTime() - new Date(quando).getTime()) < 5 * 60_000) {
        await supabase.from("mensagens").update({ id_externo: id }).eq("id", local[0].id);
        continue;
      }
    }
    const { error } = await supabase.from("mensagens").upsert({
      conversa_id: convId, id_externo: id, de, texto: conv.texto, anexos: conv.anexos, enviada_em: quando, estado: "enviada",
    }, { onConflict: "conversa_id,id_externo", ignoreDuplicates: true });
    if (error) await diag("shopee-notificacoes", `erro ao gravar mensagem: ${error.message}`);
  }
}

async function processar(ev: any, bruto: string) {
  const shopId = String(ev.shop_id ?? "");
  try {
    const conversaId = String(ev.data?.content?.conversation_id ?? ev.data?.conversation_id ?? "");
    if (Number(ev.code) === 10 && conversaId) await sincronizar(shopId, conversaId);
    else if (Number(ev.code) !== 10) await diag("shopee-notificacoes", `aviso ignorado (código ${ev.code}): ${bruto.slice(0, 300)}`);
    else await diag("shopee-notificacoes", `aviso de chat sem conversa: ${bruto.slice(0, 400)}`);
  } catch (e) {
    await diag("shopee-notificacoes", `erro ao processar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 200 });
  const bruto = await req.text();
  const assinatura = (req.headers.get("Authorization") ?? "").toLowerCase();
  let valido = false;
  for (const chave of [PUSH_KEY, KEY]) {
    if (chave && assinatura === await hmac(chave, `${PUSH_URL}|${bruto}`)) { valido = true; break; }
  }
  if (!valido) {
    await diag("shopee-notificacoes", `assinatura inválida/ausente (${bruto.length} bytes): ${bruto.slice(0, 200)}`);
    return new Response(null, { status: 200 });
  }
  let ev: any = {};
  try { ev = JSON.parse(bruto); } catch (_) { return new Response(null, { status: 200 }); }
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(processar(ev, bruto));
  return new Response(null, { status: 200 });
});
