// Aceite em lote no Mercado Livre, autorizado pelo dono no chat. Só roda com devol_config.aceite_lote_autorizado = 'true' (ligado e desligado à mão).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ML = "https://api.mercadolibre.com", ML_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040", ML_SEC = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
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
Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return J({ ok: false, m: "não autorizado" }, 401);
  const { data: cf } = await admin.from("devol_config").select("chave, valor");
  const conf: Record<string, string> = {}; for (const x of cf ?? []) conf[x.chave] = String(x.valor ?? "");
  if (conf.aceite_lote_autorizado !== "true") return J({ ok: false, m: "aceite em lote não autorizado" }, 423);
  if (conf.kill_switch === "true" || conf.envio_real !== "true") return J({ ok: false, m: "envio real desligado" }, 423);
  const corpo: any = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(corpo.casos) ? corpo.casos : [];
  const out: any[] = [];
  for (const id of ids) {
    const { data: caso } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, status, pedido").eq("id", id).maybeSingle();
    if (!caso) { out.push({ id, r: "não achei" }); continue; }
    const { data: loja } = await admin.from("lojas").select("marketplace").eq("id", caso.loja_id).maybeSingle();
    if (loja?.marketplace !== "mercado_livre" || caso.status !== "ENCERRADO") { out.push({ pedido: caso.pedido, r: "fora da regra" }); continue; }
    const { data: ja } = await admin.from("devol_eventos").select("id").eq("caso_id", id).in("tipo", ["contestacao_enviada", "devolucao_aceita"]).limit(1);
    if (ja?.length) { out.push({ pedido: caso.pedido, r: "já enviado" }); continue; }
    const tk = await tokenML(caso.loja_id); if (!tk) { out.push({ pedido: caso.pedido, r: "sem token" }); continue; }
    const H = { Authorization: `Bearer ${tk}`, Accept: "application/json" };
    const c = await (await fetch(`${ML}/post-purchase/v1/claims/${caso.solicitacao_id}`, { headers: H })).json().catch(() => ({}));
    if (!acoes(c).includes("return_review_ok")) { out.push({ pedido: caso.pedido, r: "ML não oferece mais a ação" }); continue; }
    const r = await fetch(`${ML}/post-purchase/v1/claims/${caso.solicitacao_id}/actions/return-review-ok`, { method: "POST", headers: H });
    const txt = await r.text();
    await admin.from("devol_eventos").insert({ caso_id: id, tipo: r.ok ? "devolucao_aceita" : "contestacao_erro", evento_chave: `aceite_lote:${id}:${Date.now()}`, dados: { acao: "aceitar", origem: "aceite_lote_autorizado_no_chat", http: r.status, resposta: r.ok ? "ok" : txt.slice(0, 200) } });
    out.push({ pedido: caso.pedido, r: r.ok ? "aceito" : `erro ${r.status} ${txt.slice(0, 120)}` });
  }
  return J({ ok: true, out });
});
