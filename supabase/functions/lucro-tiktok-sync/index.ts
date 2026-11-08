// Lucro Ao Vivo: traz os pedidos pagos do TikTok Shop para o banco e recalcula os dias afetados.
// Tarifas: valores reais do financeiro do TikTok (pedidos ainda não liquidados); se o pedido não vier de lá,
// estima pela tabela da planilha de precificação.
// Quando o financeiro traz a receita do pedido, o preço dos itens é ajustado para ela (evita contar desconto da plataforma em dobro).
// Pedidos pagos antes de 25/10/2026 (00h de São Paulo) são ignorados de propósito (corte pedido pelo Paulo).
// Pedido que já está gravado idêntico (situação, taxas, frete, dados e itens) NÃO é regravado nem recalcula o dia:
// só entra no banco quando algo mudou (economiza gravações e logs). Os valores do TikTok continuam sendo relidos a cada rodada.
// Quem pode chamar: admin ou pessoa com acesso ao app 'lucro' (login), ou o agendador do banco (chave interna).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const PADRAO = "6lo1ttda2b1bf";
type App = { k: string; s: string };
const appDe = (k: string): App => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const INICIO_MS = Date.parse("2026-10-25T03:00:00Z");

// Reserva: tabela de taxas do TikTok Shop (aba TAXAS) e programa de frete (aba CANAIS)
const FAIXA = (preco: number) => (preco < 50 ? { pct: 0.10, fixo: 4 } : { pct: 0.06, fixo: 6 });
const PROGRAMA_FRETE_PCT = 0.06, PROGRAMA_FRETE_TETO = 50;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Comparação de JSON sem depender da ordem das chaves (o banco reordena as chaves do jsonb).
function igualJson(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => igualJson(x, b[i]));
  }
  if (typeof a === "object") {
    const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of ks) if (!igualJson(a[k], b[k])) return false;
    return true;
  }
  return false;
}
// O pedido gravado é idêntico ao que sairia agora? (cancelado_em usa a hora da última atualização, então só conta se existe ou não)
function pedidoIgual(linha: any, ex: any): boolean {
  if (String(ex.status) !== String(linha.status)) return false;
  if (Date.parse(ex.pago_em) !== Date.parse(linha.pago_em)) return false;
  if (!!ex.cancelado_em !== !!linha.cancelado_em) return false;
  for (const k of ["taxa_marketplace", "frete_vendedor", "desconto_vendedor"]) if (Math.abs(Number(ex[k] ?? 0) - Number(linha[k] ?? 0)) > 0.004) return false;
  return igualJson(JSON.parse(JSON.stringify(linha.dados)), ex.dados);
}

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function credenciais(lojaId: string): Promise<{ token: string; cipher: string; app: App } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const cipher = (cred.dados_extras as any)?.shop_cipher;
  const app = appDe((cred.dados_extras as any)?.app_key ?? PADRAO);
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return { token: cred.token_acesso, cipher, app };
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${AUTH}/api/v2/token/refresh?` + new URLSearchParams({ app_key: app.k, app_secret: app.s, refresh_token: cred.token_renovacao, grant_type: "refresh_token" }));
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) {
    const { data: outra } = await ler();
    return valido(outra) ? { token: outra!.token_acesso, cipher, app } : null;
  }
  const d = t.data;
  await supabase.from("credenciais_lojas").update({
    token_acesso: d.access_token, token_renovacao: d.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return { token: d.access_token, cipher, app };
}

async function tts(metodo: "GET" | "POST", caminho: string, c: { token: string; cipher: string; app: App }, extra: Record<string, string>, corpo?: unknown) {
  const body = corpo ? JSON.stringify(corpo) : "";
  const q: Record<string, string> = { app_key: c.app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + body;
  q.sign = await hmac(c.app.s, c.app.s + base + c.app.s);
  const r = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
    method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, ...(body ? { body } : {}),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${r.status} ${caminho}: ${j.code} ${String(j.message).slice(0, 160)}`);
  return j.data;
}

// Financeiro estimado de cada pedido ainda não liquidado: order_id -> valores reais
async function financeiroNaoLiquidado(c: any, desde: number): Promise<{ mapa: Map<string, any>; erro: string | null }> {
  const mapa = new Map<string, any>();
  try {
    let pagina: string | undefined;
    for (let n = 0; n < 30; n++) {
      const extra: Record<string, string> = { page_size: "100", sort_field: "order_create_time", sort_order: "DESC", order_create_time_ge: String(desde) };
      if (pagina) extra.page_token = pagina;
      const f = await tts("GET", "/finance/202507/orders/unsettled", c, extra);
      for (const t of f?.transactions ?? []) mapa.set(String(t.order_id), t);
      pagina = f?.next_page_token;
      if (!pagina || !(f?.transactions ?? []).length) break;
    }
    return { mapa, erro: null };
  } catch (e) { return { mapa, erro: (e as Error).message.slice(0, 200) }; }
}

async function sincronizarLoja(loja: any, dias: number) {
  const c = await credenciais(loja.id);
  if (!c || !c.cipher) return { loja: loja.apelido, erro: "conexão precisa ser refeita" };
  const agora = Math.floor(Date.now() / 1000);
  const desde = Math.max(agora - dias * 86400, Math.floor(INICIO_MS / 1000));
  const erros: string[] = [];
  const diasAfetados = new Set<string>();
  let lidos = 0, gravados = 0, jaProntos = 0, ignorados = 0, itensGravados = 0, reais = 0, estimados = 0, ultimoPago: string | null = null;

  const fin = await financeiroNaoLiquidado(c, desde - 14 * 86400);
  if (fin.erro) erros.push(`financeiro: ${fin.erro}`);

  const ids: string[] = [];
  let pagina: string | undefined;
  for (let n = 0; n < 40; n++) {
    const extra: Record<string, string> = { page_size: "50", sort_field: "update_time", sort_order: "DESC" };
    if (pagina) extra.page_token = pagina;
    const lista = await tts("POST", "/order/202309/orders/search", c, extra, { update_time_ge: desde, update_time_lt: agora + 60 });
    (lista?.orders ?? []).forEach((o: any) => ids.push(String(o.id)));
    pagina = lista?.next_page_token;
    if (!pagina) break;
  }

  for (let i = 0; i < ids.length; i += 50) {
    const det = await tts("GET", "/order/202309/orders", c, { ids: ids.slice(i, i + 50).join(",") });

    // o que já está gravado desta página (e quais pedidos já têm itens)
    const existentes = new Map<string, any>();
    const comItens = new Set<string>();
    const lote = (det?.orders ?? []).map((o: any) => String(o.id));
    if (lote.length) {
      const { data: ex } = await supabase.from("lucro_pedidos")
        .select("id, pedido_externo, status, pago_em, cancelado_em, taxa_marketplace, frete_vendedor, desconto_vendedor, dados")
        .eq("loja_id", loja.id).in("pedido_externo", lote);
      (ex ?? []).forEach((r: any) => existentes.set(String(r.pedido_externo), r));
      const pids = (ex ?? []).map((r: any) => r.id);
      if (pids.length) {
        const { data: it } = await supabase.from("lucro_itens").select("pedido_id").in("pedido_id", pids);
        (it ?? []).forEach((r: any) => comItens.add(String(r.pedido_id)));
      }
    }

    for (const o of det?.orders ?? []) {
      lidos++;
      const cancelado = o.status === "CANCELLED";
      if (!o.paid_time || o.status === "UNPAID") { ignorados++; continue; }
      if (Number(o.paid_time) * 1000 < INICIO_MS) { ignorados++; continue; }
      const pagoEm = new Date(Number(o.paid_time) * 1000).toISOString();

      const grupos = new Map<string, any>();
      for (const li of o.line_items ?? []) {
        if (li.is_gift) continue;
        const chave = String(li.sku_id);
        const venda = num(li.sale_price), plat = num(li.platform_discount);
        const g = grupos.get(chave) ?? { sku: li.seller_sku || null, anuncio: String(li.sku_id), titulo: `${li.product_name ?? ""} | ${li.sku_name ?? ""}`.slice(0, 200), qtd: 0, base: venda + plat, venda, plat };
        g.qtd++;
        grupos.set(chave, g);
      }

      let taxa = 0, frete = 0, fonte = "estimada", detalheFin: any = null;
      const real = fin.mapa.get(String(o.id));
      if (real) {
        fonte = "real";
        taxa = -num(real.est_fee_tax_amount);
        frete = -num(real.est_shipping_cost_amount);
        const f = real.fee_tax_breakdown?.fee ?? {};
        detalheFin = { receita: real.est_revenue_amount, repasse: real.est_settlement_amount, taxas: real.est_fee_tax_amount, frete: real.est_shipping_cost_amount, afiliado: f.affiliate_commission_amount, comissao: f.platform_commission_amount, programa_frete: f.sfp_service_fee_amount, liquidacao: real.estimated_settlement };
        reais++;
        // a receita do financeiro é o valor que o pedido realmente rende: ajusta o preço dos itens a ela
        const rec = num(real.est_revenue_amount);
        const tot = [...grupos.values()].reduce((s, g) => s + g.base * g.qtd, 0);
        if (rec > 0 && tot > 0 && Math.abs(tot - rec) > 0.05) for (const g of grupos.values()) g.base = r2(g.base * rec / tot);
      } else {
        let comissao = 0, programa = 0;
        for (const g of grupos.values()) {
          const f = FAIXA(g.base);
          comissao += g.qtd * (g.base * f.pct + f.fixo);
          programa += g.qtd * Math.min(g.base * PROGRAMA_FRETE_PCT, PROGRAMA_FRETE_TETO);
        }
        taxa = comissao + programa;
        detalheFin = { comissao_e_fixa: r2(comissao), programa_frete: r2(programa) };
        estimados++;
      }

      const linha: any = {
        loja_id: loja.id,
        pedido_externo: String(o.id),
        status: String(o.status),
        pago_em: pagoEm,
        cancelado_em: cancelado ? new Date(Number(o.update_time ?? agora) * 1000).toISOString() : null,
        taxa_marketplace: r2(taxa),
        frete_vendedor: r2(frete),
        desconto_vendedor: 0,
        dados: {
          fonte_taxas: fonte, financeiro: detalheFin,
          pagamento: o.payment, metodo: o.payment_method_name, envio: o.shipping_provider, tipo_envio: o.shipping_type,
          itens: [...grupos.values()].map((g) => ({ sku: g.sku, qtd: g.qtd, venda: g.venda, desconto_plataforma: g.plat })),
        },
      };

      // idêntico ao que já está no banco (e com itens): não regrava nem recalcula o dia
      const ex = existentes.get(String(o.id));
      if (ex && comItens.has(String(ex.id)) && pedidoIgual(linha, ex)) {
        jaProntos++;
        if (!ultimoPago || pagoEm > ultimoPago) ultimoPago = pagoEm;
        continue;
      }

      const { data: ped, error: ep } = await supabase.from("lucro_pedidos").upsert(linha, { onConflict: "loja_id,pedido_externo" }).select("id, dia").single();
      if (ep || !ped) { erros.push(`pedido ${o.id}: ${ep?.message}`); continue; }
      gravados++;
      diasAfetados.add(ped.dia);
      if (!ultimoPago || pagoEm > ultimoPago) ultimoPago = pagoEm;

      await supabase.from("lucro_itens").delete().eq("pedido_id", ped.id);
      const novos = [...grupos.values()].map((g) => ({
        pedido_id: ped.id, sku: g.sku, anuncio_id: g.anuncio, titulo: g.titulo, quantidade: g.qtd, preco_unitario: r2(g.base),
      }));
      if (novos.length) {
        const { error: ei } = await supabase.from("lucro_itens").insert(novos);
        if (ei) erros.push(`itens ${o.id}: ${ei.message}`); else itensGravados += novos.length;
      }
    }
  }
  await supabase.from("lucro_sync").upsert({
    loja_id: loja.id, ultimo_pago_em: ultimoPago, ultima_execucao: new Date().toISOString(), erro: erros.length ? erros[0].slice(0, 300) : null,
  } as any, { onConflict: "loja_id" });
  return { loja: loja.apelido, lidos, gravados, ja_prontos: jaProntos, ignorados, itens: itensGravados, taxas_reais: reais, taxas_estimadas: estimados, dias: [...diasAfetados], erros: erros.slice(0, 10) };
}

async function autorizado(req: Request): Promise<boolean> {
  const chave = req.headers.get("x-lucro-token");
  if (chave) {
    const { data } = await supabase.rpc("lucro_token_ok", { p: chave });
    return data === true;
  }
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
    const corpo: any = await req.json().catch(() => ({}));
    const dias = Math.min(Math.max(Number(corpo.dias ?? 2), 1), 60);
    let q = supabase.from("lojas").select("id, apelido, id_externo").eq("marketplace", "tiktok_shop").eq("ativa", true);
    if (corpo.loja_id) q = q.eq("id", String(corpo.loja_id));
    const { data: lojas } = await q;
    const saida: any[] = [], diasCalc = new Set<string>();
    for (const l of lojas ?? []) {
      try { const r: any = await sincronizarLoja(l, dias); (r.dias ?? []).forEach((d: string) => diasCalc.add(d)); saida.push(r); }
      catch (e) { saida.push({ loja: l.apelido, erro: (e as Error).message.slice(0, 300) }); }
    }
    for (const d of diasCalc) {
      const { error } = await supabase.rpc("lucro_calcular_dia", { p_dia: d });
      if (error) saida.push({ erro_calculo: d, msg: error.message });
    }
    return resp({ ok: true, dias_recalculados: [...diasCalc].sort(), lojas: saida });
  } catch (e) { console.error("lucro-tiktok-sync", (e as Error).message); return resp({ ok: false, erro: "Falha inesperada." }, 500); }
});
