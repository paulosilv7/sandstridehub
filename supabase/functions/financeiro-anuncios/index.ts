// Financeiro > gasto com anúncios por loja e por dia, lido direto do marketplace (nada estimado).
// Mercado Livre: Product Ads (custo diário real da conta de anúncios da loja).
// Shopee: Shopee Ads (gasto diário real de anúncios CPC, `expense`, por loja).
// TikTok ainda não tem leitura: fica sem linha (a tela mostra "ainda não li").
// Quem chama: agendador do banco (x-fin-token) ou pessoa logada com acesso ao Financeiro.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";
const SP_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
const supabase = createClient(URL_BASE, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fin-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function segredoFin(): Promise<string> {
  const { data } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram:${data?.valor ?? ""}`));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function autorizado(req: Request): Promise<boolean> {
  const t = req.headers.get("x-fin-token");
  if (t) return t === await segredoFin();
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return false;
  const u = createClient(URL_BASE, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await u.rpc("fin_geral_ok");
  return data === true;
}
async function tokenDaLoja(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) { const { data: outra } = await ler(); return valido(outra) ? outra!.token_acesso : null; }
  await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
  return t.access_token;
}
async function ml(caminho: string, token: string, versao = "1"): Promise<any> {
  const r = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Api-Version": versao } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ML ${r.status} ${caminho.slice(0, 90)}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}
const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);


// ---------- Shopee ----------
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function spPublica(path: string, corpo: any) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_PARTNER_ID}${path}${ts}`);
  const r = await fetch(`${SP_HOST}${path}?` + new URLSearchParams({ partner_id: SP_PARTNER_ID, timestamp: String(ts), sign }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j;
}
async function spChamar(path: string, token: string, shopId: string, params: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_PARTNER_ID}${path}${ts}${token}${shopId}`);
  const r = await fetch(`${SP_HOST}${path}?${new URLSearchParams({ ...params, partner_id: SP_PARTNER_ID, timestamp: String(ts), access_token: token, shop_id: shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path.slice(0, 60)}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
  return j.response ?? j;
}
async function spCredenciais(lojaId: string): Promise<{ token: string; shopId: string } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const shopId = String((cred.dados_extras as any)?.shop_id ?? "");
  if (!shopId) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 300_000;
  if (valido(cred)) return { token: cred.token_acesso, shopId };
  if (!cred.token_renovacao) return null;
  try {
    const t = await spPublica("/api/v2/auth/access_token/get", { refresh_token: cred.token_renovacao, shop_id: Number(shopId) });
    await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString() }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  } catch (_) {
    const { data: outra } = await ler();
    return valido(outra) ? { token: outra!.token_acesso, shopId } : null;
  }
}
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const dmyParaIso = (d: string) => /^\d{2}-\d{2}-\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso." }, 403);
  const corpo: any = await req.json().catch(() => ({}));
  const dias = Math.min(Math.max(Number(corpo.dias ?? 7), 1), 90);
  const fim = hojeSP(), ini = somaDias(fim, -(dias - 1));
  const { data: lojas } = await supabase.from("lojas").select("id, apelido, nome").eq("marketplace", "mercado_livre").eq("ativa", true);
  const saida: any[] = [];
  for (const l of lojas ?? []) {
    try {
      const token = await tokenDaLoja(l.id);
      if (!token) { saida.push({ loja: l.apelido, erro: "conexão precisa ser refeita" }); continue; }
      const adv = await ml("/advertising/advertisers?product_id=PADS", token, "1");
      const id = adv?.advertisers?.[0]?.advertiser_id;
      if (!id) { saida.push({ loja: l.apelido, erro: "sem conta de anúncios" }); continue; }
      const m = await ml(`/advertising/MLB/advertisers/${id}/product_ads/campaigns/search?date_from=${ini}&date_to=${fim}&metrics=cost&metrics_summary=true&aggregation_type=DAILY&limit=1`, token, "2");
      const linhas = (m.results ?? []).filter((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) && Number.isFinite(Number(r.cost)))
        .map((r: any) => ({ loja_id: l.id, dia: r.date, valor: Math.round(Number(r.cost) * 100) / 100, atualizado_em: new Date().toISOString() }));
      if (linhas.length) { const { error } = await supabase.from("financeiro_ads_dia").upsert(linhas, { onConflict: "loja_id,dia" }); if (error) throw new Error(error.message); }
      saida.push({ loja: l.apelido, dias: linhas.length, total: Math.round(linhas.reduce((s: number, r: any) => s + r.valor, 0) * 100) / 100 });
    } catch (e) { saida.push({ loja: l.apelido, erro: (e as Error).message.slice(0, 250) }); }
  }
  const { data: lojasSp } = await supabase.from("lojas").select("id, apelido, nome").eq("marketplace", "shopee").eq("ativa", true);
  for (const l of lojasSp ?? []) {
    try {
      const c = await spCredenciais(l.id);
      if (!c) { saida.push({ loja: l.apelido, mkt: "shopee", erro: "conexão precisa ser refeita" }); continue; }
      const porDia = new Map<string, number>();
      // a Shopee limita a janela da consulta: busca de 30 em 30 dias
      for (let fimJ = fim; fimJ >= ini; fimJ = somaDias(fimJ, -30)) {
        const iniJ = somaDias(fimJ, -29) < ini ? ini : somaDias(fimJ, -29);
        const r = await spChamar("/api/v2/ads/get_all_cpc_ads_daily_performance", c.token, c.shopId, { start_date: dmy(iniJ), end_date: dmy(fimJ) });
        for (const x of (Array.isArray(r) ? r : [])) { const d = dmyParaIso(String(x.date)); const v = Number(x.expense); if (d && Number.isFinite(v)) porDia.set(d, (porDia.get(d) ?? 0) + v); }
      }
      const linhas = [...porDia.entries()].map(([dia, v]) => ({ loja_id: l.id, dia, valor: Math.round(v * 100) / 100, atualizado_em: new Date().toISOString() }));
      if (linhas.length) { const { error } = await supabase.from("financeiro_ads_dia").upsert(linhas, { onConflict: "loja_id,dia" }); if (error) throw new Error(error.message); }
      saida.push({ loja: l.apelido, mkt: "shopee", dias: linhas.length, total: Math.round(linhas.reduce((s: number, r: any) => s + r.valor, 0) * 100) / 100 });
    } catch (e) { saida.push({ loja: l.apelido, mkt: "shopee", erro: (e as Error).message.slice(0, 250) }); }
  }
  return resp({ ok: true, de: ini, ate: fim, lojas: saida });
});
