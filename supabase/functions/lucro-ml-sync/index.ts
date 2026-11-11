// Lucro Ao Vivo: traz os pedidos pagos do Mercado Livre para o banco e recalcula os dias afetados.
// Cupom do vendedor: sempre lido de /orders/{id}/discounts (o campo coupon_amount do pagamento nem sempre traz o cupom).
// 404 discount_not_found = pedido sem desconto (cupom 0, marcado como conferido).
// Pedido novo entra com taxa 0 até a próxima rodada: fica FORA dos totais (aguardando_dados = true) até ter taxa real e cupom conferido
// (no máximo 60 min; depois disso entra com o que tiver, para não sumir do total).
// Frete: lido de /shipments/{id}/costs. Enquanto o envio precisa de correção (pending/ready_to_fix) ou não tem status,
// o ML devolve valor provisório (ex.: R$ 135): o pedido fica com frete_pendente = true, o cálculo usa o frete de reserva da Precificação
// (lucro_frete_ref) e o pedido é relido a cada rodada até o frete ficar confirmado.
// Envios pending/buffered e pending/creating_route (aguardando liberação) têm valor normal: entram nos totais, mas continuam sendo relidos até o envio avançar.
// Quem pode chamar: admin ou pessoa com acesso ao app 'lucro' (login), ou o agendador do banco (chave interna).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const INICIO_MS = Date.parse("2026-10-25T03:00:00Z");
const ESPERA_MAX_MS = 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function tokenDaLoja(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { data: outra } = await ler();
    return valido(outra) ? outra!.token_acesso : null;
  }
  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token,
    token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

async function ml(caminho: string, token: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers } });
  const corpo: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ML ${r.status} ${caminho}: ${JSON.stringify(corpo).slice(0, 200)}`);
  return corpo;
}

async function pausa(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

// Frete confirmado: o envio já está pronto para despacho ou além (ready_to_ship, shipped...).
function freteConfirmado(status: string | null, sub: string | null): boolean {
  if (!status) return false;
  if (["shipped", "delivered", "not_delivered", "returned"].includes(status)) return true;
  if (status === "ready_to_ship") return sub !== "ready_to_fix";
  return false;
}
// Frete provisório (usa a reserva da Precificação): sem status, ou envio travado (pending/ready_to_fix etc.).
// Esperando liberação normal (pending/buffered, creating_route) não é provisório.
function freteProvisorio(status: string | null, sub: string | null): boolean {
  if (freteConfirmado(status, sub)) return false;
  if (!status) return true;
  if (status === "pending" && ["buffered", "creating_route"].includes(String(sub))) return false;
  return true;
}

// Parte do CUPOM que saiu do bolso do vendedor (o resto a plataforma paga).
// Só conta os descontos do tipo "coupon"; ofertas ("discount") já estão no preço ou no estorno da tarifa.
// null = não deu para saber.
function parteVendedor(desc: any): number | null {
  try {
    let seller = 0, achou = false;
    for (const d of desc?.details ?? []) {
      if (d?.type !== "coupon") continue;
      for (const it of d?.items ?? []) {
        const s = it?.amounts?.seller;
        if (typeof s === "number") { seller += s; achou = true; }
      }
    }
    return achou ? seller : (Array.isArray(desc?.details) ? 0 : null);
  } catch { return null; }
}

async function sincronizarLoja(loja: any, dias: number, limite: number) {
  const token = await tokenDaLoja(loja.id);
  if (!token) return { loja: loja.apelido, erro: "conexão precisa ser refeita" };
  const desde = new Date(Math.max(Date.now() - dias * 86400_000, INICIO_MS)).toISOString();
  const diasAfetados = new Set<string>();
  let lidos = 0, gravados = 0, itensGravados = 0, ignorados = 0, jaProntos = 0, pendentes = 0, aguardando = 0;
  let ultimoPago: string | null = null;
  const erros: string[] = [];

  for (let offset = 0; offset < limite; offset += 50) {
    const busca = await ml(
      `/orders/search?seller=${loja.id_externo}&order.date_created.from=${encodeURIComponent(desde)}&sort=date_desc&limit=50&offset=${offset}`,
      token,
    );
    const lista: any[] = busca.results ?? [];
    if (!lista.length) break;

    // pedidos já gravados nesta página
    const existentes = new Map<string, any>();
    const { data: ex } = await supabase.from("lucro_pedidos").select("pedido_externo, status, cancelado_em, taxa_marketplace, frete_pendente, aguardando_dados, dia, dados")
      .eq("loja_id", loja.id).in("pedido_externo", lista.map((o) => String(o.id)));
    (ex ?? []).forEach((r: any) => existentes.set(String(r.pedido_externo), r));

    for (const o of lista) {
      lidos++;
      const pag = (o.payments ?? []).filter((p: any) => p.status === "approved" && p.date_approved);
      const cancelado = o.status === "cancelled";
      if (!pag.length && !cancelado) { ignorados++; continue; }
      const pagoEm = pag.length
        ? pag.map((p: any) => p.date_approved).sort()[0]
        : (o.date_closed ?? o.date_created);
      if (new Date(pagoEm).getTime() < INICIO_MS) { ignorados++; continue; }

      const ja = existentes.get(String(o.id));
      if (ja && String(ja.status) === String(o.status)) {
        if (cancelado && ja.cancelado_em) { jaProntos++; continue; }
        // frete confirmado, ou pedido antigo (lido antes desta regra): não precisa reler
        const recente = Date.now() - new Date(pagoEm).getTime() < 4 * 86400_000;
        const freteLido = ja.dados?.frete_ok === true || (ja.dados?.frete_ok === undefined && !recente);
        if (!cancelado && ja.dados?.cupom_checado === true && Number(ja.taxa_marketplace) > 0 && freteLido && !ja.frete_pendente && !ja.aguardando_dados) { jaProntos++; continue; }
      }

      const itens: any[] = o.order_items ?? [];
      const taxa = itens.reduce((s, i) => s + Number(i.sale_fee ?? 0) * Number(i.quantity ?? 1), 0);
      const cupom = pag.reduce((s: number, p: any) => s + Number(p.coupon_amount ?? 0), 0);

      let descRaw: any = null, cupomVendedor: number | null = null;
      if (!cancelado) {
        try {
          descRaw = await ml(`/orders/${o.id}/discounts`, token);
          cupomVendedor = parteVendedor(descRaw);
        } catch (e) {
          const msg = (e as Error).message;
          descRaw = { erro: msg.slice(0, 160) };
          // 404 discount_not_found = o pedido não tem desconto nenhum
          if (msg.includes("discount_not_found") || msg.startsWith("ML 404")) cupomVendedor = 0;
        }
      }
      // Sem detalhe da API, assume o cupom do pagamento inteiro como do vendedor (jeito conservador).
      const descontoVendedor = cupomVendedor !== null ? cupomVendedor : cupom;

      let frete = 0, envio: any = null, envioStatus: string | null = null, envioSub: string | null = null, freteOk = false, provisorio = false;
      const shipId = o.shipping?.id;
      if (shipId && !cancelado) {
        let custoLido = false;
        try {
          envio = await ml(`/shipments/${shipId}/costs`, token, { "x-format-new": "true" });
          const s = (envio?.senders ?? [])[0];
          frete = Number(s?.cost ?? 0);
          custoLido = true;
        } catch (e) { erros.push(`frete ${o.id}: ${(e as Error).message.slice(0, 120)}`); }
        try {
          const sh = await ml(`/shipments/${shipId}`, token);
          envioStatus = sh?.status ?? null; envioSub = sh?.substatus ?? null;
        } catch (e) { erros.push(`envio ${o.id}: ${(e as Error).message.slice(0, 120)}`); }
        freteOk = custoLido && freteConfirmado(envioStatus, envioSub);
        provisorio = !custoLido || freteProvisorio(envioStatus, envioSub);
      } else if (!cancelado) {
        freteOk = true; // sem envio do vendedor (retirada etc.): nada a confirmar
      }
      const pendente = !cancelado && provisorio;
      if (pendente) pendentes++;
      // fora dos totais até ter taxa real e cupom conferido (máx. 60 min)
      const aguarda = !cancelado && (taxa <= 0 || cupomVendedor === null) && (Date.now() - new Date(pagoEm).getTime() < ESPERA_MAX_MS);
      if (aguarda) aguardando++;
      if (ja && (ja.frete_pendente !== pendente || ja.aguardando_dados !== aguarda)) diasAfetados.add(ja.dia);

      const linha: any = {
        loja_id: loja.id,
        pedido_externo: String(o.id),
        status: String(o.status),
        pago_em: pagoEm,
        cancelado_em: cancelado ? (o.date_closed ?? new Date().toISOString()) : null,
        taxa_marketplace: Math.round(taxa * 100) / 100,
        frete_vendedor: Math.round(frete * 100) / 100,
        desconto_vendedor: Math.round(descontoVendedor * 100) / 100,
        frete_pendente: pendente,
        aguardando_dados: aguarda,
        dados: {
          total: o.total_amount, pago: o.paid_amount, envio_id: shipId ?? null,
          envio_status: envioStatus, envio_substatus: envioSub, frete_ok: freteOk || cancelado,
          pack_id: o.pack_id ?? null,
          logistica: o.shipping?.logistic_type ?? null,
          cupom_total: cupom,
          cupom_vendedor: cupomVendedor,
          cupom_checado: cupomVendedor !== null || cancelado,
          descontos_raw: descRaw,
          pagamentos: pag.map((p: any) => ({ transacao: p.transaction_amount, cupom: p.coupon_amount, frete: p.shipping_cost, total_pago: p.total_paid_amount })),
          custo_envio: envio ? { senders: envio.senders, receiver: envio.receiver } : null,
          taxas_item: itens.map((i) => ({ sale_fee: i.sale_fee, qtd: i.quantity, unit: i.unit_price, full: i.full_unit_price, listing: i.listing_type_id })),
        },
      };
      const { data: ped, error: ep } = await supabase.from("lucro_pedidos")
        .upsert(linha, { onConflict: "loja_id,pedido_externo" }).select("id, dia").single();
      if (ep || !ped) { erros.push(`pedido ${o.id}: ${ep?.message}`); continue; }
      gravados++;
      diasAfetados.add(ped.dia);
      if (!ultimoPago || pagoEm > ultimoPago) ultimoPago = pagoEm;

      // preserva o vínculo de produto já feito nos itens (mesmo anúncio e SKU)
      const { data: antigos } = await supabase.from("lucro_itens").select("sku, anuncio_id, produto_id").eq("pedido_id", ped.id);
      await supabase.from("lucro_itens").delete().eq("pedido_id", ped.id);
      const novos = itens.map((i) => {
        const sku = i.item?.seller_sku ?? i.item?.seller_custom_field ?? null, anuncio = i.item?.id ?? null;
        const velho = (antigos ?? []).find((a: any) => (a.sku ?? null) === sku && (a.anuncio_id ?? null) === anuncio && a.produto_id);
        return {
          pedido_id: ped.id, sku, anuncio_id: anuncio, titulo: i.item?.title ?? null,
          quantidade: Number(i.quantity ?? 1), preco_unitario: Number(i.unit_price ?? 0),
          ...(velho ? { produto_id: velho.produto_id } : {}),
        };
      });
      if (novos.length) {
        const { error: ei } = await supabase.from("lucro_itens").insert(novos);
        if (ei) erros.push(`itens ${o.id}: ${ei.message}`); else itensGravados += novos.length;
      }
    }
    if (lista.length < 50) break;
    await pausa(150);
  }
  await supabase.from("lucro_sync").upsert({
    loja_id: loja.id, ultimo_pago_em: ultimoPago, ultima_execucao: new Date().toISOString(),
    erro: erros.length ? erros[0].slice(0, 300) : null,
  } as any, { onConflict: "loja_id" });
  return { loja: loja.apelido, lidos, gravados, ja_prontos: jaProntos, itens: itensGravados, ignorados, frete_pendentes: pendentes, aguardando_dados: aguardando, dias: [...diasAfetados], erros: erros.slice(0, 10) };
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

async function tratar(req: Request): Promise<Response> {
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso ao Lucro Ao Vivo." }, 403);
  const corpo: any = await req.json().catch(() => ({}));
  // pelo menos 3 dias, para reler os pedidos que ainda esperam o frete ser confirmado
  const dias = Math.min(Math.max(Number(corpo.dias ?? 2), 3), 60);
  const limite = Math.min(Math.max(Number(corpo.limite ?? 500), 50), 2000);
  let q = supabase.from("lojas").select("id, apelido, nome, id_externo").eq("marketplace", "mercado_livre").eq("ativa", true);
  if (corpo.loja_id) q = q.eq("id", String(corpo.loja_id));
  const { data: lojas } = await q;

  const saida: any[] = [];
  const dias_calc = new Set<string>();
  for (const l of lojas ?? []) {
    try {
      const r: any = await sincronizarLoja(l, dias, limite);
      (r.dias ?? []).forEach((d: string) => dias_calc.add(d));
      saida.push({ ...r, nome: l.nome });
    } catch (e) {
      saida.push({ loja: l.apelido, erro: (e as Error).message.slice(0, 300) });
    }
  }
  for (const d of dias_calc) {
    const { error } = await supabase.rpc("lucro_calcular_dia", { p_dia: d });
    if (error) saida.push({ erro_calculo: d, msg: error.message });
  }
  return resp({ ok: true, dias_recalculados: [...dias_calc].sort(), lojas: saida });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try { return await tratar(req); }
  catch (e) { console.error("lucro-ml-sync", (e as Error).message); return resp({ ok: false, erro: "Falha inesperada." }, 500); }
});
