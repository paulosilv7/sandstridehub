// Recebe os avisos (webhooks) do TikTok Shop: novas mensagens e conversas.
// Responde 200 vazio na hora e processa em segundo plano.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("TIKTOK_APP_KEY") ?? "6lo1ttda2b1bf";
const APP_SECRET = Deno.env.get("TIKTOK_APP_SECRET") ?? "";
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";

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

async function credenciais(lojaId: string): Promise<{ token: string; cipher: string } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const cipher = (cred.dados_extras as any)?.shop_cipher;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return { token: cred.token_acesso, cipher };
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${AUTH}/api/v2/token/refresh?` + new URLSearchParams({
    app_key: APP_KEY, app_secret: APP_SECRET, refresh_token: cred.token_renovacao, grant_type: "refresh_token",
  }));
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) {
    const { data: outra } = await ler();
    if (valido(outra)) return { token: outra!.token_acesso, cipher };
    await diag("tiktok-notificacoes", `falha ao renovar o token: ${r.status}/${t.code} ${t.message ?? ""}`);
    return null;
  }
  const d = t.data;
  await supabase.from("credenciais_lojas").update({
    token_acesso: d.access_token,
    token_renovacao: d.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return { token: d.access_token, cipher };
}

async function ttsGet(caminho: string, token: string, cipher: string, extra: Record<string, string> = {}) {
  const q: Record<string, string> = { ...extra, app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: cipher };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("");
  q.sign = await hmac(APP_SECRET, APP_SECRET + base + APP_SECRET);
  const r = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
    headers: { "x-tts-access-token": token, "Content-Type": "application/json" },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${r.status}/${j.code} em ${caminho}: ${String(j.message ?? "").slice(0, 200)}`);
  return j.data;
}

function converter(m: any): { texto: string | null; anexos: any[] } | null {
  const tipo = String(m.type ?? "").toUpperCase();
  let c: any = {};
  try { c = typeof m.content === "string" ? JSON.parse(m.content) : (m.content ?? {}); } catch (_) { c = { content: String(m.content ?? "") }; }
  if (tipo === "TEXT") return { texto: c.content ?? null, anexos: [] };
  if (tipo === "IMAGE") return { texto: null, anexos: [{ tipo: "img", nome: "imagem", url: c.url ?? null }] };
  if (tipo === "VIDEO") return { texto: null, anexos: [{ tipo: "arq", nome: "vídeo" }] };
  if (tipo === "PRODUCT_CARD" || tipo === "PRODUCT") return { texto: `[Produto] ${c.product_name ?? c.title ?? ""}`.trim(), anexos: [] };
  if (tipo === "ORDER_CARD" || tipo === "ORDER") return { texto: `[Pedido] ${c.order_id ?? ""}`.trim(), anexos: [] };
  if (tipo === "EMOTICONS" || tipo === "EMOJI") return { texto: c.content ?? "[emoji]", anexos: [] };
  return null; // avisos do sistema e tipos desconhecidos
}

async function sincronizar(shopId: string, conversaId: string) {
  const { data: loja } = await supabase.from("lojas").select("id").eq("marketplace", "tiktok_shop").eq("id_externo", shopId).maybeSingle();
  if (!loja) { await diag("tiktok-notificacoes", `loja ${shopId} não conectada`); return; }
  const cred = await credenciais(loja.id);
  if (!cred?.cipher) { await diag("tiktok-notificacoes", `sem credenciais para a loja ${shopId}`); return; }

  // Mensagens mais recentes primeiro.
  const dados = await ttsGet(`/customer_service/202309/conversations/${conversaId}/messages`, cred.token, cred.cipher, {
    page_size: "20", sort_order: "DESC", sort_field: "create_time",
  });
  const msgs: any[] = (dados?.messages ?? []).slice().reverse();

  // Nome do cliente
  let nome: string | null = null, clienteId: string | null = null;
  for (const m of msgs) {
    if (String(m.sender?.role).toUpperCase() === "BUYER") { nome = m.sender?.nickname ?? nome; clienteId = m.sender?.im_user_id ?? clienteId; }
  }
  const { data: existente } = await supabase.from("conversas").select("id, cliente_nome").eq("loja_id", loja.id).eq("tipo", "chat").eq("id_externo", conversaId).maybeSingle();
  if (!nome && !existente) {
    try {
      const det = await ttsGet(`/customer_service/202601/conversations/${conversaId}`, cred.token, cred.cipher);
      const p = (det?.participants ?? det?.conversation?.participants ?? []).find((x: any) => String(x.role).toUpperCase() === "BUYER");
      nome = p?.nickname ?? null; clienteId = p?.im_user_id ?? clienteId;
    } catch (e) { await diag("tiktok-notificacoes", `detalhes da conversa: ${e instanceof Error ? e.message : e}`); }
  }

  let convId = existente?.id as string | undefined;
  if (!convId) {
    const { data: nova, error } = await supabase.from("conversas").upsert(
      { loja_id: loja.id, tipo: "chat", id_externo: conversaId, cliente_nome: nome ?? "Cliente TikTok", cliente_id_externo: clienteId },
      { onConflict: "loja_id,tipo,id_externo" },
    ).select("id").single();
    if (error || !nova) { await diag("tiktok-notificacoes", `erro ao criar conversa: ${error?.message}`); return; }
    convId = nova.id;
  } else if (nome && existente?.cliente_nome !== nome) {
    await supabase.from("conversas").update({ cliente_nome: nome }).eq("id", convId);
  }

  for (const m of msgs) {
    const papel = String(m.sender?.role ?? "").toUpperCase();
    if (m.is_visible === false) continue;
    if (papel === "SYSTEM" || papel === "ROBOT") continue;
    const conv = converter(m);
    if (!conv) continue;
    const de = papel === "BUYER" ? "cliente" : "loja";
    const quando = new Date(Number(m.create_time) > 1e12 ? Number(m.create_time) : Number(m.create_time) * 1000).toISOString();
    const id = String(m.id);

    if (de === "loja") {
      // Se a equipe enviou por aqui, a mensagem já existe com id local ou real: evita duplicar.
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
    if (error) await diag("tiktok-notificacoes", `erro ao gravar mensagem: ${error.message}`);
  }
}

async function processar(ev: any) {
  const tipo = Number(ev.type);
  const shopId = String(ev.shop_id ?? "");
  try {
    if (tipo === 14 || tipo === 13) {
      const conversaId = String(ev.data?.conversation_id ?? "");
      if (!conversaId) return;
      await sincronizar(shopId, conversaId);
    } else if (tipo === 6) {
      await supabase.from("lojas").update({ ativa: false }).eq("marketplace", "tiktok_shop").eq("id_externo", shopId);
      await diag("tiktok-notificacoes", `loja ${shopId} desautorizou o app`);
    } else if (tipo === 7) {
      await diag("tiktok-notificacoes", `autorização da loja ${shopId} perto de expirar`);
    }
  } catch (e) {
    await diag("tiktok-notificacoes", `erro ao processar tipo ${tipo}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 200 });
  const bruto = await req.text();
  const assinatura = req.headers.get("Authorization") ?? "";
  const esperado = APP_SECRET ? await hmac(APP_SECRET, APP_KEY + bruto) : "";
  if (!esperado || assinatura.toLowerCase() !== esperado) {
    // O teste de URL do TikTok pode vir sem assinatura válida; respondemos 200 sem processar.
    await diag("tiktok-notificacoes", `assinatura inválida/ausente (${bruto.length} bytes)`);
    return new Response(null, { status: 200 });
  }
  let ev: any = {};
  try { ev = JSON.parse(bruto); } catch (_) { return new Response(null, { status: 200 }); }
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(processar(ev));
  return new Response(null, { status: 200 });
});
