// Gestor de Ads > coleta o dado bruto dos anúncios (nada estimado) e guarda para sempre.
// ML (Product Ads): total do dia por loja, somado por ANÚNCIO (inclui campanhas excluídas, igual ao painel do ML).
// Shopee (CPC): total do dia por loja, por campanha e pedidos criados por dia.
// Quem chama: agendador do banco (x-fin-token) ou pessoa logada com acesso (Paulo e Lucas).
// Corpo (tudo opcional): { dias: 7, de: "2026-10-26", ate: "2026-11-16", nivel: ["loja","campanha","pedidos"], mkt: "ml"|"shopee", loja: "parte do apelido" }
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
  if (!r.ok) throw new Error(`ML ${r.status} ${caminho.slice(0, 80)}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}
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
  if (!r.ok || j.error) throw new Error(`Shopee ${r.status} ${path.slice(-45)}: ${j.error ?? ""} ${String(j.message ?? "").slice(0, 160)}`);
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
const hojeSP = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const dmyParaIso = (d: string) => /^\d{2}-\d{2}-\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : "";
const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = (v: any) => { const n = num(v); return n === null ? null : Math.round(n * 100) / 100; };
const agora = () => new Date().toISOString();
async function gravar(tabela: string, linhas: any[], conflito: string) {
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await supabase.from(tabela).upsert(linhas.slice(i, i + 500), { onConflict: conflito });
    if (error) throw new Error(`${tabela}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso." }, 403);
  const corpo: any = await req.json().catch(() => ({}));
  const fim = String(corpo.ate ?? hojeSP());
  const ini = String(corpo.de ?? somaDias(fim, -(Math.min(Math.max(Number(corpo.dias ?? 7), 1), 200) - 1)));
  const niveis: string[] = Array.isArray(corpo.nivel) ? corpo.nivel : ["loja", "campanha", "pedidos"];
  const filtroLoja = corpo.loja ? String(corpo.loja).toLowerCase() : "";
  const saida: any[] = [];

  // ---------- Mercado Livre: total do dia por loja ----------
  // Fonte: resumo por ANÚNCIO (ads/search com metrics_summary), um dia por consulta. Ele inclui o gasto de campanhas
  // excluídas e fecha com o painel do ML; o total por campanha deixa essas campanhas de fora.
  if (corpo.mkt !== "shopee" && niveis.includes("loja")) {
    const { data: lojas } = await supabase.from("lojas").select("id, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
    for (const l of (lojas ?? []).filter((x: any) => !filtroLoja || x.apelido.toLowerCase().includes(filtroLoja))) {
      try {
        const token = await tokenDaLoja(l.id);
        if (!token) { saida.push({ mkt: "ml", loja: l.apelido, erro: "conexão precisa ser refeita" }); continue; }
        const adv = await ml("/advertising/advertisers?product_id=PADS", token, "1");
        const id = adv?.advertisers?.[0]?.advertiser_id;
        if (!id) { saida.push({ mkt: "ml", loja: l.apelido, erro: "sem conta de anúncios" }); continue; }
        const iniMl = ini < somaDias(fim, -89) ? somaDias(fim, -89) : ini;
        const dias: string[] = [];
        for (let d = iniMl; d <= fim; d = somaDias(d, 1)) dias.push(d);
        const linhas: any[] = [];
        const falhas: string[] = [];
        const resumoDia = async (d: string) => {
          const base = `/advertising/MLB/advertisers/${id}/product_ads/ads/search?date_from=${d}&date_to=${d}&metrics_summary=true&limit=1&metrics=`;
          let m: any;
          try { m = await ml(base + "cost,clicks,prints,direct_amount,total_amount,units_quantity,organic_units_quantity", token, "2"); }
          catch (_) {
            try { m = await ml(base + "cost,clicks,direct_amount,total_amount,units_quantity", token, "2"); }
            catch (e) { falhas.push(`${d}: ${(e as Error).message.slice(0, 80)}`); return; }
          }
          const s = m?.metrics_summary;
          if (!s || num(s.cost) === null) return;
          linhas.push({ loja_id: l.id, dia: d, gasto: r2(s.cost), impressoes: num(s.prints), cliques: num(s.clicks), receita_mkt: r2(s.total_amount), receita_direta: r2(s.direct_amount), unidades_mkt: num(s.units_quantity), unidades_organicas: num(s.organic_units_quantity), atualizado_em: agora() });
        };
        for (let i = 0; i < dias.length; i += 8) await Promise.all(dias.slice(i, i + 8).map(resumoDia));
        await gravar("ads_loja_dia", linhas, "loja_id,dia");
        const it: any = { mkt: "ml", loja: l.apelido, dias: linhas.length, gasto: Math.round(linhas.reduce((s: number, r: any) => s + (r.gasto ?? 0), 0) * 100) / 100 };
        if (falhas.length) it.falhas = falhas.slice(0, 5);
        saida.push(it);
      } catch (e) { saida.push({ mkt: "ml", loja: l.apelido, erro: (e as Error).message.slice(0, 250) }); }
    }
  }

  // ---------- Shopee ----------
  if (corpo.mkt !== "ml") {
    const { data: lojas } = await supabase.from("lojas").select("id, apelido").eq("marketplace", "shopee").eq("ativa", true);
    for (const l of (lojas ?? []).filter((x: any) => !filtroLoja || x.apelido.toLowerCase().includes(filtroLoja))) {
      const item: any = { mkt: "shopee", loja: l.apelido };
      try {
        const c = await spCredenciais(l.id);
        if (!c) { saida.push({ ...item, erro: "conexão precisa ser refeita" }); continue; }
        // a Shopee guarda 6 meses de anúncios
        const iniSp = ini < somaDias(fim, -179) ? somaDias(fim, -179) : ini;

        if (niveis.includes("loja")) {
          const linhas: any[] = [];
          for (let fimJ = fim; fimJ >= iniSp; fimJ = somaDias(fimJ, -30)) {
            const iniJ = somaDias(fimJ, -29) < iniSp ? iniSp : somaDias(fimJ, -29);
            const r = await spChamar("/api/v2/ads/get_all_cpc_ads_daily_performance", c.token, c.shopId, { start_date: dmy(iniJ), end_date: dmy(fimJ) });
            for (const x of (Array.isArray(r) ? r : [])) {
              const d = dmyParaIso(String(x.date)); if (!d || num(x.expense) === null) continue;
              linhas.push({ loja_id: l.id, dia: d, gasto: r2(x.expense), impressoes: num(x.impression), cliques: num(x.clicks), receita_mkt: r2(x.broad_gmv), receita_direta: r2(x.direct_gmv), pedidos_mkt: num(x.broad_order), unidades_mkt: num(x.broad_item_sold), atualizado_em: agora() });
            }
          }
          await gravar("ads_loja_dia", linhas, "loja_id,dia");
          item.loja_dias = linhas.length; item.gasto = Math.round(linhas.reduce((s, r) => s + (r.gasto ?? 0), 0) * 100) / 100;
        }

        if (niveis.includes("campanha")) {
          let ids: string[] = [];
          let offset = 0;
          for (let g = 0; g < 10; g++) {
            const lista = await spChamar("/api/v2/ads/get_product_level_campaign_id_list", c.token, c.shopId, offset ? { ad_type: "all", offset: String(offset) } : { ad_type: "all" });
            const parte = (lista.campaign_list ?? []).map((x: any) => String(x.campaign_id)).filter(Boolean);
            ids = ids.concat(parte);
            if (!lista.has_next_page || !parte.length) break;
            offset += parte.length;
          }
          ids = [...new Set(ids)];
          const linhas: any[] = [];
          let semId = 0;
          for (let fimJ = fim; fimJ >= iniSp; fimJ = somaDias(fimJ, -30)) {
            const iniJ = somaDias(fimJ, -29) < iniSp ? iniSp : somaDias(fimJ, -29);
            for (let i = 0; i < ids.length; i += 20) {
              const r = await spChamar("/api/v2/ads/get_product_campaign_daily_performance", c.token, c.shopId, { start_date: dmy(iniJ), end_date: dmy(fimJ), campaign_id_list: ids.slice(i, i + 20).join(",") });
              for (const camp of (r.campaign_list ?? [])) {
                const cid = String(camp.campaign_id ?? camp.campaign?.campaign_id ?? "");
                if (!cid || cid === "undefined") { semId++; continue; }
                for (const x of (camp.metrics_list ?? [])) {
                  const d = dmyParaIso(String(x.date)); if (!d) continue;
                  if (!num(x.expense) && !num(x.impression) && !num(x.clicks)) continue;
                  linhas.push({ loja_id: l.id, dia: d, campanha_id: cid, gasto: r2(x.expense) ?? 0, impressoes: num(x.impression), cliques: num(x.clicks), receita_mkt: r2(x.broad_gmv), receita_direta: r2(x.direct_gmv), pedidos_mkt: num(x.broad_order), atualizado_em: agora() });
                }
              }
            }
          }
          await gravar("ads_campanha_dia", linhas, "loja_id,dia,campanha_id");
          item.campanhas = ids.length; item.campanha_dias = linhas.length; if (semId) item.campanhas_sem_id = semId;
          item.gasto_campanhas = Math.round(linhas.reduce((s, r) => s + (r.gasto ?? 0), 0) * 100) / 100;
        }

        if (niveis.includes("pedidos")) {
          // pedidos criados por dia (inclui cancelados e não pagos); só faz sentido a partir do 1º pedido guardado no banco
          const { data: p0 } = await supabase.from("lucro_pedidos").select("dia").eq("loja_id", l.id).order("dia", { ascending: true }).limit(1).maybeSingle();
          const iniPed = p0?.dia && p0.dia > ini ? p0.dia : ini;
          const linhas: any[] = [];
          for (let dia = iniPed; dia <= fim; dia = somaDias(dia, 1)) {
            const de = Math.floor(Date.parse(`${dia}T00:00:00-03:00`) / 1000), ate = de + 86399;
            const porStatus: Record<string, number> = {};
            let cursor = "", mais = true, guarda = 0;
            while (mais && guarda++ < 30) {
              const params: Record<string, string> = { time_range_field: "create_time", time_from: String(de), time_to: String(ate), page_size: "100", response_optional_fields: "order_status" };
              if (cursor) params.cursor = cursor;
              const r = await spChamar("/api/v2/order/get_order_list", c.token, c.shopId, params);
              for (const o of (r.order_list ?? [])) { const s = String(o.order_status ?? "sem_status"); porStatus[s] = (porStatus[s] ?? 0) + 1; }
              mais = !!r.more; cursor = r.next_cursor ?? "";
            }
            const criados = Object.values(porStatus).reduce((s, n) => s + n, 0);
            linhas.push({ loja_id: l.id, dia, criados, cancelados: porStatus["CANCELLED"] ?? 0, por_status: porStatus, atualizado_em: agora() });
          }
          await gravar("ads_pedidos_criados_dia", linhas, "loja_id,dia");
          item.pedidos_dias = linhas.length; item.pedidos_criados = linhas.reduce((s, r) => s + r.criados, 0);
        }
        saida.push(item);
      } catch (e) { saida.push({ ...item, erro: (e as Error).message.slice(0, 300) }); }
    }
  }
  return resp({ ok: true, de: ini, ate: fim, niveis, lojas: saida });
});
