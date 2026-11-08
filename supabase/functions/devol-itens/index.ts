// Devoluções (SOMENTE LEITURA): grava em devol_casos o que foi comprado, o que o comprador pediu para devolver, o que ele DISSE na solicitação,
// o nome do comprador e os rastreios da devolução (para achar o caso de um lote de fotos).
// Shopee: get_order_detail + get_return_detail. Mercado Livre: /orders/{id} + devolução do claim + mensagens. TikTok: orders + returns/search.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const ORIGEM = "devol-itens";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
async function diag(m: string) { console.error(ORIGEM, m); try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: m.slice(0, 1500) }); } catch (_) { /* */ } }
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const somar = (l: any[]) => {
  const m = new Map<string, any>();
  for (const x of l) { const k = `${x.nome}|${x.variacao}|${x.sku}`; const o = m.get(k); if (o) o.qtd += x.qtd; else m.set(k, { ...x }); }
  return [...m.values()];
};
const nomeOk = (n: any) => { const s = String(n ?? "").trim(); return s.length >= 5 && !s.includes("*") ? s : null; };
const limpar = (t: any) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, 500) : null; };

// ---------- Shopee ----------
const SP_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970", SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "", SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
async function sp(path: string, c: any, params: Record<string, string>) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_ID}${path}${ts}${c.token}${c.shopId}`);
  const r = await fetch(`${SP_HOST}${path}?${new URLSearchParams({ ...params, partner_id: SP_ID, timestamp: String(ts), access_token: c.token, shop_id: c.shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${path}: ${j.error ?? r.status}`);
  return j.response ?? {};
}
async function credSp(lojaId: string) {
  const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const shopId = String((c?.dados_extras as any)?.shop_id ?? "");
  if (!c || !shopId || !c.expira_em || new Date(c.expira_em).getTime() - Date.now() < 120_000) return null;
  return { token: c.token_acesso, shopId };
}
async function itensShopee(caso: any, c: any) {
  const [o, d] = await Promise.all([
    sp("/api/v2/order/get_order_detail", c, { order_sn_list: String(caso.pedido), response_optional_fields: "item_list,recipient_address" }),
    sp("/api/v2/returns/get_return_detail", c, { return_sn: String(caso.solicitacao_id) }),
  ]);
  const ord = (o.order_list ?? [])[0] ?? {};
  const comprados = (ord.item_list ?? []).map((i: any) => ({ nome: String(i.item_name ?? ""), variacao: String(i.model_name ?? ""), sku: String(i.model_sku || i.item_sku || ""), qtd: Number(i.model_quantity_purchased ?? 1) }));
  const devolvidos = (d.item ?? []).map((i: any) => ({ nome: String(i.name ?? ""), variacao: String(i.variation_sku ?? ""), sku: String(i.variation_sku || i.item_sku || ""), qtd: Number(i.amount ?? 1) }));
  return { comprados: somar(comprados), devolvidos: somar(devolvidos), motivo_comprador: limpar(d.text_reason), fotos_comprador: (d.image ?? []).length, fonte: "shopee", _nome: nomeOk(ord.recipient_address?.name), _rastreios: [d.tracking_number].filter(Boolean).map(String) };
}

// ---------- Mercado Livre ----------
const ML = "https://api.mercadolibre.com", ML_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040", ML_SEC = Deno.env.get("ML_CLIENT_SECRET") ?? "";
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  const ok = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  if (c && ok(c)) return c.token_acesso;
  if (!c?.token_renovacao) return null;
  const r = await fetch(`${ML}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_ID, client_secret: ML_SEC, refresh_token: c.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) { await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId); return t.access_token; }
  const { data: o } = await ler(); return ok(o) ? o!.token_acesso : null;
}
async function ml(p: string, tk: string) {
  const r = await fetch(`${ML}${p}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`ML ${r.status} ${p}`), { status: r.status });
  return await r.json();
}
async function itensML(caso: any, tk: string) {
  const claim: any = await ml(`/post-purchase/v1/claims/${caso.solicitacao_id}`, tk).catch(() => null);
  let ordem = String(caso.pedido ?? "").replace(/\D/g, "");
  if (claim?.resource === "order" && claim?.resource_id) ordem = String(claim.resource_id);
  const o: any = await ml(`/orders/${ordem}`, tk);
  const comprados = (o.order_items ?? []).map((i: any) => ({ nome: String(i.item?.title ?? ""), variacao: (i.item?.variation_attributes ?? []).map((v: any) => `${v.name}: ${v.value_name}`).join(", "), sku: String(i.item?.seller_sku ?? ""), qtd: Number(i.quantity ?? 1) }));
  let devolvidos: any[] = [];
  const ret: any = await ml(`/post-purchase/v2/claims/${caso.solicitacao_id}/returns`, tk).catch(() => null);
  for (const x of ret?.orders ?? []) {
    const base = comprados[0] ?? { nome: "", variacao: "", sku: "" };
    devolvidos.push({ ...base, qtd: Number(x.return_quantity ?? x.total_quantity ?? 1) });
  }
  if (!devolvidos.length && claim?.quantity_type === "partial") devolvidos = [];
  // o que o comprador DISSE na reclamação (mensagens dele)
  let motivo: string | null = null;
  try {
    const ms: any = await ml(`/post-purchase/v1/claims/${caso.solicitacao_id}/messages`, tk);
    const lista: any[] = Array.isArray(ms) ? ms : (ms?.messages ?? []);
    const dele = lista.filter((m: any) => { const r = String(m.sender_role ?? m.role ?? "").toLowerCase(); return r === "complainant" || r === "buyer"; }).map((m: any) => String(m.message ?? m.text ?? "").trim()).filter(Boolean);
    motivo = limpar(dele.slice(0, 3).join(" | "));
  } catch (_) { /* sem mensagens */ }
  // nome do comprador e rastreios da devolução
  const nome = nomeOk([o.buyer?.first_name, o.buyer?.last_name].filter(Boolean).join(" "));
  const rastreios: string[] = []; let nome2: string | null = null;
  for (const s of (ret?.shipments ?? []).slice(0, 2)) {
    const sid = String(s.shipment_id ?? ""); if (!sid) continue;
    rastreios.push(sid);
    try {
      const sh: any = await ml(`/shipments/${sid}`, tk);
      if (sh.tracking_number) rastreios.push(String(sh.tracking_number));
      nome2 = nome2 ?? nomeOk(sh.sender_address?.contact ?? sh.sender_address?.receiver_name ?? sh.receiver_address?.receiver_name);
    } catch (_) { /* segue */ }
  }
  return { comprados: somar(comprados), devolvidos: somar(devolvidos), motivo_comprador: motivo, fonte: "mercado_livre", _nome: nome ?? nome2, _rastreios: rastreios };
}

// ---------- TikTok ----------
const TT_API = "https://open-api.tiktokglobalshop.com", TT_PADRAO = "6lo1ttda2b1bf";
async function credTT(lojaId: string) {
  const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  if (!c || !c.expira_em || new Date(c.expira_em).getTime() - Date.now() < 120_000) return null;
  const k = (c.dados_extras as any)?.app_key ?? TT_PADRAO;
  return { token: c.token_acesso, cipher: (c.dados_extras as any)?.shop_cipher, k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") };
}
async function tts(metodo: "GET" | "POST", caminho: string, c: any, extra: Record<string, string>, corpo?: unknown) {
  const body = corpo ? JSON.stringify(corpo) : "";
  const q: Record<string, string> = { app_key: c.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
  q.sign = await hmac(c.s, c.s + caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + body + c.s);
  const r = await fetch(`${TT_API}${caminho}?${new URLSearchParams(q)}`, { method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, ...(body ? { body } : {}) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${caminho}: ${j.code} ${String(j.message).slice(0, 120)}`);
  return j.data;
}
async function itensTT(caso: any, c: any) {
  const o = await tts("GET", "/order/202309/orders", c, { ids: String(caso.pedido) });
  const ord = (o?.orders ?? [])[0] ?? {};
  const comprados = (ord.line_items ?? []).map((i: any) => ({ nome: String(i.product_name ?? ""), variacao: String(i.sku_name ?? ""), sku: String(i.seller_sku ?? ""), qtd: 1 }));
  const r = await tts("POST", "/return_refund/202309/returns/search", c, { page_size: "10" }, { return_ids: [String(caso.solicitacao_id)] });
  const ret = (r?.return_orders ?? [])[0] ?? {};
  const devolvidos = (ret.return_line_items ?? []).map((i: any) => ({ nome: String(i.product_name ?? ""), variacao: String(i.sku_name ?? ""), sku: String(i.seller_sku ?? ""), qtd: 1 }));
  const motivo = limpar(ret.return_reason_text ?? ret.buyer_comment ?? ret.comments ?? ret.return_reason);
  const rastreios = [ret.return_tracking_number, ret.tracking_number, ret.return_provider_tracking_number].filter(Boolean).map(String);
  return { comprados: somar(comprados), devolvidos: somar(devolvidos), motivo_comprador: motivo, fonte: "tiktok_shop", _nome: nomeOk(ord.recipient_address?.name), _rastreios: rastreios };
}

async function executar(ids: string[] | null) {
  const inicio = Date.now(); const res: any = { ok: 0, erro: 0, ultimos_erros: [] };
  try {
    const { data: k } = await supabase.from("devol_config").select("valor").eq("chave", "kill_switch").maybeSingle();
    if (k?.valor === "true") return;
    let q = supabase.from("devol_casos").select("id, loja_id, pedido, solicitacao_id, itens_lidos_em").limit(40);
    if (ids?.length) q = q.in("id", ids);
    else q = q.is("itens_pedido", null).is("arquivado_em", null).not("pedido", "is", null).or(`itens_lidos_em.is.null,itens_lidos_em.lt.${new Date(Date.now() - 6 * 3_600_000).toISOString()}`).order("atualizado_em", { ascending: false });
    const { data: casos } = await q;
    const { data: lojas } = await supabase.from("lojas").select("id, marketplace");
    const mk = new Map((lojas ?? []).map((l: any) => [l.id, l.marketplace]));
    const cache = new Map<string, any>();
    for (const caso of casos ?? []) {
      if (Date.now() - inicio > 100_000) break;
      const m = mk.get(caso.loja_id);
      try {
        let itens: any = null;
        if (!cache.has(caso.loja_id)) cache.set(caso.loja_id, m === "shopee" ? await credSp(caso.loja_id) : m === "tiktok_shop" ? await credTT(caso.loja_id) : await tokenML(caso.loja_id));
        const c = cache.get(caso.loja_id);
        if (!c) throw new Error("sem credencial válida");
        itens = m === "shopee" ? await itensShopee(caso, c) : m === "tiktok_shop" ? await itensTT(caso, c) : await itensML(caso, c);
        const { _nome, _rastreios, ...limpo } = itens;
        const rast = [...new Set((_rastreios ?? []).map((x: string) => String(x).trim()).filter(Boolean))];
        const upd: any = { itens_pedido: limpo.comprados.length ? limpo : null, itens_lidos_em: new Date().toISOString() };
        if (_nome) upd.comprador_nome = _nome;
        if (rast.length) upd.rastreios = rast;
        await supabase.from("devol_casos").update(upd).eq("id", caso.id);
        res.ok++;
      } catch (e) {
        res.erro++; if (res.ultimos_erros.length < 4) res.ultimos_erros.push(`${m}: ${(e as Error).message}`.slice(0, 200));
        await supabase.from("devol_casos").update({ itens_lidos_em: new Date().toISOString() }).eq("id", caso.id);
      }
    }
  } catch (e) { await diag(`erro: ${(e as Error).message}`); }
  if (res.erro) await diag(`resultado: ${JSON.stringify(res)}`);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(executar(Array.isArray(corpo.ids) ? corpo.ids : null));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
