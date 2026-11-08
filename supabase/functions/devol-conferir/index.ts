// Conferência diária (somente leitura nos marketplaces): relê no ML os casos encerrados/enviados, marca pendências e avisa no Telegram.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ML = "https://api.mercadolibre.com", ML_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040", ML_SEC = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  const ok = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  if (c && ok(c)) return c.token_acesso;
  if (!c?.token_renovacao) return null;
  const r = await fetch(`${ML}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_ID, client_secret: ML_SEC, refresh_token: c.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) { await admin.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId); return t.access_token; }
  const { data: o } = await ler(); return ok(o) ? o!.token_acesso : null;
}
const acoes = (c: any): string[] => { const l: string[] = []; for (const p of c?.players ?? []) if (p?.role === "respondent" || p?.type === "seller") for (const a of p?.available_actions ?? []) l.push(String(a?.action)); return l; };
const n = async (q: any) => (await q).count ?? 0;

async function rodar() {
  const { data: casos } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, pedido, status, prazo_em, enviado_mkt_em, lojas!inner(marketplace, apelido)").eq("lojas.marketplace", "mercado_livre").is("arquivado_em", null).in("status", ["ENCERRADO", "CONCILIADO", "ENVIADO"]).limit(200);
  const tokens: Record<string, string | null> = {};
  const pend: any[] = []; let lidos = 0, falhas = 0;
  for (const c of casos ?? []) {
    if (!(c.loja_id in tokens)) tokens[c.loja_id] = await tokenML(c.loja_id);
    const tk = tokens[c.loja_id]; if (!tk) { falhas++; continue; }
    const r = await fetch(`${ML}/post-purchase/v1/claims/${c.solicitacao_id}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r || !r.ok) { falhas++; continue; }
    const j: any = await r.json().catch(() => ({})); lidos++;
    const ac = acoes(j);
    const pendente = ac.includes("return_review_ok") && !c.enviado_mkt_em && c.status !== "ENVIADO";
    await admin.from("devol_casos").update({ acoes_loja: ac, pendente_mkt: pendente, mkt_conferido_em: new Date().toISOString() }).eq("id", c.id);
    if (pendente) pend.push(c);
  }
  const h24 = new Date(Date.now() + 24 * 3600_000).toISOString();
  const abertosUrgentes = await n(admin.from("devol_casos").select("id", { count: "exact", head: true }).in("status", ["NOVO", "AGUARDANDO_PROVAS", "EM_ANALISE", "PREPARADO"]).is("arquivado_em", null).lte("prazo_em", h24).gte("prazo_em", new Date().toISOString()));
  const vencidos = await n(admin.from("devol_casos").select("id", { count: "exact", head: true }).in("status", ["NOVO", "AGUARDANDO_PROVAS", "EM_ANALISE", "PREPARADO"]).is("arquivado_em", null).lt("prazo_em", new Date().toISOString()));
  const { data: sync } = await admin.from("devol_casos").select("atualizado_em").order("atualizado_em", { ascending: false }).limit(1);
  const linhas = ["📋 <b>DEVOLUÇÕES · CONFERÊNCIA DIÁRIA</b>", "",
    `ML relidos: ${lidos}${falhas ? ` (falhas: ${falhas})` : ""}`,
    pend.length ? `⚠️ <b>${pend.length} encerrados só no hub, mas o ML ainda espera a loja:</b>` : "✅ Nenhum caso encerrado só no hub com pendência no ML",
    ...pend.slice(0, 15).map((c: any) => `• ${esc(c.lojas.apelido)} · ${esc(c.pedido)}`),
    "", `Prazos nas próximas 24 h (abertos): ${abertosUrgentes}`, vencidos ? `⚠️ Abertos com prazo vencido: ${vencidos}` : "Abertos com prazo vencido: 0",
    sync?.[0]?.atualizado_em ? `Última atualização de qualquer caso: ${new Date(sync[0].atualizado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : null];
  const { data: cfg } = await admin.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
  const tok = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (cfg?.valor && tok) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: cfg.valor, text: linhas.filter((l) => l !== null).join("\n"), parse_mode: "HTML" }) }).catch(() => null);
  return { lidos, falhas, pendentes: pend.length, abertosUrgentes, vencidos };
}

Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return J({ ok: false }, 401);
  try { return J({ ok: true, ...(await rodar()) }); } catch (e) { return J({ ok: false, erro: String(e).slice(0, 200) }, 500); }
});
