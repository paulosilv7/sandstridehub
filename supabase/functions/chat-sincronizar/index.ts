// Mantém os chats da Shopee e do TikTok Shop fiéis ao marketplace (parecido com ml-sincronizar):
//  1) confere as últimas mensagens de cada conversa (pega o que foi enviado por fora do nosso chat);
//  2) baixa as fotos que o cliente mandou e guarda no nosso armazenamento;
//  3) descobre o pedido da conversa, grava os dados dele no painel e lê a situação real
//     (cancelado, devolução, em análise) para tirar a conversa das "não respondidas".
// Chamada pelo agendador do banco e por um gatilho quando chega uma foto. Cabeçalho x-lucro-token.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const paraIso = (t: any) => { const n = Number(t); return n ? new Date(n > 1e12 ? n : n * 1000).toISOString() : null; };

// ---------------------------------------------------------------------
// Shopee
// ---------------------------------------------------------------------
const SP_PARTNER = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";

async function spPublica(path: string, corpo: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_PARTNER}${path}${ts}`);
  const r = await fetch(`${SP_HOST}${path}?` + new URLSearchParams({ partner_id: SP_PARTNER, timestamp: String(ts), sign }), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...corpo, partner_id: Number(SP_PARTNER) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j;
}
async function spLoja(path: string, token: string, shopId: string, params: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_PARTNER}${path}${ts}${token}${shopId}`);
  const r = await fetch(`${SP_HOST}${path}?${new URLSearchParams({ ...params, partner_id: SP_PARTNER, timestamp: String(ts), access_token: token, shop_id: shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j.response ?? j;
}
type CredSp = { token: string; shopId: string };
const credSp = new Map<string, CredSp | null>();
async function spCred(lojaId: string): Promise<CredSp | null> {
  if (credSp.has(lojaId)) return credSp.get(lojaId)!;
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  let saida: CredSp | null = null;
  if (cred) {
    const shopId = String((cred.dados_extras as any)?.shop_id ?? "");
    const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 300_000;
    if (shopId && valido(cred)) saida = { token: cred.token_acesso, shopId };
    else if (shopId && cred.token_renovacao) {
      try {
        const t = await spPublica("/api/v2/auth/access_token/get", { refresh_token: cred.token_renovacao, shop_id: Number(shopId) });
        await supabase.from("credenciais_lojas").update({
          token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
          expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
        }).eq("loja_id", lojaId);
        saida = { token: t.access_token, shopId };
      } catch (_e) {
        const { data: outra } = await ler();
        if (valido(outra)) saida = { token: outra!.token_acesso, shopId };
      }
    }
  }
  credSp.set(lojaId, saida);
  return saida;
}

// Tipos automáticos da Shopee que não são conversa de verdade.
const SP_IGNORAR = new Set(["faq_liveagent", "bundle_message", "notification", "logistics_card", "return_refund_card", "customer_service_entrance"]);

function converterShopee(m: any): { texto: string | null; anexos: any[] } | null {
  const tipo = String(m.message_type ?? "").toLowerCase();
  const c = m.content ?? {};
  if (SP_IGNORAR.has(tipo)) return null;
  if (tipo === "text") return { texto: c.text ?? null, anexos: [] };
  if (tipo === "image") return { texto: null, anexos: [{ tipo: "img", nome: "imagem", url: c.url ?? c.thumb_url ?? null }] };
  if (tipo === "video") return { texto: null, anexos: [{ tipo: "arq", nome: "vídeo" }] };
  if (tipo === "sticker") return { texto: "[figurinha]", anexos: [] };
  if (tipo === "item" || tipo === "item_list") return { texto: "[Produto enviado]", anexos: [] };
  if (tipo === "order") return { texto: `[Pedido] ${c.order_sn ?? ""}`.trim(), anexos: [] };
  return null;
}

const ST_SHOPEE: Record<string, string> = {
  UNPAID: "Aguardando pagamento", READY_TO_SHIP: "Pronto para envio", PROCESSED: "Preparado para coleta", RETRY_SHIP: "Nova tentativa de envio",
  SHIPPED: "Enviado", TO_CONFIRM_RECEIVE: "Entregue", IN_CANCEL: "Cancelamento solicitado", INVOICE_PENDING: "Aguardando nota fiscal",
  TO_RETURN: "Devolução solicitada", COMPLETED: "delivered", CANCELLED: "cancelled",
};

async function retornosShopee(cred: CredSp, bruto: any): Promise<Map<string, string[]>> {
  const mapa = new Map<string, string[]>();
  try {
    const agora = Math.floor(Date.now() / 1000);
    // A Shopee só aceita janelas de até 15 dias: consulta 3 janelas de 14 dias.
    for (let janela = 0; janela < 3; janela++) {
      const fim = agora - janela * 14 * 86400;
      for (let pagina = 0; pagina < 5; pagina++) {
        const r = await spLoja("/api/v2/returns/get_return_list", cred.token, cred.shopId, {
          page_no: String(pagina), page_size: "50", create_time_from: String(fim - 14 * 86400), create_time_to: String(fim),
        });
        const lista: any[] = r.return ?? r.returns ?? r.return_list ?? [];
        for (const x of lista) {
          const sn = String(x.order_sn ?? "");
          if (!sn) continue;
          mapa.set(sn, [...(mapa.get(sn) ?? []), String(x.status ?? "").toUpperCase()]);
        }
        if (!r.more) break;
      }
    }
  } catch (e) { bruto.devolucoes_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
  return mapa;
}

async function pedidoShopee(cred: CredSp, sn: string, retornos: Map<string, string[]>, bruto: any) {
  let det: any;
  try {
    det = await spLoja("/api/v2/order/get_order_detail", cred.token, cred.shopId, {
      order_sn_list: sn, response_optional_fields: "item_list,pay_time,total_amount,payment_method,order_status,buyer_username,recipient_address,package_list,create_time",
    });
  } catch (_e) {
    det = await spLoja("/api/v2/order/get_order_detail", cred.token, cred.shopId, {
      order_sn_list: sn, response_optional_fields: "item_list,pay_time,total_amount,payment_method,order_status",
    });
  }
  const o = det?.order_list?.[0];
  if (!o) throw new Error(`pedido ${sn} não encontrado`);
  bruto.order_status = o.order_status;

  const itens: any[] = o.item_list ?? [];
  const it = itens[0];
  const qtd = itens.reduce((s, x) => s + (num(x.model_quantity_purchased) || 1), 0);
  const cod = String(o.order_status ?? "");
  const rotulo = ST_SHOPEE[cod] ?? cod;
  const dados: any = {
    tipo: "pedido",
    status: cod === "CANCELLED" ? "cancelled" : cod.toLowerCase(),
    feito_em: paraIso(o.create_time ?? o.pay_time),
    total: o.total_amount != null ? num(o.total_amount) : null,
    item: {
      titulo: it ? `${it.item_name ?? ""}${itens.length > 1 ? ` (+${itens.length - 1})` : ""}` : null,
      variacao: it?.model_name ?? null,
      quantidade: qtd || null,
      preco: it ? num(it.model_discounted_price ?? it.model_original_price) : null,
    },
    pagamento: o.payment_method ?? null,
    numero_pedido: sn,
    apelido: o.buyer_username ?? null,
    envio: { status: rotulo === "cancelled" ? "cancelled" : rotulo, rastreio: null, cidade: o.recipient_address?.city ?? null, uf: o.recipient_address?.state ?? null },
  };

  // Situação
  const rets = (retornos.get(sn) ?? []).filter((s) => s !== "CANCELLED");
  bruto.devolucoes = rets;
  let situacao: { situacao: string; detalhe: string } | null = null;
  if (rets.some((s) => ["JUDGING", "SELLER_DISPUTE"].includes(s))) situacao = { situacao: "analise_ml", detalhe: "A Shopee está analisando a devolução (disputa)." };
  else if (rets.some((s) => ["REQUESTED", "ACCEPTED", "PROCESSING"].includes(s))) situacao = { situacao: "devolucao", detalhe: "Devolução em andamento na Shopee." };
  else if (rets.length && rets.every((s) => s === "CLOSED")) situacao = { situacao: "devolvido", detalhe: "Devolução concluída na Shopee." };
  else if (cod === "TO_RETURN") situacao = { situacao: "devolucao", detalhe: "Devolução solicitada na Shopee." };
  else if (cod === "CANCELLED") situacao = { situacao: "cancelado", detalhe: "Pedido cancelado na Shopee." };
  else if (cod === "IN_CANCEL") situacao = { situacao: "reclamacao", detalhe: "Cancelamento solicitado, aguardando decisão." };
  return { dados, situacao, titulo: it?.item_name ?? null };
}

async function puxarShopee(conv: any, loja: any, bruto: any): Promise<{ sn: string | null; novas: number }> {
  const cred = await spCred(loja.id);
  if (!cred) { bruto.erro = "sem credenciais"; return { sn: null, novas: 0 }; }
  const resp = await spLoja("/api/v2/sellerchat/get_message", cred.token, cred.shopId, { conversation_id: conv.id_externo, page_size: "25" });
  const msgs: any[] = (resp?.messages ?? []).slice().sort((a: any, b: any) => Number(a.created_timestamp) - Number(b.created_timestamp));

  const { data: existentes } = await supabase.from("mensagens").select("id, id_externo, texto").eq("conversa_id", conv.id);
  const porId = new Map<string, any>((existentes ?? []).map((m: any) => [m.id_externo, m]));
  let sn: string | null = null, novas = 0;

  for (const m of msgs) {
    const snMsg = m.source_content?.order_sn ?? (String(m.message_type).toLowerCase() === "order" ? m.content?.order_sn : null);
    if (snMsg) sn = String(snMsg);
    const c = converterShopee(m);
    if (!c) continue;
    const deLoja = String(m.from_shop_id ?? "") === cred.shopId || String(m.from_id) === cred.shopId;
    const id = String(m.message_id);
    const quando = paraIso(m.created_timestamp) ?? new Date().toISOString();
    const ja = porId.get(id);
    if (ja) {
      if (/^\[[a-z_]+\]$/.test(ja.texto ?? "") && c.texto !== ja.texto) await supabase.from("mensagens").update({ texto: c.texto, anexos: c.anexos }).eq("id", ja.id);
      continue;
    }
    if (deLoja && c.texto) {
      const { data: local } = await supabase.from("mensagens").select("id, enviada_em").eq("conversa_id", conv.id).like("id_externo", "local-%").eq("texto", c.texto).order("enviada_em", { ascending: false }).limit(1);
      if (local?.[0] && Math.abs(new Date(local[0].enviada_em).getTime() - new Date(quando).getTime()) < 5 * 60_000) {
        await supabase.from("mensagens").update({ id_externo: id }).eq("id", local[0].id);
        continue;
      }
    }
    const { error } = await supabase.from("mensagens").upsert(
      { conversa_id: conv.id, id_externo: id, de: deLoja ? "loja" : "cliente", texto: c.texto, anexos: c.anexos, enviada_em: quando, estado: "enviada" },
      { onConflict: "conversa_id,id_externo", ignoreDuplicates: true },
    );
    if (error) await diag("chat-sincronizar", `erro ao gravar mensagem (shopee): ${error.message}`); else novas++;
  }
  return { sn, novas };
}

// ---------------------------------------------------------------------
// TikTok Shop
// ---------------------------------------------------------------------
const TT_PADRAO = "6lo1ttda2b1bf";
type AppTT = { k: string; s: string };
const appDe = (k: string): AppTT => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const TT_API = "https://open-api.tiktokglobalshop.com";
const TT_AUTH = "https://auth.tiktok-shops.com";
type CredTT = { token: string; cipher: string; app: AppTT };
const credTT = new Map<string, CredTT | null>();
async function ttCred(lojaId: string): Promise<CredTT | null> {
  if (credTT.has(lojaId)) return credTT.get(lojaId)!;
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  let saida: CredTT | null = null;
  if (cred) {
    const cipher = (cred.dados_extras as any)?.shop_cipher;
    const app = appDe((cred.dados_extras as any)?.app_key ?? TT_PADRAO);
    const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
    if (cipher && valido(cred)) saida = { token: cred.token_acesso, cipher, app };
    else if (cipher && cred.token_renovacao) {
      const r = await fetch(`${TT_AUTH}/api/v2/token/refresh?` + new URLSearchParams({ app_key: app.k, app_secret: app.s, refresh_token: cred.token_renovacao, grant_type: "refresh_token" }));
      const t: any = await r.json().catch(() => ({}));
      if (r.ok && (t.code ?? 0) === 0 && t.data?.access_token) {
        const d = t.data;
        await supabase.from("credenciais_lojas").update({
          token_acesso: d.access_token, token_renovacao: d.refresh_token ?? cred.token_renovacao,
          expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
        }).eq("loja_id", lojaId);
        saida = { token: d.access_token, cipher, app };
      } else {
        const { data: outra } = await ler();
        if (valido(outra)) saida = { token: outra!.token_acesso, cipher, app };
      }
    }
  }
  credTT.set(lojaId, saida);
  return saida;
}
async function tts(metodo: "GET" | "POST", caminho: string, c: CredTT, extra: Record<string, string>, corpo?: unknown) {
  const body = corpo ? JSON.stringify(corpo) : "";
  const q: Record<string, string> = { app_key: c.app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + body;
  q.sign = await hmac(c.app.s, c.app.s + base + c.app.s);
  const r = await fetch(`${TT_API}${caminho}?${new URLSearchParams(q)}`, {
    method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, ...(body ? { body } : {}),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${r.status} ${caminho}: ${j.code} ${String(j.message ?? "").slice(0, 160)}`);
  return j.data;
}

function converterTikTok(m: any): { texto: string | null; anexos: any[]; pedido?: string } | null {
  const tipo = String(m.type ?? "").toUpperCase();
  let c: any = {};
  try { c = typeof m.content === "string" ? JSON.parse(m.content) : (m.content ?? {}); } catch (_) { c = { content: String(m.content ?? "") }; }
  if (tipo === "TEXT") return { texto: c.content ?? null, anexos: [] };
  if (tipo === "IMAGE") return { texto: null, anexos: [{ tipo: "img", nome: "imagem", url: c.url ?? c.image_url ?? null }] };
  if (tipo === "VIDEO") return { texto: null, anexos: [{ tipo: "arq", nome: "vídeo" }] };
  if (tipo === "PRODUCT_CARD" || tipo === "PRODUCT") return { texto: `[Produto] ${c.product_name ?? c.title ?? ""}`.trim(), anexos: [] };
  if (tipo === "ORDER_CARD" || tipo === "ORDER") return { texto: `[Pedido] ${c.order_id ?? ""}`.trim(), anexos: [], pedido: c.order_id ? String(c.order_id) : undefined };
  if (tipo === "EMOTICONS" || tipo === "EMOJI") return { texto: c.content ?? "[emoji]", anexos: [] };
  return null;
}

const ST_TIKTOK: Record<string, string> = {
  UNPAID: "Aguardando pagamento", ON_HOLD: "Em espera", AWAITING_SHIPMENT: "Aguardando envio", PARTIALLY_SHIPPING: "Envio parcial",
  AWAITING_COLLECTION: "Aguardando coleta", IN_TRANSIT: "Em trânsito", DELIVERED: "delivered", COMPLETED: "delivered", CANCELLED: "cancelled",
};

async function puxarTikTok(conv: any, loja: any, bruto: any): Promise<{ sn: string | null; novas: number }> {
  const cred = await ttCred(loja.id);
  if (!cred) { bruto.erro = "sem credenciais"; return { sn: null, novas: 0 }; }
  const dados = await tts("GET", `/customer_service/202309/conversations/${conv.id_externo}/messages`, cred, { page_size: "10", sort_order: "DESC", sort_field: "create_time" });
  const msgs: any[] = (dados?.messages ?? []).slice().reverse();

  const { data: existentes } = await supabase.from("mensagens").select("id, id_externo, texto").eq("conversa_id", conv.id);
  const porId = new Map<string, any>((existentes ?? []).map((m: any) => [m.id_externo, m]));
  let sn: string | null = null, novas = 0;

  for (const m of msgs) {
    const papel = String(m.sender?.role ?? "").toUpperCase();
    if (m.is_visible === false || papel === "SYSTEM" || papel === "ROBOT") continue;
    const c = converterTikTok(m);
    if (!c) continue;
    if (c.pedido) sn = c.pedido;
    const de = papel === "BUYER" ? "cliente" : "loja";
    const id = String(m.id);
    const quando = paraIso(m.create_time) ?? new Date().toISOString();
    if (porId.has(id)) continue;
    if (de === "loja" && c.texto) {
      const { data: local } = await supabase.from("mensagens").select("id, enviada_em").eq("conversa_id", conv.id).like("id_externo", "local-%").eq("texto", c.texto).order("enviada_em", { ascending: false }).limit(1);
      if (local?.[0] && Math.abs(new Date(local[0].enviada_em).getTime() - new Date(quando).getTime()) < 5 * 60_000) {
        await supabase.from("mensagens").update({ id_externo: id }).eq("id", local[0].id);
        continue;
      }
    }
    const { error } = await supabase.from("mensagens").upsert(
      { conversa_id: conv.id, id_externo: id, de, texto: c.texto, anexos: c.anexos, enviada_em: quando, estado: "enviada" },
      { onConflict: "conversa_id,id_externo", ignoreDuplicates: true },
    );
    if (error) await diag("chat-sincronizar", `erro ao gravar mensagem (tiktok): ${error.message}`); else novas++;
  }
  // Pedidos citados em mensagens antigas (cartão de pedido já gravado como texto).
  if (!sn) {
    for (const m of [...(existentes ?? [])].reverse()) {
      const x = /^\[Pedido\] (\d{10,})/.exec(m.texto ?? "");
      if (x) { sn = x[1]; break; }
    }
  }
  return { sn, novas };
}

async function pedidoTikTok(cred: CredTT, id: string, bruto: any) {
  const det = await tts("GET", "/order/202309/orders", cred, { ids: id });
  const o = det?.orders?.[0];
  if (!o) throw new Error(`pedido ${id} não encontrado`);
  bruto.order_status = o.status;

  const grupos = new Map<string, any>();
  for (const li of o.line_items ?? []) {
    if (li.is_gift) continue;
    const k = String(li.sku_id);
    const g = grupos.get(k) ?? { titulo: li.product_name ?? "", variacao: li.sku_name ?? null, qtd: 0, preco: num(li.sale_price), rastreio: li.tracking_number ?? null };
    g.qtd++;
    grupos.set(k, g);
  }
  const lista = [...grupos.values()];
  const g0 = lista[0];
  const cod = String(o.status ?? "");
  const rotulo = ST_TIKTOK[cod] ?? cod;
  const distritos: any[] = o.recipient_address?.district_info ?? [];
  const nivel = (n: string) => distritos.find((d) => String(d.address_level_name ?? "").toLowerCase() === n)?.address_name ?? null;
  const dados: any = {
    tipo: "pedido",
    status: cod === "CANCELLED" ? "cancelled" : cod.toLowerCase(),
    feito_em: paraIso(o.create_time ?? o.paid_time),
    total: o.payment?.total_amount != null ? num(o.payment.total_amount) : null,
    item: {
      titulo: g0 ? `${g0.titulo}${lista.length > 1 ? ` (+${lista.length - 1})` : ""}` : null,
      variacao: g0?.variacao ?? null,
      quantidade: lista.reduce((s, g) => s + g.qtd, 0) || null,
      preco: g0?.preco ?? null,
    },
    pagamento: o.payment_method_name ?? null,
    numero_pedido: id,
    apelido: null,
    envio: { status: rotulo, rastreio: g0?.rastreio ?? o.tracking_number ?? null, cidade: nivel("city") ?? nivel("district"), uf: nivel("state") },
  };

  // Devoluções e cancelamentos pedidos pelo cliente.
  let situacao: { situacao: string; detalhe: string } | null = null;
  try {
    const dev = await tts("POST", "/return_refund/202309/returns/search", cred, { page_size: "20" }, { order_ids: [id] });
    const lst: any[] = dev?.return_orders ?? dev?.returns ?? [];
    bruto.devolucoes = lst.map((x) => x.return_status ?? x.status ?? null);
    const ativos = lst.map((x) => String(x.return_status ?? x.status ?? "").toUpperCase());
    if (ativos.some((s) => /DISPUTE|PLATFORM|JUDG|ARBITR/.test(s))) situacao = { situacao: "analise_ml", detalhe: "O TikTok Shop está analisando a devolução." };
    else if (ativos.some((s) => s && !/CANCEL|REJECT|COMPLETE|CLOSE|SUCCESS/.test(s))) situacao = { situacao: "devolucao", detalhe: "Devolução em andamento no TikTok Shop." };
    else if (ativos.some((s) => /COMPLETE|SUCCESS/.test(s))) situacao = { situacao: "devolvido", detalhe: "Devolução concluída no TikTok Shop." };
  } catch (e) { bruto.devolucoes_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
  if (!situacao && cod === "CANCELLED") situacao = { situacao: "cancelado", detalhe: "Pedido cancelado no TikTok Shop." };
  if (!situacao && cod !== "CANCELLED") {
    try {
      const can = await tts("POST", "/return_refund/202309/cancellations/search", cred, { page_size: "20" }, { order_ids: [id] });
      const lst: any[] = can?.cancellations ?? can?.cancel_orders ?? [];
      bruto.cancelamentos = lst.map((x) => x.cancel_status ?? x.status ?? null);
      if (lst.some((x) => /PENDING|REQUEST/.test(String(x.cancel_status ?? x.status ?? "").toUpperCase()))) situacao = { situacao: "reclamacao", detalhe: "Cancelamento solicitado, aguardando decisão." };
    } catch (e) { bruto.cancelamentos_erro = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
  }
  return { dados, situacao, titulo: g0?.titulo ?? null };
}

// ---------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------
function tipoDoArquivo(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}
async function curto(texto: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(h)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function baixarFoto(prefixo: string, conversaExt: string, a: any): Promise<any> {
  if (!a || a.path || !a.url) return a;
  try {
    const r = await fetch(String(a.url));
    if (!r.ok) { console.error("chat-foto", r.status, String(a.url).slice(0, 80)); return a; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > 10 * 1024 * 1024) return a;
    const mime = tipoDoArquivo(buf);
    if (!mime) return a;
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "pdf";
    const path = `${prefixo}/${conversaExt}/${await curto(String(a.url))}.${ext}`;
    const { error } = await supabase.storage.from("anexos").upload(path, buf, { contentType: mime, upsert: true });
    if (error) { await diag("chat-foto", `erro ao guardar: ${error.message}`); return a; }
    return { tipo: mime === "application/pdf" ? "arq" : "img", nome: a.nome ?? "imagem", path, mime, tamanho: buf.byteLength };
  } catch (e) { console.error("chat-foto", e instanceof Error ? e.message : e); return a; }
}
async function converterFotos(conv: any, prefixo: string) {
  const { data: msgs } = await supabase.from("mensagens").select("id, anexos").eq("conversa_id", conv.id);
  let n = 0;
  for (const m of msgs ?? []) {
    if (!Array.isArray(m.anexos) || !m.anexos.some((a: any) => a?.url && !a?.path)) continue;
    const novos: any[] = [];
    for (const a of m.anexos) novos.push(await baixarFoto(prefixo, conv.id_externo, a));
    if (JSON.stringify(novos) !== JSON.stringify(m.anexos)) { await supabase.from("mensagens").update({ anexos: novos }).eq("id", m.id); n++; }
  }
  return n;
}

// ---------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------
async function sincronizarConversa(conv: any, loja: any, retornosPorLoja: Map<string, Map<string, string[]>>, explorar: boolean) {
  const bruto: any = {};
  const resumo: any = { conversa: conv.id_externo, mk: loja.marketplace };
  try {
    const mk = loja.marketplace;
    let achado: { sn: string | null; novas: number };
    if (mk === "shopee") achado = await puxarShopee(conv, loja, bruto);
    else achado = await puxarTikTok(conv, loja, bruto);
    resumo.novas = achado.novas;
    resumo.fotos = await converterFotos(conv, mk === "shopee" ? "sp" : "tt");

    const sn = achado.sn ?? conv.pedido_id_externo ?? null;
    const atualiza: any = { sincronizada_em: new Date().toISOString() };
    if (sn) {
      try {
        let p: any;
        if (mk === "shopee") {
          const cred = (await spCred(loja.id))!;
          if (!retornosPorLoja.has(loja.id)) retornosPorLoja.set(loja.id, await retornosShopee(cred, bruto));
          p = await pedidoShopee(cred, sn, retornosPorLoja.get(loja.id)!, bruto);
        } else {
          const cred = (await ttCred(loja.id))!;
          p = await pedidoTikTok(cred, sn, bruto);
        }
        atualiza.pedido_id_externo = sn;
        atualiza.dados_extras = p.dados;
        if (p.titulo) atualiza.produto_titulo = p.titulo;
        const novo = p.situacao?.situacao ?? null;
        atualiza.situacao = novo;
        atualiza.situacao_detalhe = p.situacao?.detalhe ?? null;
        if (novo !== (conv.situacao ?? null)) atualiza.situacao_em = new Date().toISOString();
        resumo.situacao = novo;
      } catch (e) { resumo.erro_pedido = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
    }
    await supabase.from("conversas").update(atualiza).eq("id", conv.id);
  } catch (e) {
    resumo.erro = `${e instanceof Error ? e.message : e}`.slice(0, 200);
    await supabase.from("conversas").update({ sincronizada_em: new Date().toISOString() }).eq("id", conv.id);
  }
  if (explorar) resumo.bruto = bruto;
  return resumo;
}

async function executar(opcoes: { limite: number; conversa?: string; explorar?: boolean; sondar?: any }) {
  const resultados: any[] = [];
  try {
    // Modo de sondagem: mostra a resposta crua de um pedido (para calibrar).
    if (opcoes.sondar) {
      const s = opcoes.sondar;
      const { data: l } = await supabase.from("lojas").select("id, marketplace").eq("id", s.loja_id).maybeSingle();
      const bruto: any = {};
      if (l?.marketplace === "shopee") {
        const cred = (await spCred(l.id))!;
        const rets = await retornosShopee(cred, bruto);
        bruto.retornos = [...rets.entries()].slice(0, 10);
        if (s.pedido) { try { const p = await pedidoShopee(cred, String(s.pedido), rets, bruto); bruto.dados = p.dados; bruto.situacao = p.situacao; } catch (e) { bruto.erro_pedido = `${e instanceof Error ? e.message : e}`; } }
      } else if (l?.marketplace === "tiktok_shop") {
        const cred = (await ttCred(l.id))!;
        if (s.pedido) { try { const p = await pedidoTikTok(cred, String(s.pedido), bruto); bruto.dados = p.dados; bruto.situacao = p.situacao; } catch (e) { bruto.erro_pedido = `${e instanceof Error ? e.message : e}`; } }
      }
      await diag("chat-sondagem", JSON.stringify(bruto));
      return resultados;
    }

    const { data: lojas } = await supabase.from("lojas").select("id, marketplace, id_externo").in("marketplace", ["shopee", "tiktok_shop"]).eq("ativa", true);
    const porLoja = new Map<string, any>((lojas ?? []).map((l: any) => [l.id, l]));
    if (!porLoja.size) return resultados;

    let q = supabase.from("conversas")
      .select("id, loja_id, id_externo, situacao, pedido_id_externo, aguardando_resposta, ultima_mensagem_em")
      .eq("tipo", "chat").in("loja_id", [...porLoja.keys()]);
    if (opcoes.conversa) q = q.eq("id", opcoes.conversa);
    else q = q.or(`aguardando_resposta.eq.true,ultima_mensagem_em.gt.${new Date(Date.now() - 14 * 86400_000).toISOString()}`);
    const { data: convs } = await q.order("sincronizada_em", { ascending: true, nullsFirst: true }).limit(opcoes.limite);

    const retornos = new Map<string, Map<string, string[]>>();
    const inicio = Date.now();
    for (const c of convs ?? []) {
      if (Date.now() - inicio > 110_000) break;
      resultados.push(await sincronizarConversa(c, porLoja.get(c.loja_id), retornos, !!opcoes.explorar));
    }
  } catch (e) {
    await diag("chat-sincronizar", `erro: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (opcoes.explorar) await diag("chat-sincronizar-explorar", JSON.stringify(resultados));
  return resultados;
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  const opcoes = {
    limite: Math.min(Number(corpo.limite) || 30, 60),
    conversa: corpo.conversa_id ? String(corpo.conversa_id) : undefined,
    explorar: !!corpo.explorar,
    sondar: corpo.sondar ?? undefined,
  };
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(executar(opcoes));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
