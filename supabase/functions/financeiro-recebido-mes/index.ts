// Financeiro: calcula quanto cada loja RECEBEU (dinheiro liberado) no mês e guarda em financeiro_hist_coleta (só leitura nos marketplaces).
// Roda de tempos em tempos para o mês atual e o anterior. Params opcionais: mes "AAAA-MM". Acesso: token do Financeiro (x-fin-token).
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
const TT_PADRAO = "6lo1ttda2b1bf";
const ttApp = (k: string) => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sg = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sg)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function segredoFin(): Promise<string> {
  const { data } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("telegram:" + (data?.valor ?? "")));
  return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
const msSP = (d: string) => Date.parse(d + "T00:00:00-03:00");
const proxMes = (mes: string) => { const [a, m] = mes.split("-").map(Number); return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`; };
const iso = (ms: number) => new Date(ms).toISOString();
async function mlToken(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) { const { data: o } = await ler(); return valido(o) ? o!.token_acesso : null; }
  await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
  return t.access_token;
}
async function mpBusca(token: string, params: Record<string, string>): Promise<any[]> {
  const todos: any[] = [];
  for (let off = 0; off < 8000; off += 1000) {
    const qs = new URLSearchParams({ ...params, limit: "1000", offset: String(off) });
    const r = await fetch(`${MP}/v1/payments/search?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`MP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const l: any[] = j.results ?? [];
    todos.push(...l);
    if (l.length < 1000 || off + 1000 >= Number(j.paging?.total ?? 0)) break;
  }
  return todos;
}
async function recML(loja: any, mes: string) {
  const t = await mlToken(loja.id); if (!t) throw new Error("conexao");
  const a = msSP(mes + "-01"), b = msSP(proxMes(mes));
  const lib = (await mpBusca(t, { sort: "money_release_date", criteria: "asc", range: "money_release_date", begin_date: iso(a), end_date: iso(Math.min(b, Date.now()) - 1), status: "approved" })).filter((p) => p.order?.type === "mercadolibre" && p.money_release_status === "released");
  let rec = 0; for (const p of lib) rec += num(p.transaction_details?.net_received_amount);
  return { recebido: r2(rec), recebido_n: lib.length };
}
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
async function recSP(loja: any, mes: string) {
  const k = await spCred(loja.id); if (!k) throw new Error("conexao");
  const aS = msSP(mes + "-01") / 1000, bS = Math.min(msSP(proxMes(mes)) / 1000, Math.floor(Date.now() / 1000));
  let rec = 0, n = 0;
  for (let x = aS; x < bS; x += 14 * 86400) {
    const y = Math.min(x + 14 * 86400, bS);
    for (let pg = 1; pg < 60; pg++) {
      const r = await spGet("/api/v2/payment/get_escrow_list", k, { release_time_from: String(x), release_time_to: String(y - 1), page_size: "100", page_no: String(pg) });
      for (const e of r.escrow_list ?? []) { rec += num(e.payout_amount); n++; }
      if (!r.more) break;
    }
  }
  return { recebido: r2(rec), recebido_n: n };
}
async function ttCred(lojaId: string) {
  const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  if (!c) return null;
  const app = ttApp((c.dados_extras as any)?.app_key ?? TT_PADRAO), cipher = (c.dados_extras as any)?.shop_cipher;
  if (!cipher) return null;
  return { token: c.token_acesso, cipher, app };
}
async function ttGet(path: string, c: any, params: Record<string, string>) {
  for (let t = 0; t < 6; t++) {
    const q: Record<string, string> = { ...params, app_key: c.app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher };
    q.sign = await hmac(c.app.s, c.app.s + path + Object.keys(q).sort().map((k) => k + q[k]).join("") + c.app.s);
    const r = await fetch(`${TT_API}${path}?${new URLSearchParams(q)}`, { headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" } });
    const j: any = await r.json().catch(() => ({}));
    if (String(j.code) === "36009002" && t < 5) { await new Promise((ok) => setTimeout(ok, 1500 * (t + 1))); continue; }
    if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${path}: ${j.code ?? r.status} ${String(j.message ?? "").slice(0, 160)}`);
    return j.data ?? {};
  }
  return {};
}
async function recTT(loja: any, mes: string) {
  const k = await ttCred(loja.id); if (!k) throw new Error("conexao");
  const a = msSP(mes + "-01") / 1000, b = msSP(proxMes(mes)) / 1000;
  const sts: any[] = []; let tok = "";
  for (let pg = 0; pg < 20; pg++) {
    const p: Record<string, string> = { page_size: "100", sort_field: "statement_time", statement_time_ge: String(a - 10 * 86400), statement_time_lt: String(b + 5 * 86400) };
    if (tok) p.page_token = tok;
    const r = await ttGet("/finance/202309/statements", k, p);
    sts.push(...(r.statements ?? []));
    if (!r.next_page_token) break; tok = r.next_page_token;
  }
  let rec = 0, n = 0;
  for (const s of sts) { const pt = num(s.payment_time); if (pt >= a && pt < b && s.payment_status === "PAID") { rec += num(s.settlement_amount); n++; } }
  return { recebido: r2(rec), recebido_n: n };
}
Deno.serve(async (req) => {
  const ft = req.headers.get("x-fin-token"); if (!ft || ft !== await segredoFin()) return resp({ ok: false, erro: "sem acesso" }, 403);
  try {
    const c: any = await req.json().catch(() => ({}));
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
    const ant = (() => { const [a, m] = hoje.split("-").map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`; })();
    const meses: string[] = c.mes ? [c.mes] : [hoje, ant];
    const { data: lojas } = await supabase.from("lojas").select("id, apelido, marketplace").eq("ativa", true).in("marketplace", ["mercado_livre", "shopee", "tiktok_shop"]);
    const out: any[] = [];
    for (const mes of meses) {
      for (const l of lojas ?? []) {
        const mp = l.marketplace === "mercado_livre" ? "ml" : l.marketplace === "shopee" ? "sp" : "tt";
        try {
          const r = mp === "ml" ? await recML(l, mes) : mp === "sp" ? await recSP(l, mes) : await recTT(l, mes);
          // preserva o que já existe na linha (ex.: vendas do histórico) e só troca o recebido
          const { data: ex } = await supabase.from("financeiro_hist_coleta").select("dados").eq("mes", mes).eq("mp", mp).eq("loja", l.apelido).eq("parte", 0).maybeSingle();
          await supabase.from("financeiro_hist_coleta").upsert({ mes, mp, loja: l.apelido, parte: 0, dados: { ...(ex?.dados ?? {}), ...r }, coletado_em: new Date().toISOString() });
          out.push({ mes, loja: l.apelido, ...r });
        } catch (e) { out.push({ mes, loja: l.apelido, erro: (e as Error).message.slice(0, 120) }); }
      }
    }
    return resp({ ok: true, out });
  } catch (e) { return resp({ ok: false, erro: (e as Error).message }, 500); }
});
