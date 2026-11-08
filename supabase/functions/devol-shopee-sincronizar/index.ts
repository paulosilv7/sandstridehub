// Devoluções (SOMENTE LEITURA): traz as devoluções da Shopee e registra em devol_casos.
// Não responde, não contesta e não envia nada ao marketplace. Respeita a chave kill_switch.
// Economia de registros (logs do Supabase): os casos da loja são lidos de uma vez só e o evento de leitura só é gravado quando o caso é criado ou muda.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGEM = "devol-shopee-sincronizar";
const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function diag(mensagem: string) {
  console.error(ORIGEM, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

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

const ESTADOS_INICIAIS = ["NOVO", "AGUARDANDO_ANALISE", "AGUARDANDO_PROVAS", "PREPARADO"];

function proximoEstado(atual: string | null, fechado: boolean, disputa: boolean): string {
  if (!atual) return fechado ? "DECIDIDO" : disputa ? "EM_ANALISE" : "NOVO";
  if (ESTADOS_INICIAIS.includes(atual)) return fechado ? "DECIDIDO" : atual;
  if (atual === "ENVIADO") return fechado ? "DECIDIDO" : disputa ? "EM_ANALISE" : atual;
  if (["EM_ANALISE", "COMPLEMENTACAO", "RECURSO_DISPONIVEL"].includes(atual)) return fechado ? "DECIDIDO" : atual;
  return atual;
}

const isoDe = (t: any) => (t ? new Date(Number(t) * 1000).toISOString() : null);

function prioridade(estado: string, prazo: string | null): string {
  if (["ENVIADO", "EM_ANALISE", "DECIDIDO", "CREDITO_PENDENTE"].includes(estado)) return "P3";
  if (prazo) {
    const h = (new Date(prazo).getTime() - Date.now()) / 3_600_000;
    if (h < 24) return "P0";
    if (h < 48) return "P1";
  }
  return "P2";
}

// Sem ação da loja (a loja só espera):
// (a) JUDGING: a Shopee está julgando;
// (b) REQUESTED sem prazo da loja e sem prova a enviar (ex.: "não recebi o pacote", analisado com a transportadora);
// (c) PROCESSING/ACCEPTED sem prazo da loja, ou com devolução física que ainda não chegou à loja (a loja só age quando o produto for entregue).
// A lista não traz a prova do vendedor nem a logística; consultamos o detalhe só quando preciso.
async function semAcaoDaLoja(r: any, c: { token: string; shopId: string }): Promise<boolean> {
  const st = String(r.status ?? "");
  if (st === "JUDGING") return true;
  const vend = Number(r.return_seller_due_date) > 0;
  if (st === "REQUESTED") {
    if (vend) return false;
    let prova = r.seller_proof?.seller_proof_status;
    if (prova === undefined) {
      try {
        const d = await chamar("/api/v2/returns/get_return_detail", c.token, c.shopId, { return_sn: String(r.return_sn) });
        prova = d?.seller_proof?.seller_proof_status;
      } catch (_) { return false; }
    }
    return String(prova ?? "") === "NOT_NEEDED";
  }
  if (st === "PROCESSING" || st === "ACCEPTED") {
    if (!vend) return true;
    try {
      const d = await chamar("/api/v2/returns/get_return_detail", c.token, c.shopId, { return_sn: String(r.return_sn) });
      const fisica = d?.needs_logistics === true;
      const ls = String(d?.logistics_status ?? d?.reverse_logistics_status ?? "");
      return fisica && ls !== "LOGISTICS_DELIVERY_DONE";
    } catch (_) { return false; }
  }
  return false;
}

// Todos os casos da loja numa consulta só.
async function carregarCache(lojaId: string): Promise<Map<string, any>> {
  const m = new Map<string, any>();
  const { data } = await supabase.from("devol_casos").select("id, solicitacao_id, status, prazo_em").eq("loja_id", lojaId).limit(3000);
  for (const r of data ?? []) m.set(String(r.solicitacao_id), r);
  return m;
}

async function registrar(loja: any, r: any, resumo: any, explorar: boolean, c: { token: string; shopId: string }, cache: Map<string, any>) {
  const solicitacao = String(r.return_sn);
  const status = String(r.status ?? "");
  const fechado = ["CLOSED", "CANCELLED"].includes(status);
  const atual: any = cache.get(solicitacao) ?? null;
  const semAcaoLoja = fechado ? false : await semAcaoDaLoja(r, c);
  const disputa = ["JUDGING", "SELLER_DISPUTE"].includes(status) || semAcaoLoja;
  // Volta a "aguardando você" quando a Shopee passa a exigir ação da loja (ex.: produto devolvido chegou).
  const reabre = !semAcaoLoja && !fechado && !disputa && atual?.status === "EM_ANALISE";
  const estado = semAcaoLoja && ESTADOS_INICIAIS.includes(atual?.status ?? "NOVO") ? "EM_ANALISE" : reabre ? "NOVO" : proximoEstado(atual?.status ?? null, fechado, disputa);
  // Prazo da LOJA: quando existir (valor > 0), é return_seller_due_date; senão, due_date (prazo interno da Shopee). Sem ação da loja: sem prazo.
  const prazo = semAcaoLoja ? null : isoDe(Number(r.return_seller_due_date) > 0 ? r.return_seller_due_date : r.due_date);
  const valor = Number(r.refund_amount);
  const campos: any = {
    pedido: r.order_sn ? String(r.order_sn) : undefined,
    motivo_original: r.reason ?? undefined,
    status: estado,
    prioridade: prioridade(estado, fechado ? null : prazo),
    prazo_em: fechado ? undefined : (semAcaoLoja ? null : (prazo ?? undefined)),
    valor_em_risco: Number.isFinite(valor) && valor > 0 ? valor : undefined,
    proxima_verificacao: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  };
  Object.keys(campos).forEach((k) => campos[k] === undefined && delete campos[k]);
  let casoId = atual?.id as string | undefined;
  const prazoMudou = (!!campos.prazo_em && (!atual?.prazo_em || new Date(atual.prazo_em).getTime() !== new Date(campos.prazo_em).getTime())) || (semAcaoLoja && !!atual?.prazo_em);
  let gravou = false;
  if (!casoId) {
    const { data: novo, error } = await supabase.from("devol_casos").insert({ loja_id: loja.id, solicitacao_id: solicitacao, ...campos }).select("id").single();
    if (error) throw new Error(`erro ao criar o caso ${solicitacao}: ${error.message}`);
    casoId = novo.id; resumo.novos++; gravou = true;
  } else if (atual!.status !== estado || prazoMudou) {
    const { error } = await supabase.from("devol_casos").update(campos).eq("id", casoId);
    if (error) throw new Error(`erro ao atualizar o caso ${solicitacao}: ${error.message}`);
    if (atual!.status !== estado) resumo.mudaram++;
    gravou = true;
  }
  // O evento de leitura só é gravado quando o caso é criado ou muda (antes era regravado a cada leitura, sempre ignorado como duplicado).
  if (gravou) {
    await supabase.from("devol_eventos").upsert({
      caso_id: casoId, tipo: "leitura_marketplace", evento_chave: `sp:${solicitacao}:${status}:${r.update_time ?? ""}${semAcaoLoja ? ":analise" : ""}`,
      dados: { fonte: "shopee", return_sn: solicitacao, status, type: r.status ?? null, stage: disputa ? "dispute" : null, analise: semAcaoLoja && status === "REQUESTED", reason: r.reason ?? null, pedido: r.order_sn ?? null, prazo_vendedor: prazo, valor_reembolso: r.refund_amount ?? null, logistica: r.logistics_status ?? r.reverse_logistics_status ?? null, estado_local: estado },
    }, { onConflict: "evento_chave", ignoreDuplicates: true });
  }
  if (explorar && !resumo.amostra) resumo.amostra = { campos_prazo: { due_date: r.due_date, seller: r.return_seller_due_date, ship: r.return_ship_due_date, logistica: r.logistics_status } };
}

async function sincronizarLoja(loja: any, explorar: boolean, inicio: number): Promise<any> {
  const resumo: any = { loja: loja.apelido, novos: 0, mudaram: 0, lidos: 0 };
  const c = await credenciais(loja.id);
  if (!c) { resumo.erro = "conexão precisa ser refeita"; return resumo; }
  const cache = await carregarCache(loja.id);
  const agora = Math.floor(Date.now() / 1000);
  for (let j = 0; j < 3; j++) {
    const fim = agora - j * 15 * 86400, ini = fim - 15 * 86400 + 60;
    for (let pag = 0; pag < 10 && Date.now() - inicio < 100_000; pag++) {
      let d: any;
      try { d = await chamar("/api/v2/returns/get_return_list", c.token, c.shopId, { page_no: String(pag), page_size: "50", update_time_from: String(ini), update_time_to: String(fim) }); }
      catch (e) { resumo.erro_busca = (e as Error).message.slice(0, 250); return resumo; }
      const lista: any[] = d?.return ?? d?.returns ?? [];
      for (const r of lista) {
        try { await registrar(loja, r, resumo, explorar, c, cache); resumo.lidos++; }
        catch (e) { resumo.erro_registro = (e as Error).message.slice(0, 250); }
      }
      if (!d?.more || !lista.length) break;
    }
  }
  return resumo;
}

async function chaveLigada(chave: string): Promise<boolean> {
  const { data } = await supabase.from("devol_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor === "true";
}

async function executar(explorar: boolean) {
  const inicio = Date.now();
  const resultados: any[] = [];
  try {
    if (await chaveLigada("kill_switch")) { await diag("kill_switch ligado: leitura não executada"); return; }
    const { data: lojas } = await supabase.from("lojas").select("id, apelido").eq("marketplace", "shopee").eq("ativa", true);
    for (const l of lojas ?? []) resultados.push(await sincronizarLoja(l, explorar, inicio));
    await supabase.from("devol_config").upsert({ chave: "ultima_leitura_shopee", valor: new Date().toISOString(), descricao: "Última leitura de devoluções da Shopee", atualizado_em: new Date().toISOString() });
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : String(e)}`); }
  if (explorar || resultados.some((r) => r.erro || r.erro_busca)) await diag(`resultado: ${JSON.stringify(resultados)}`);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(executar(!!corpo.explorar));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
