// Conferência diária (somente leitura nos marketplaces): relê no ML os casos encerrados/enviados E os abertos, relê os abertos da Shopee (e os já encerrados aqui que ainda constam "Em andamento na Shopee"), marca pendências e avisa no Telegram.
// Modo consulta ({"dry":true,"status":[...]}): não grava nada, devolve o estado real de cada caso no ML (para vistoria).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { tokenML as tokenMLCompartilhado } from "../_shared/ml.ts";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ML = "https://api.mercadolibre.com";
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tokenML = (lojaId: string) => tokenMLCompartilhado(admin, lojaId);
const acoes = (c: any): string[] => { const l: string[] = []; for (const p of c?.players ?? []) if (p?.role === "respondent" || p?.type === "seller") for (const a of p?.available_actions ?? []) l.push(String(a?.action)); return l; };
const acoesComPrazo = (c: any): string[] => { const l: string[] = []; for (const p of c?.players ?? []) if (p?.role === "respondent" || p?.type === "seller") for (const a of p?.available_actions ?? []) l.push(`${a?.action}@${String(a?.due_date ?? "").slice(0, 10)}`); return l; };
const n = async (q: any) => (await q).count ?? 0;

// ---- Shopee (somente leitura) ----
const SP_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970", SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "", SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function credSp(lojaId: string) {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const shopId = String((cred?.dados_extras as any)?.shop_id ?? "");
  if (!cred || !shopId) return null;
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 300_000;
  if (valido(cred)) return { token: cred.token_acesso, shopId };
  if (!cred.token_renovacao) return null;
  const ts = Math.floor(Date.now() / 1000), path = "/api/v2/auth/access_token/get";
  const sign = await hmac(SP_KEY, `${SP_ID}${path}${ts}`);
  const r = await fetch(`${SP_HOST}${path}?` + new URLSearchParams({ partner_id: SP_ID, timestamp: String(ts), sign }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: cred.token_renovacao, shop_id: Number(shopId), partner_id: Number(SP_ID) }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok && !t.error && t.access_token) {
    await admin.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  }
  const { data: o } = await ler(); return valido(o) ? { token: o!.token_acesso, shopId } : null;
}
async function statusSp(c: any, returnSn: string): Promise<string | null> {
  const path = "/api/v2/returns/get_return_detail", ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_ID}${path}${ts}${c.token}${c.shopId}`);
  const r = await fetch(`${SP_HOST}${path}?${new URLSearchParams({ return_sn: returnSn, partner_id: SP_ID, timestamp: String(ts), access_token: c.token, shop_id: c.shopId, sign })}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j: any = await r.json().catch(() => ({}));
  return j.error ? null : String(j.response?.status ?? "") || null;
}
const ABERTOS = ["NOVO", "AGUARDANDO_ANALISE", "AGUARDANDO_PROVAS", "PREPARADO", "RECURSO_DISPONIVEL", "COMPLEMENTACAO", "EM_ANALISE"];

// Consulta sem gravar: estado real de cada caso no ML.
async function consulta(corpo: any) {
  const sts: string[] = Array.isArray(corpo.status) && corpo.status.length ? corpo.status : ["DECIDIDO"];
  let q = admin.from("devol_casos").select("id, loja_id, solicitacao_id, status, situacao_mkt, etapa_fisica, prazo_em, arquivado_em, lojas!inner(marketplace)").eq("lojas.marketplace", "mercado_livre").in("status", sts).order("criado_em", { ascending: false }).limit(Number(corpo.limite ?? 40));
  if (corpo.arquivados !== true) q = q.is("arquivado_em", null);
  const { data: casos } = await q;
  const tokens: Record<string, string | null> = {};
  const linhas: any[] = [];
  for (const c of casos ?? []) {
    if (!(c.loja_id in tokens)) tokens[c.loja_id] = await tokenML(c.loja_id);
    const tk = tokens[c.loja_id]; if (!tk) continue;
    const r = await fetch(`${ML}/post-purchase/v1/claims/${c.solicitacao_id}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r || !r.ok) { linhas.push({ id: c.id, sol: c.solicitacao_id, erro: r?.status ?? "rede" }); continue; }
    const j: any = await r.json().catch(() => ({}));
    let ret: any = null;
    if (corpo.retorno) { const rr = await fetch(`${ML}/post-purchase/v2/claims/${c.solicitacao_id}/returns`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null); if (rr?.ok) { const x: any = await rr.json().catch(() => ({})); ret = { status: x?.status, ships: (x?.shipments ?? []).map((s: any) => `${s?.type}:${s?.status}`) }; } else ret = { http: rr?.status ?? "rede" }; }
    linhas.push({ id: c.id, sol: c.solicitacao_id, local: c.status, fis: c.etapa_fisica, st: j?.status, stage: j?.stage, tipo: j?.type, por: j?.resolution?.closed_by, motivo: j?.resolution?.reason, acoes: acoesComPrazo(j), ret });
  }
  return { total: linhas.length, linhas };
}

async function rodar() {
  const { data: casos } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, pedido, status, prazo_em, enviado_mkt_em, lojas!inner(marketplace, apelido)").eq("lojas.marketplace", "mercado_livre").is("arquivado_em", null).in("status", ["ENCERRADO", "CONCILIADO", "ENVIADO", ...ABERTOS]).limit(400);
  const tokens: Record<string, string | null> = {};
  const pend: any[] = []; const resolvidos: any[] = []; let lidos = 0, falhas = 0, lidosSp = 0;
  for (const c of casos ?? []) {
    if (!(c.loja_id in tokens)) tokens[c.loja_id] = await tokenML(c.loja_id);
    const tk = tokens[c.loja_id]; if (!tk) { falhas++; continue; }
    const r = await fetch(`${ML}/post-purchase/v1/claims/${c.solicitacao_id}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r || !r.ok) { falhas++; continue; }
    const j: any = await r.json().catch(() => ({})); lidos++;
    const ac = acoes(j);
    const aberto = ABERTOS.includes(c.status);
    const fechadoMed = String(j?.status ?? "") === "closed" && String(j?.resolution?.closed_by ?? "") === "mediator";
    const pendente = !aberto && ac.includes("return_review_ok") && !c.enviado_mkt_em && c.status !== "ENVIADO";
    const upd: any = { acoes_loja: ac, pendente_mkt: pendente, mkt_conferido_em: new Date().toISOString() };
    if (aberto && fechadoMed) { upd.situacao_mkt = "Fechada pelo Mercado Livre (mediador)"; resolvidos.push({ ...c, nota: "fechado pelo mediador" }); }
    await admin.from("devol_casos").update(upd).eq("id", c.id);
    if (pendente) pend.push(c);
  }
  // Shopee: relê o estado de cada devolução aberta
  const { data: casosSp } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, pedido, status, lojas!inner(marketplace, apelido)").eq("lojas.marketplace", "shopee").is("arquivado_em", null).or("status.in.(" + ABERTOS.join(",") + "),and(status.in.(ENCERRADO,CONCILIADO,DECIDIDO),situacao_mkt.eq.\"Em andamento na Shopee\")").limit(200);
  const credsSp: Record<string, any> = {};
  for (const c of casosSp ?? []) {
    if (!(c.loja_id in credsSp)) credsSp[c.loja_id] = await credSp(c.loja_id);
    const cr = credsSp[c.loja_id]; if (!cr) { falhas++; continue; }
    const st = await statusSp(cr, String(c.solicitacao_id)); if (!st) { falhas++; continue; }
    lidosSp++;
    const upd: any = { tipo_origem: st, mkt_conferido_em: new Date().toISOString() };
    const aberto = ABERTOS.includes(c.status);
    if (st === "ACCEPTED") { upd.situacao_mkt = "Aceita na Shopee"; if (aberto) resolvidos.push({ ...c, nota: "já aceita na Shopee" }); }
    else if (["CLOSED", "CANCELLED"].includes(st)) { upd.situacao_mkt = "Encerrada na Shopee"; if (aberto) resolvidos.push({ ...c, nota: "encerrada na Shopee" }); }
    await admin.from("devol_casos").update(upd).eq("id", c.id);
  }
  const h24 = new Date(Date.now() + 24 * 3600_000).toISOString();
  const abertosUrgentes = await n(admin.from("devol_casos").select("id", { count: "exact", head: true }).in("status", ["NOVO", "AGUARDANDO_PROVAS", "EM_ANALISE", "PREPARADO"]).is("arquivado_em", null).lte("prazo_em", h24).gte("prazo_em", new Date().toISOString()));
  const vencidos = await n(admin.from("devol_casos").select("id", { count: "exact", head: true }).in("status", ["NOVO", "AGUARDANDO_PROVAS", "EM_ANALISE", "PREPARADO"]).is("arquivado_em", null).lt("prazo_em", new Date().toISOString()));
  const { data: sync } = await admin.from("devol_casos").select("atualizado_em").order("atualizado_em", { ascending: false }).limit(1);
  const linhas = ["📋 <b>DEVOLUÇÕES · CONFERÊNCIA DIÁRIA</b>", "",
    `ML relidos: ${lidos} · Shopee relidos: ${lidosSp}${falhas ? ` (falhas: ${falhas})` : ""}`,
    resolvidos.length ? `🔄 <b>${resolvidos.length} abertos aqui que o marketplace já resolveu (confira e encerre):</b>` : "✅ Nenhum caso aberto aqui já resolvido no marketplace",
    ...resolvidos.slice(0, 15).map((c: any) => `• ${esc(c.lojas.apelido)} · ${esc(c.pedido)} · ${esc(c.nota)}`),
    pend.length ? `⚠️ <b>${pend.length} encerrados só no hub, mas o ML ainda espera a loja:</b>` : "✅ Nenhum caso encerrado só no hub com pendência no ML",
    ...pend.slice(0, 15).map((c: any) => `• ${esc(c.lojas.apelido)} · ${esc(c.pedido)}`),
    "", `Prazos nas próximas 24 h (abertos): ${abertosUrgentes}`, vencidos ? `⚠️ Abertos com prazo vencido: ${vencidos}` : "Abertos com prazo vencido: 0",
    sync?.[0]?.atualizado_em ? `Última atualização de qualquer caso: ${new Date(sync[0].atualizado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : null];
  const { data: liga } = await admin.from("devol_config").select("valor").eq("chave", "telegram_devolucoes").maybeSingle();
  if (liga?.valor !== "true") return { lidos, lidosSp, falhas, pendentes: pend.length, resolvidos: resolvidos.length, abertosUrgentes, vencidos, telegram: "desligado" };
  const { data: cfg } = await admin.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
  const tok = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (cfg?.valor && tok) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: cfg.valor, text: linhas.filter((l) => l !== null).join("\n"), parse_mode: "HTML" }) }).catch(() => null);
  return { lidos, lidosSp, falhas, pendentes: pend.length, resolvidos: resolvidos.length, abertosUrgentes, vencidos };
}

Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return J({ ok: false }, 401);
  const corpo: any = await req.json().catch(() => ({}));
  try { return J({ ok: true, ...(corpo.dry ? await consulta(corpo) : await rodar()) }); } catch (e) { return J({ ok: false, erro: String(e).slice(0, 200) }, 500); }
});
