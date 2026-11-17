// Devoluções (SOMENTE LEITURA): quando um número digitado não existe nos casos do hub, procura no Mercado Livre
// (Ref ID da etiqueta = número do envio da venda) e diz o que é: pedido, situação do envio e se existe reclamação.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const ML = "https://api.mercadolibre.com";
async function get(p: string, tk: string, extra: Record<string, string> = {}) {
  try {
    const r = await fetch(`${ML}${p}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json", ...extra }, signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json().catch(() => null);
    return { ok: r.ok, j };
  } catch (_) { return { ok: false, j: null }; }
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const usuario = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
    const { data: u } = await usuario.auth.getUser();
    if (!u?.user) return resp({ ok: false, mensagem: "Sessão inválida. Entre de novo." }, 401);
    const { data: acesso } = await usuario.rpc("tem_acesso", { p_app: "devolucoes" });
    if (!acesso) return resp({ ok: false, mensagem: "Sem acesso ao app de devoluções." }, 403);
    const corpo: any = await req.json().catch(() => ({}));
    const num = String(corpo.numero ?? "").replace(/\D/g, "");
    if (num.length < 8) return resp({ ok: true, achou: false });
    const { data: lojas } = await admin.from("lojas").select("id, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
    for (const l of lojas ?? []) {
      const { data: c } = await admin.from("credenciais_lojas").select("token_acesso, expira_em").eq("loja_id", l.id).maybeSingle();
      if (!c?.token_acesso || !c.expira_em || new Date(c.expira_em).getTime() < Date.now()) continue;
      const tk = c.token_acesso;
      let pedido = "", envio: any = null;
      const sh = await get(`/shipments/${num}`, tk, { "x-format-new": "true" });
      if (sh.ok && sh.j?.id) {
        envio = { status: String(sh.j.status ?? ""), substatus: String(sh.j.substatus ?? "") };
        const it = await get(`/shipments/${num}/items`, tk);
        pedido = String(Array.isArray(it.j) ? (it.j[0]?.order_id ?? "") : "");
      } else if (num.startsWith("2000")) {
        const o = await get(`/orders/${num}`, tk);
        if (o.ok && o.j?.id) pedido = String(o.j.id);
      }
      if (!pedido) continue;
      const cl = await get(`/post-purchase/v1/claims/search?resource=order&resource_id=${pedido}`, tk);
      const claims = (cl.j?.data ?? []).map((x: any) => ({ id: String(x.id), status: String(x.status ?? ""), stage: String(x.stage ?? ""), type: String(x.type ?? "") }));
      const { data: caso } = await admin.from("devol_casos").select("id").eq("pedido", pedido).limit(1).maybeSingle();
      return resp({ ok: true, achou: true, loja: l.apelido, pedido, envio, reclamacoes: claims, caso_no_hub: !!caso });
    }
    return resp({ ok: true, achou: false });
  } catch (e) {
    return resp({ ok: false, mensagem: `Erro: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }, 500);
  }
});
