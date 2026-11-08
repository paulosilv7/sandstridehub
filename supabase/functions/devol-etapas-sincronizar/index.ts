// Devoluções (SOMENTE LEITURA): descobre em que etapa física está cada devolução: despachar (cliente ainda não postou), transito (postado, a caminho) ou chegou (entregue na loja).
// Mercado Livre: /post-purchase/v2/claims/{id}/returns (status label_generated / shipped / delivered). Shopee: get_return_detail (logistics_status). TikTok é deduzido da situação no próprio app.
// Inclui casos decididos e arquivados: o produto pode chegar (e precisar de conferência) depois da decisão do marketplace.
// Não envia nada aos marketplaces. Respeita a chave kill_switch.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const ORIGEM = "devol-etapas-sincronizar";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
async function diag(m: string) { console.error(ORIGEM, m); try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: m.slice(0, 1500) }); } catch (_) { /* */ } }
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COLUNAS = "id, solicitacao_id, etapa_fisica, etapa_fisica_em, etapa_fisica_checada_em, status, desfecho";
const FINAIS = "(ENCERRADO,CONCILIADO)";

// Casos a conferir: todos que não são cancelados/ganhos pela loja, inclusive decididos e arquivados. Etapa final (chegou) não precisa reler.
async function candidatos(lojaId: string, limite: number): Promise<any[]> {
  const { data } = await supabase.from("devol_casos").select(COLUNAS).eq("loja_id", lojaId).not("status", "in", FINAIS).limit(2000);
  const seis = Date.now() - 6 * 3_600_000;
  const lista = (data ?? []).filter((c: any) => {
    if (c.etapa_fisica === "chegou") return false;
    if (c.desfecho === "cancelado" || c.desfecho === "ganhamos") return false;
    if (c.etapa_fisica === "despachar" || c.etapa_fisica === "transito") return true;
    return !c.etapa_fisica_checada_em || new Date(c.etapa_fisica_checada_em).getTime() < seis;
  });
  lista.sort((a: any, b: any) => String(a.etapa_fisica_checada_em ?? "").localeCompare(String(b.etapa_fisica_checada_em ?? "")));
  return lista.slice(0, limite);
}

async function gravar(c: any, etapa: string | null, quando: string | null) {
  const agora = new Date().toISOString();
  const igual = (c.etapa_fisica ?? null) === etapa;
  const campos: any = { etapa_fisica_checada_em: agora };
  if (!igual) { campos.etapa_fisica = etapa; campos.etapa_fisica_em = etapa ? (quando ?? agora) : null; }
  if (igual && etapa !== null && !!c.etapa_fisica_checada_em && Date.now() - new Date(c.etapa_fisica_checada_em).getTime() < 3_600_000) return false;
  await supabase.from("devol_casos").update(campos).eq("id", c.id);
  return !igual;
}

// ---------------- Mercado Livre ----------------
const API = "https://api.mercadolibre.com";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
class ErroHttp extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } }
async function ml(caminho: string, token: string): Promise<any> {
  const r = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new ErroHttp(`ML ${r.status} ${caminho}`, r.status);
  return await r.json();
}
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) return cred.token_acesso;
  if (!cred?.token_renovacao) return null;
  const resp = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }) });
  const t: any = await resp.json().catch(() => ({}));
  if (resp.ok) {
    await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return t.access_token;
  }
  const { data: outra } = await ler();
  return valido(outra) ? outra!.token_acesso : null;
}
function etapaML(r: any): { etapa: string | null; quando: string | null } {
  const st = String(r?.status ?? "").toLowerCase();
  const quando = r?.last_updated ? new Date(r.last_updated).toISOString() : null;
  if (st === "delivered") return { etapa: "chegou", quando };
  if (st === "shipped") return { etapa: "transito", quando };
  if (["label_generated", "pending", "opened", "scheduled", "ready_to_ship"].includes(st)) return { etapa: "despachar", quando };
  return { etapa: null, quando: null };
}
async function lojaML(loja: any, inicio: number, desconhecidos: Set<string>): Promise<any> {
  const res: any = { loja: loja.id, lidos: 0, mudaram: 0, limite429: false };
  const token = await tokenML(loja.id);
  if (!token) return { ...res, erro: "sem token" };
  for (const c of await candidatos(loja.id, 70)) {
    if (Date.now() - inicio > 100_000) break;
    try {
      const r = await ml(`/post-purchase/v2/claims/${c.solicitacao_id}/returns`, token);
      const envios = (r?.shipments ?? []).filter((s: any) => String(s?.type ?? "return") === "return");
      if (!envios.length) { await gravar(c, null, null); res.lidos++; continue; }
      const e = etapaML(r);
      if (!e.etapa && r?.status) desconhecidos.add(`ml:${r.status}`);
      if (await gravar(c, e.etapa, e.quando)) res.mudaram++;
      res.lidos++;
    } catch (e) {
      if (e instanceof ErroHttp && (e.status === 404 || e.status === 400)) { await gravar(c, null, null); res.lidos++; }
      else if (e instanceof ErroHttp && e.status === 429) { res.limite429 = true; break; }
    }
    await dorme(250);
  }
  return res;
}

// ---------------- Shopee ----------------
const PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function shopee(path: string, token: string, shopId: string, params: Record<string, string>) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(KEY, `${PARTNER_ID}${path}${ts}${token}${shopId}`);
  const r = await fetch(`${HOST}${path}?${new URLSearchParams({ ...params, partner_id: PARTNER_ID, timestamp: String(ts), access_token: token, shop_id: shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""}`);
  return j.response ?? j;
}
async function credShopee(lojaId: string): Promise<{ token: string; shopId: string } | null> {
  const { data: cred } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const shopId = String((cred?.dados_extras as any)?.shop_id ?? "");
  if (!cred || !shopId || !cred.expira_em || new Date(cred.expira_em).getTime() - Date.now() < 120_000) return null;
  return { token: cred.token_acesso, shopId };
}
const SHOPEE_CONHECIDOS = ["LOGISTICS_NOT_START", "LOGISTICS_PENDING_ARRANGE", "LOGISTICS_REQUEST_CREATED", "LOGISTICS_READY", "LOGISTICS_PICKUP_RETRY", "LOGISTICS_PICKUP_DONE", "LOGISTICS_DELIVERY_DONE", "LOGISTICS_PENDING_RECEIVE", "LOGISTICS_REQUEST_CANCELED"];
function etapaShopee(d: any, desconhecidos: Set<string>): { etapa: string | null; quando: string | null } {
  if (d?.needs_logistics !== true) return { etapa: null, quando: null };
  const ls = String(d?.logistics_status ?? d?.reverse_logistics_status ?? "");
  const quando = d?.update_time ? new Date(Number(d.update_time) * 1000).toISOString() : null;
  if (ls && !SHOPEE_CONHECIDOS.includes(ls)) desconhecidos.add(`shopee:${ls}`);
  if (ls.includes("CANCELED")) return { etapa: null, quando: null };
  if (ls.includes("DELIVERY_DONE")) return { etapa: "chegou", quando };
  if (ls.includes("PICKUP_DONE") || ls.includes("IN_TRANSIT")) return { etapa: "transito", quando };
  return { etapa: "despachar", quando };
}
async function lojaShopee(loja: any, inicio: number, desconhecidos: Set<string>): Promise<any> {
  const res = { loja: loja.id, lidos: 0, mudaram: 0 };
  const c = await credShopee(loja.id);
  if (!c) return { ...res, erro: "sem token válido" };
  for (const caso of await candidatos(loja.id, 60)) {
    if (Date.now() - inicio > 100_000) break;
    try {
      const d = await shopee("/api/v2/returns/get_return_detail", c.token, c.shopId, { return_sn: String(caso.solicitacao_id) });
      const e = etapaShopee(d, desconhecidos);
      if (await gravar(caso, e.etapa, e.quando)) res.mudaram++;
      res.lidos++;
    } catch (_) { /* tenta na próxima */ }
  }
  return res;
}

async function executar() {
  const inicio = Date.now(); const resultados: any[] = []; const desconhecidos = new Set<string>();
  try {
    const { data: k } = await supabase.from("devol_config").select("valor").eq("chave", "kill_switch").maybeSingle();
    if (k?.valor === "true") return;
    const { data: lojas } = await supabase.from("lojas").select("id, marketplace").eq("ativa", true).in("marketplace", ["mercado_livre", "shopee"]);
    for (const l of lojas ?? []) {
      if (Date.now() - inicio > 105_000) break;
      resultados.push(l.marketplace === "shopee" ? await lojaShopee(l, inicio, desconhecidos) : await lojaML(l, inicio, desconhecidos));
    }
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : e}`); }
  const ruins = [...desconhecidos].filter((x) => !/^ml:(not_delivered|cancelled|expired|failed|closed)$/.test(x));
  if (ruins.length) await diag(`status não mapeados: ${ruins.join(", ")}`);
  if (resultados.some((r) => r.erro)) await diag(`resultado: ${JSON.stringify(resultados).slice(0, 900)}`);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  EdgeRuntime.waitUntil(executar());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
