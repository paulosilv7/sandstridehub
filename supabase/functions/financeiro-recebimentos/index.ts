// Financeiro > Recebimentos: lê o que os marketplaces informam sobre dinheiro (só leitura, nada é gravado).
// Mercado Livre: a liberar (valor e data informados pelo ML), liberado nos últimos 7 e 30 dias e pagamentos em mediação.
// Shopee: a liberar (total, sem data), liberado (extrato de repasse) e devoluções abertas. TikTok: pago ao banco e valor retido; não informa "a liberar".
// Regra: só entra valor que o marketplace informa como fato. O resultado fica em cache por 10 minutos (financeiro_cache); "force" ignora o cache.
// Quem pode chamar: apenas Paulo e Lucas (login). Valores líquidos (net_received_amount), em reais.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";
const MP = "https://api.mercadopago.com";
const SP_PARTNER = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const SP_HOST = "https://partner.shopeemobile.com";
const TT_API = "https://open-api.tiktokglobalshop.com";
const TT_AUTH = "https://auth.tiktok-shops.com";
const TT_PADRAO = "6lo1ttda2b1bf";
const ttApp = (k: string) => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const PERMITIDOS = new Set(["0cd665bf-e4fb-4087-91a7-e5312cbafe6a", "ebccd17d-16d7-46cc-82cd-1622c3fd254d"]);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA = 86400_000;

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
  if (!r.ok) { const { data: outra } = await ler(); return valido(outra) ? outra!.token_acesso : null; }
  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token,
    token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

async function pagamentos(token: string, params: Record<string, string>, maximo = 5000): Promise<any[]> {
  const todos: any[] = [];
  for (let offset = 0; offset < maximo; offset += 1000) {
    const qs = new URLSearchParams({ ...params, limit: "1000", offset: String(offset) });
    const r = await fetch(`${MP}/v1/payments/search?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`MP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const lista: any[] = j.results ?? [];
    todos.push(...lista);
    if (lista.length < 1000 || offset + 1000 >= Number(j.paging?.total ?? 0)) break;
  }
  return todos;
}
const liquido = (p: any) => Number(p?.transaction_details?.net_received_amount ?? 0);
// dia (AAAA-MM-DD) no horário de São Paulo
const diaSP = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoSP = (ms: number) => new Date(ms).toISOString();

async function lerLoja(loja: any) {
  const token = await tokenDaLoja(loja.id);
  if (!token) return { id: loja.id, nome: loja.nome, erro: "conexão precisa ser refeita" };
  const agora = Date.now();
  const [futuros, passados, med, chb] = await Promise.all([
    pagamentos(token, { sort: "money_release_date", criteria: "asc", range: "money_release_date", begin_date: isoSP(agora), end_date: isoSP(agora + 120 * DIA), status: "approved" }),
    pagamentos(token, { sort: "money_release_date", criteria: "desc", range: "money_release_date", begin_date: isoSP(agora - 30 * DIA), end_date: isoSP(agora), status: "approved" }),
    pagamentos(token, { sort: "date_created", criteria: "desc", status: "in_mediation" }),
    pagamentos(token, { sort: "date_created", criteria: "desc", status: "charged_back" }),
  ]);
  const lib: Record<string, number> = {};
  let arec = 0;
  for (const p of futuros) {
    if (!p.money_release_date || new Date(p.money_release_date).getTime() <= agora) continue;
    const v = liquido(p);
    arec += v;
    const d = diaSP(p.money_release_date);
    lib[d] = r2((lib[d] ?? 0) + v);
  }
  let pago7 = 0, pago30 = 0;
  for (const p of passados) {
    if (p.money_release_status !== "released" || !p.money_release_date) continue;
    const t = new Date(p.money_release_date).getTime();
    if (t > agora) continue;
    const v = liquido(p);
    pago30 += v;
    if (t >= agora - 7 * DIA) pago7 += v;
  }
  const disputa = [...med, ...chb];
  return {
    id: loja.id, nome: loja.nome,
    a_receber: r2(arec), liberacoes: lib,
    pago_7d: r2(pago7), pago_30d: r2(pago30),
    disputa: { qtd: disputa.length, valor: r2(disputa.reduce((s, p) => s + liquido(p), 0)) },
  };
}


async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sg = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sg)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---------- Shopee ----------
async function spCred(lojaId: string): Promise<{ token: string; shopId: string } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  if (!c) return null;
  const shopId = String((c.dados_extras as any)?.shop_id ?? "");
  if (!shopId) return null;
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 300_000;
  if (valido(c)) return { token: c.token_acesso, shopId };
  if (!c.token_renovacao) return null;
  try {
    const path = "/api/v2/auth/access_token/get", ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(SP_KEY, `${SP_PARTNER}${path}${ts}`);
    const r = await fetch(`${SP_HOST}${path}?` + new URLSearchParams({ partner_id: SP_PARTNER, timestamp: String(ts), sign }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: c.token_renovacao, shop_id: Number(shopId), partner_id: Number(SP_PARTNER) }) });
    const t: any = await r.json();
    if (!t.access_token) throw new Error("sem token");
    await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  } catch (_) { const { data: o } = await ler(); return valido(o) ? { token: o!.token_acesso, shopId } : null; }
}
async function spGet(path: string, c: { token: string; shopId: string }, params: Record<string, string>) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_PARTNER}${path}${ts}${c.token}${c.shopId}`);
  const r = await fetch(`${SP_HOST}${path}?${new URLSearchParams({ ...params, partner_id: SP_PARTNER, timestamp: String(ts), access_token: c.token, shop_id: c.shopId, sign })}`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Shopee ${path}: ${j.error ?? r.status} ${String(j.message ?? "").slice(0, 120)}`);
  return j.response ?? j;
}
// janelas de até 14 dias (limite da Shopee por consulta), da mais recente para a mais antiga
function janelas(dias: number): Array<[number, number]> {
  const fim = Math.floor(Date.now() / 1000), out: Array<[number, number]> = [];
  for (let d = 0; d < dias; d += 14) out.push([fim - Math.min(d + 14, dias) * 86400, fim - d * 86400]);
  return out;
}
const SP_ABERTAS = new Set(["REQUESTED", "ACCEPTED", "JUDGING", "PROCESSING", "SELLER_DISPUTE"]);
async function lerShopee(loja: any) {
  const c = await spCred(loja.id);
  if (!c) return { id: loja.id, nome: loja.nome, erro: "conexão precisa ser refeita" };
  const agora = Math.floor(Date.now() / 1000);
  const [visao, pagos, devol] = await Promise.all([
    spGet("/api/v2/payment/get_income_overview", c, {}),
    (async () => {
      const lista: Array<{ t: number; v: number }> = [];
      for (const [de, ate] of janelas(30)) {
        for (let p = 1; p <= 40; p++) {
          const r = await spGet("/api/v2/payment/get_escrow_list", c, { release_time_from: String(de), release_time_to: String(ate), page_size: "100", page_no: String(p) });
          for (const e of r.escrow_list ?? []) lista.push({ t: num(e.escrow_release_time), v: num(e.payout_amount) });
          if (!r.more) break;
        }
      }
      return lista;
    })(),
    (async () => {
      const abertas = new Map<string, number>();
      for (const [de, ate] of janelas(60)) {
        for (let p = 0; p < 20; p++) {
          const r = await spGet("/api/v2/returns/get_return_list", c, { page_no: String(p), page_size: "100", create_time_from: String(de), create_time_to: String(ate) });
          const l: any[] = r.return ?? [];
          for (const x of l) if (SP_ABERTAS.has(String(x.status))) abertas.set(String(x.return_sn), num(x.refund_amount));
          if (!r.more) break;
        }
      }
      return abertas;
    })(),
  ]);
  let pago7 = 0, pago30 = 0;
  for (const e of pagos) { pago30 += e.v; if (e.t >= agora - 7 * 86400) pago7 += e.v; }
  const dv = [...devol.values()];
  return { id: loja.id, nome: loja.nome, a_receber: r2(num(visao?.total_income?.pending_amount)), pago_7d: r2(pago7), pago_30d: r2(pago30), disputa: { qtd: dv.length, valor: r2(dv.reduce((a, b) => a + b, 0)) } };
}

// ---------- TikTok Shop ----------
async function ttCred(lojaId: string) {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  if (!c) return null;
  const app = ttApp((c.dados_extras as any)?.app_key ?? TT_PADRAO), cipher = (c.dados_extras as any)?.shop_cipher;
  if (!cipher) return null;
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  if (valido(c)) return { token: c.token_acesso, cipher, app };
  if (!c.token_renovacao) return null;
  const r = await fetch(`${TT_AUTH}/api/v2/token/refresh?` + new URLSearchParams({ app_key: app.k, app_secret: app.s, refresh_token: c.token_renovacao, grant_type: "refresh_token" }));
  const t: any = await r.json().catch(() => ({}));
  const d = t.data;
  if (!d?.access_token) { const { data: o } = await ler(); return valido(o) ? { token: o!.token_acesso, cipher, app } : null; }
  await supabase.from("credenciais_lojas").update({ token_acesso: d.access_token, token_renovacao: d.refresh_token ?? c.token_renovacao, expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
  return { token: d.access_token, cipher, app };
}
async function ttGet(path: string, c: any, params: Record<string, string>) {
  const q: Record<string, string> = { ...params, app_key: c.app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher };
  q.sign = await hmac(c.app.s, c.app.s + path + Object.keys(q).sort().map((k) => k + q[k]).join("") + c.app.s);
  const r = await fetch(`${TT_API}${path}?${new URLSearchParams(q)}`, { headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${path}: ${j.code ?? r.status} ${String(j.message ?? "").slice(0, 120)}`);
  return j.data ?? {};
}
async function lerTikTok(loja: any) {
  const c = await ttCred(loja.id);
  if (!c) return { id: loja.id, nome: loja.nome, erro: "conexão precisa ser refeita" };
  const agora = Math.floor(Date.now() / 1000);
  let pago7 = 0, pago30 = 0, ret = 0, nret = 0, token = "";
  for (let n = 0; n < 40; n++) {
    const p: Record<string, string> = { page_size: "100", sort_field: "create_time", create_time_ge: String(agora - 60 * 86400), create_time_lt: String(agora + 3600) };
    if (token) p.page_token = token;
    const d = await ttGet("/finance/202309/payments", c, p);
    for (const x of d.payments ?? []) {
      const v = num(x.amount?.value), res = num(x.reserve_amount?.value), pt = num(x.paid_time);
      if (String(x.status) === "PAID" && pt) { if (pt >= agora - 30 * 86400) pago30 += v; if (pt >= agora - 7 * 86400) pago7 += v; }
      if (res > 0) { ret += res; nret++; }
    }
    token = d.next_page_token ?? "";
    if (!token) break;
  }
  return { id: loja.id, nome: loja.nome, a_receber: null, pago_7d: r2(pago7), pago_30d: r2(pago30), disputa: { qtd: nret, valor: r2(ret) } };
}

async function segredoFin(): Promise<string> {
  const { data } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("telegram:" + (data?.valor ?? "")));
  return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function autorizado(req: Request): Promise<boolean> {
  const ft = req.headers.get("x-fin-token");
  if (ft) return ft === await segredoFin();
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: u, error } = await supabase.auth.getUser(jwt);
  return !error && !!u?.user && PERMITIDOS.has(u.user.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso ao Financeiro." }, 403);
  try {
    const corpo: any = await req.json().catch(() => ({}));
    if (!corpo.force) {
      const { data: c } = await supabase.from("financeiro_cache").select("valor, atualizado_em").eq("chave", "recebimentos").maybeSingle();
      if (c && Date.now() - new Date(c.atualizado_em).getTime() < 10 * 60_000) return resp({ ...(c.valor as any), do_cache: true });
    }
    const { data: bruto } = await supabase.from("lojas").select("id, nome, apelido, marketplace").eq("ativa", true).order("nome");
    const lojas = (bruto ?? []).map((l: any) => ({ id: l.id, nome: l.apelido || l.nome, marketplace: l.marketplace }));
    const de = (m: string) => lojas.filter((l: any) => l.marketplace === m);
    const falha = (l: any, e: unknown) => ({ id: l.id, nome: l.nome, erro: (e as Error).message.slice(0, 200) });
    const [ml, sp, tt] = await Promise.all([
      Promise.all(de("mercado_livre").map((l: any) => lerLoja(l).catch((e) => falha(l, e)))),
      Promise.all(de("shopee").map((l: any) => lerShopee(l).catch((e) => falha(l, e)))),
      Promise.all(de("tiktok_shop").map((l: any) => lerTikTok(l).catch((e) => falha(l, e)))),
    ]);
    const saida = { ok: true, gerado_em: new Date().toISOString(), mercado_livre: ml, shopee: sp, tiktok: tt };
    await supabase.from("financeiro_cache").upsert({ chave: "recebimentos", valor: saida, atualizado_em: new Date().toISOString() }, { onConflict: "chave" });
    return resp(saida);
  } catch (e) {
    console.error("financeiro-recebimentos", (e as Error).message);
    return resp({ ok: false, erro: "Falha inesperada." }, 500);
  }
});
