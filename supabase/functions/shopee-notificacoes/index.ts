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

// Tipos que já sabemos ler (os outros são registrados em diagnosticos para estudo).
const CONHECIDOS = new Set(["text", "image", "video", "sticker", "item", "item_list", "order", "variation_card", "notification",
  "customer_service_entrance", "logistics_card", "return_refund_card", "faq_liveagent", "bundle_message", "crm_order_rate"]);
// Tipos automáticos sem informação útil para a equipe.
const IGNORAR = new Set(["bundle_message", "crm_order_rate"]);

const emPt = (lista: any[], campo: string) =>
  String((lista ?? []).find((x: any) => x?.language === "pt-BR")?.[campo] ?? (lista ?? []).find((x: any) => x?.language === "en")?.[campo] ?? "").trim();
const diaMes = (ts: any) => {
  const n = Number(ts);
  return n ? new Date(n > 1e12 ? n : n * 1000).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }) : "";
};

type Convertida = { texto: string | null; anexos: any[]; sistema?: boolean; item?: { item: string; shop: string }; variacao?: string };
function converter(m: any): Convertida | null {
  const tipo = String(m.message_type ?? "").toLowerCase();
  const c = m.content ?? {};
  const sn = String(m.source_content?.order_sn ?? c.order_sn ?? "").trim();
  if (IGNORAR.has(tipo)) return null;
  if (tipo === "text") return { texto: c.text ?? null, anexos: [] };
  if (tipo === "image") return { texto: null, anexos: [{ tipo: "img", nome: "imagem", url: c.url ?? c.thumb_url ?? null }] };
  if (tipo === "video") return { texto: null, anexos: [{ tipo: "arq", nome: "vídeo" }] };
  if (tipo === "sticker") return { texto: "[figurinha]", anexos: [] };
  if (tipo === "item" || tipo === "item_list") {
    const it = tipo === "item" ? c : (c.item_list?.[0] ?? c.items?.[0] ?? c);
    const id = it?.item_id ?? it?.itemid ?? it?.id;
    return { texto: "Produto enviado", anexos: [], item: id ? { item: String(id), shop: String(it?.shop_id ?? it?.shopid ?? "") } : undefined };
  }
  if (tipo === "variation_card") {
    const mods: any[] = c.item_card_v2?.item_model_v2 ?? [];
    const v = mods.find((x: any) => String(x.model_id) === String(c.model_id)) ?? mods[0];
    const variacao = String(v?.name?.text ?? "").replace(/,\s*/g, ", ").trim();
    return { texto: "Produto enviado", anexos: [], variacao, item: c.product_id ? { item: String(c.product_id), shop: String(c.shop_id ?? "") } : undefined };
  }
  if (tipo === "order") return { texto: `Pedido enviado no chat: ${sn || "sem número"}`, anexos: [] };
  if (tipo === "notification") return { texto: String(c.notification_for_receiver || c.notification_for_sender || "Aviso da Shopee"), anexos: [], sistema: true };
  if (tipo === "customer_service_entrance") return { texto: `A Shopee mostrou ao cliente o botão para falar com o atendimento da Shopee${sn ? ` (pedido ${sn})` : ""}.`, anexos: [], sistema: true };
  if (tipo === "logistics_card") {
    const t = c.logistic_tracking_info ?? {};
    const prev = diaMes(t.estimate_delivery_time);
    return { texto: `Rastreio: ${t.latest_tracking_info || "atualização de envio"}${prev ? ` · previsão de entrega ${prev}` : ""}`, anexos: [], sistema: true };
  }
  if (tipo === "return_refund_card") {
    const d = c.rr_detail ?? {};
    const sol = emPt(d.translated_detail, "solution"), mot = emPt(d.translated_detail, "reason");
    const prod = String(c.order_info?.order_title ?? "").trim();
    return { texto: `Solicitação de ${sol ? sol.toLowerCase() : "devolução/reembolso"}${mot ? ` · motivo: ${mot}` : ""}${prod ? ` · ${prod}` : ""}`, anexos: [], sistema: true };
  }
  if (tipo === "faq_liveagent") return { texto: `O cliente tocou em "${String(c.text ?? "").trim() || "opção"}" no assistente da Shopee.`, anexos: [], sistema: true };
  return { texto: `Mensagem automática da Shopee (${tipo || "sem tipo"}).`, anexos: [], sistema: true };
}

// Nome do produto (só dá para consultar anúncios da própria loja).
const nomes = new Map<string, string | null>();
async function nomeDoProduto(cred: { token: string; shopId: string }, it: { item: string; shop: string }): Promise<string | null> {
  if (it.shop && it.shop !== cred.shopId) return null;
  if (nomes.has(it.item)) return nomes.get(it.item)!;
  let nome: string | null = null;
  try {
    const r = await loja("GET", "/api/v2/product/get_item_base_info", cred.token, cred.shopId, { item_id_list: it.item });
    nome = r?.item_list?.[0]?.item_name ?? null;
  } catch (e) { await diag("shopee-notificacoes", `nome do produto ${it.item}: ${e instanceof Error ? e.message : e}`); }
  nomes.set(it.item, nome);
  return nome;
}
// Mensagens antigas gravadas como "[tipo]" ou "[Produto enviado]" são reescritas quando a conversa é lida de novo.
const provisoria = (t: string | null) => !!t && /^\[(Produto enviado|Pedido\]|[a-z_]+\])/.test(t);

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
  let mudou = false;
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
    const tipoMsg = String(m.message_type ?? "").toLowerCase();
    if (!CONHECIDOS.has(tipoMsg)) await diag("shopee-tipo", `tipo ${tipoMsg}: ${JSON.stringify(m).slice(0, 1200)}`);
    const conv = converter(m);
    if (!conv) continue;
    if (conv.item) {
      const nomeProd = await nomeDoProduto(cred, conv.item);
      conv.texto = `Produto enviado: ${nomeProd ?? `código ${conv.item.item}`}${conv.variacao ? ` · ${conv.variacao}` : ""}`;
    }
    const de = conv.sistema ? "sistema" : deLoja ? "loja" : "cliente";
    const ts = Number(m.created_timestamp);
    const quando = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
    const id = String(m.message_id);
    const { data: ja } = await supabase.from("mensagens").select("id, de, texto").eq("conversa_id", convId).eq("id_externo", id).maybeSingle();
    if (ja) {
      if (provisoria(ja.texto) && (ja.texto !== conv.texto || ja.de !== de)) {
        await supabase.from("mensagens").update({ de, texto: conv.texto, anexos: conv.anexos }).eq("id", ja.id);
        mudou = true;
      }
      continue;
    }
    if (de === "loja") {
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
  // Se um aviso antigo deixou de contar como mensagem da loja/cliente, refaz o resumo da conversa.
  if (mudou) await supabase.rpc("recalcular_ultima_mensagem", { p_conversa: convId });
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

// A Shopee exige resposta 2xx em até 3 segundos; respondemos na hora e conferimos a assinatura em segundo plano.
const OK = () => new Response(JSON.stringify({ code: 0, message: "success" }), { status: 200, headers: { "Content-Type": "application/json" } });

async function tratar(req: Request, bruto: string) {
  const assinatura = (req.headers.get("Authorization") ?? "").toLowerCase();
  let valido = false;
  for (const chave of [PUSH_KEY, KEY]) {
    if (chave && assinatura === await hmac(chave, `${PUSH_URL}|${bruto}`)) { valido = true; break; }
  }
  if (!valido) {
    await diag("shopee-notificacoes", `assinatura inválida/ausente (${bruto.length} bytes): ${bruto.slice(0, 200)}`);
    return;
  }
  let ev: any = {};
  try { ev = JSON.parse(bruto); } catch (_) { return; }
  await processar(ev, bruto);
}

// Uso interno: relê conversas já gravadas (cabeçalho x-lucro-token). Corpo: {reprocessar: [{shop_id, conversation_id}]}
async function reprocessar(lista: any[]) {
  for (const x of lista.slice(0, 60)) {
    try { await sincronizar(String(x.shop_id), String(x.conversation_id)); }
    catch (e) { await diag("shopee-notificacoes", `reprocessar ${x.conversation_id}: ${e instanceof Error ? e.message : e}`); }
  }
  await diag("shopee-notificacoes", `reprocessadas ${Math.min(lista.length, 60)} conversas`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return OK();
  const bruto = await req.text();
  const interno = req.headers.get("x-lucro-token");
  if (interno) {
    const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
    if (!seg?.valor || interno !== seg.valor) return new Response("não autorizado", { status: 401 });
    let corpo: any = {};
    try { corpo = JSON.parse(bruto); } catch (_) { /* vazio */ }
    // @ts-ignore EdgeRuntime existe no Supabase
    EdgeRuntime.waitUntil(reprocessar(Array.isArray(corpo.reprocessar) ? corpo.reprocessar : []));
    return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  }
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(tratar(req, bruto));
  return OK();
});
