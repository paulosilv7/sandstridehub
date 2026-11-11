// Lucro Ao Vivo: traz os pedidos pagos da Shopee para o banco e recalcula os dias afetados.
// Tarifas reais pelo extrato de repasse de cada pedido (get_escrow_detail); se faltar, estima pela tabela da planilha.
// Pedido sem taxa real fica FORA dos totais (aguardando_dados = true) até o extrato chegar (no máximo 60 min; depois entra com a estimativa).
// Itens que a Shopee manda com preço 0 (combos e promoções) recebem o valor do extrato (receita) dividido entre eles.
// Pedidos que já têm taxa real e a mesma situação são pulados (a rodada fica rápida); há limite de tempo por chamada.
// Pedidos pagos antes de 25/10/2026 (00h de São Paulo) são ignorados de propósito (corte pedido pelo Paulo).
// Quem pode chamar: admin ou pessoa com acesso ao app 'lucro' (login), ou o agendador do banco (chave interna).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ORCAMENTO_MS = 95_000;
const INICIO_MS = Date.parse("2026-10-25T03:00:00Z");
const ESPERA_MAX_MS = 60 * 60 * 1000;

// Reserva: tabela de taxas da Shopee (aba TAXAS, variante CNPJ), por unidade
const FAIXA = (p: number) => p < 80 ? { pct: 0.20, fixo: 4.5 } : p < 100 ? { pct: 0.14, fixo: 16 } : p < 200 ? { pct: 0.14, fixo: 20 } : { pct: 0.14, fixo: 26 };

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function publica(path: string, corpo: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}`);
  const r = await fetch(`${HOST}${path}?` + new URLSearchParams({ partner_id: PARTNER_ID, timestamp: String(ts), sign }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...corpo, partner_id: Number(PARTNER_ID) }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j;
}
async function chamar(path: string, token: string, shopId: string, params: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}${token}${shopId}`);
  const r = await fetch(`${HOST}${path}?${new URLSearchParams({ ...params, partner_id: PARTNER_ID, timestamp: String(ts), access_token: token, shop_id: shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j.response ?? j;
}
async function credenciais(lojaId: string): Promise<{ token: string; shopId: string } | null> {
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
    await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  } catch (_) {
    const { data: outra } = await ler();
    return valido(outra) ? { token: outra!.token_acesso, shopId } : null;
  }
}

async function sincronizarLoja(loja: any, dias: number, fimMs: number) {
  const c = await credenciais(loja.id);
  if (!c) return { loja: loja.apelido, erro: "conexão precisa ser refeita" };
  const agora = Math.floor(Date.now() / 1000);
  const desde = Math.max(agora - Math.min(dias, 14) * 86400, Math.floor(INICIO_MS / 1000));
  const erros: string[] = [];
  const diasAfetados = new Set<string>();
  let lidos = 0, gravados = 0, ignorados = 0, jaProntos = 0, itensGravados = 0, reais = 0, estimados = 0, aguardando = 0, ultimoPago: string | null = null, cortou = false;

  const sns: string[] = [];
  let cursor = "";
  for (let n = 0; n < 30; n++) {
    const params: Record<string, string> = { time_range_field: "update_time", time_from: String(desde), time_to: String(agora), page_size: "100" };
    if (cursor) params.cursor = cursor;
    const lista = await chamar("/api/v2/order/get_order_list", c.token, c.shopId, params);
    (lista.order_list ?? []).forEach((o: any) => sns.push(o.order_sn));
    if (!lista.more) break;
    cursor = lista.next_cursor ?? "";
    if (!cursor) break;
  }

  // pedidos que já estão gravados com taxa real e a mesma situação não precisam ser refeitos
  const existentes = new Map<string, any>();
  for (let i = 0; i < sns.length; i += 100) {
    const { data } = await supabase.from("lucro_pedidos").select("pedido_externo, status, dados").eq("loja_id", loja.id).in("pedido_externo", sns.slice(i, i + 100));
    (data ?? []).forEach((r: any) => existentes.set(String(r.pedido_externo), r));
  }

  fora:
  for (let i = 0; i < sns.length; i += 50) {
    if (Date.now() > fimMs) { cortou = true; break; }
    const det = await chamar("/api/v2/order/get_order_detail", c.token, c.shopId, { order_sn_list: sns.slice(i, i + 50).join(","), response_optional_fields: "item_list,pay_time,total_amount,payment_method,order_status" });
    for (const o of det.order_list ?? []) {
      if (Date.now() > fimMs) { cortou = true; break fora; }
      lidos++;
      const cancelado = o.order_status === "CANCELLED";
      if (!o.pay_time || o.order_status === "UNPAID") { ignorados++; continue; }
      if (Number(o.pay_time) * 1000 < INICIO_MS) { ignorados++; continue; }
      const ex = existentes.get(String(o.order_sn));
      if (ex && String(ex.status) === String(o.order_status) && ex.dados?.fonte_taxas === "real") { jaProntos++; continue; }
      const pagoEm = new Date(Number(o.pay_time) * 1000).toISOString();

      const grupos = new Map<string, any>();
      for (const it of o.item_list ?? []) {
        const chave = String(it.model_id ?? it.item_id);
        const g = grupos.get(chave) ?? { sku: it.model_sku || it.item_sku || null, anuncio: chave, titulo: `${it.item_name ?? ""} | ${it.model_name ?? ""}`.slice(0, 200), qtd: 0, preco: num(it.model_discounted_price ?? it.model_original_price) };
        g.qtd += num(it.model_quantity_purchased) || 1;
        grupos.set(chave, g);
      }

      let taxa = 0, frete = 0, descVend = 0, fonte = "estimada", fin: any = null;
      try {
        const e = await chamar("/api/v2/payment/get_escrow_detail", c.token, c.shopId, { order_sn: o.order_sn });
        const oi = e.order_income ?? {};
        const receita = num(oi.order_selling_price ?? oi.order_discounted_price);
        const comissao = num(oi.net_commission_fee ?? oi.commission_fee), servico = num(oi.net_service_fee ?? oi.service_fee);
        const repasse = num(oi.escrow_amount_after_adjustment ?? oi.escrow_amount);
        if (receita > 0 && repasse > 0) {
          taxa = comissao + servico;
          descVend = num(oi.voucher_from_seller);
          // o que sobra entre receita e repasse depois das taxas e do voucher: frete líquido, ajustes, etc.
          frete = r2(receita - taxa - descVend - repasse);
          fonte = "real";
          fin = { receita, comissao, servico, repasse, frete_real: oi.actual_shipping_fee, reembolso_frete: oi.shopee_shipping_rebate, voucher_vendedor: descVend, residual: frete };
          reais++;
        }
      } catch (e) { erros.push(`escrow ${o.order_sn}: ${(e as Error).message.slice(0, 100)}`); }
      if (fonte !== "real") {
        for (const g of grupos.values()) { const f = FAIXA(g.preco); taxa += g.qtd * (g.preco * f.pct + f.fixo); }
        fin = { taxa_estimada: r2(taxa) };
        estimados++;
      }

      // Combos e promoções: a Shopee manda o item com preço 0. O valor vem do extrato (receita) ou do total pago,
      // dividido pelos pares sem preço (descontando o que já tem preço).
      const semPreco = [...grupos.values()].filter((g) => !(g.preco > 0));
      if (semPreco.length) {
        const base = fin?.receita > 0 ? Number(fin.receita) : num(o.total_amount);
        const jaTem = [...grupos.values()].reduce((s, g) => s + (g.preco > 0 ? g.preco * g.qtd : 0), 0);
        const resto = base - jaTem, pares = semPreco.reduce((s, g) => s + g.qtd, 0);
        if (resto > 0 && pares > 0) for (const g of semPreco) g.preco = r2(resto / pares);
        else erros.push(`preço zerado sem valor para ratear: ${o.order_sn}`);
      }

      // fora dos totais até o extrato (taxa real) chegar, no máximo 60 min
      const aguarda = !cancelado && fonte !== "real" && (Date.now() - new Date(pagoEm).getTime() < ESPERA_MAX_MS);
      if (aguarda) aguardando++;

      const linha: any = {
        loja_id: loja.id, pedido_externo: String(o.order_sn), status: String(o.order_status), pago_em: pagoEm,
        cancelado_em: cancelado ? new Date(Number(o.update_time ?? agora) * 1000).toISOString() : null,
        taxa_marketplace: r2(taxa), frete_vendedor: r2(frete), desconto_vendedor: r2(descVend),
        aguardando_dados: aguarda,
        dados: { fonte_taxas: fonte, financeiro: fin, total: o.total_amount, metodo: o.payment_method, itens: [...grupos.values()].map((g) => ({ sku: g.sku, qtd: g.qtd, preco: g.preco })) },
      };
      const { data: ped, error: ep } = await supabase.from("lucro_pedidos").upsert(linha, { onConflict: "loja_id,pedido_externo" }).select("id, dia").single();
      if (ep || !ped) { erros.push(`pedido ${o.order_sn}: ${ep?.message}`); continue; }
      gravados++;
      diasAfetados.add(ped.dia);
      if (!ultimoPago || pagoEm > ultimoPago) ultimoPago = pagoEm;

      await supabase.from("lucro_itens").delete().eq("pedido_id", ped.id);
      const novos = [...grupos.values()].map((g) => ({ pedido_id: ped.id, sku: g.sku, anuncio_id: g.anuncio, titulo: g.titulo, quantidade: g.qtd, preco_unitario: r2(g.preco) }));
      if (novos.length) {
        const { error: ei } = await supabase.from("lucro_itens").insert(novos);
        if (ei) erros.push(`itens ${o.order_sn}: ${ei.message}`); else itensGravados += novos.length;
      }
    }
  }
  if (cortou) erros.push("limite de tempo da rodada: o restante entra na próxima");
  await supabase.from("lucro_sync").upsert({ loja_id: loja.id, ultimo_pago_em: ultimoPago, ultima_execucao: new Date().toISOString(), erro: erros.length && !cortou ? erros[0].slice(0, 300) : null } as any, { onConflict: "loja_id" });
  return { loja: loja.apelido, lidos, gravados, ja_prontos: jaProntos, itens: itensGravados, ignorados, taxas_reais: reais, taxas_estimadas: estimados, aguardando_dados: aguardando, cortou, dias: [...diasAfetados], erros: erros.slice(0, 10) };
}

async function autorizado(req: Request): Promise<boolean> {
  const chave = req.headers.get("x-lucro-token");
  if (chave) { const { data } = await supabase.rpc("lucro_token_ok", { p: chave }); return data === true; }
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: u, error: eu } = await supabase.auth.getUser(jwt);
  if (eu || !u?.user) return false;
  const { data: eq } = await supabase.from("equipe").select("papel").eq("usuario_id", u.user.id).maybeSingle();
  if (eq?.papel === "admin") return true;
  const { data: ac } = await supabase.from("acessos_apps").select("app").eq("usuario_id", u.user.id).eq("app", "lucro").maybeSingle();
  return !!ac;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso ao Lucro Ao Vivo." }, 403);
  try {
    const inicio = Date.now();
    const corpo: any = await req.json().catch(() => ({}));
    const dias = Math.min(Math.max(Number(corpo.dias ?? 2), 1), 14);
    let q = supabase.from("lojas").select("id, apelido, id_externo").eq("marketplace", "shopee").eq("ativa", true);
    if (corpo.loja_id) q = q.eq("id", String(corpo.loja_id));
    const { data: lojas } = await q;
    const saida: any[] = [], diasCalc = new Set<string>();
    const n = Math.max(1, (lojas ?? []).length);
    let k = 0;
    for (const l of lojas ?? []) {
      // cada loja usa uma fatia do orçamento de tempo; o que sobrar de uma passa para a próxima
      const fim = inicio + (ORCAMENTO_MS * (k + 1)) / n;
      k++;
      try { const r: any = await sincronizarLoja(l, dias, fim); (r.dias ?? []).forEach((d: string) => diasCalc.add(d)); saida.push(r); }
      catch (e) { saida.push({ loja: l.apelido, erro: (e as Error).message.slice(0, 300) }); }
    }
    for (const d of diasCalc) {
      const { error } = await supabase.rpc("lucro_calcular_dia", { p_dia: d });
      if (error) saida.push({ erro_calculo: d, msg: error.message });
    }
    return resp({ ok: true, dias_recalculados: [...diasCalc].sort(), lojas: saida });
  } catch (e) { console.error("lucro-shopee-sync", (e as Error).message); return resp({ ok: false, erro: "Falha inesperada." }, 500); }
});
