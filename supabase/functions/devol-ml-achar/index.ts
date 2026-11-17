// Devoluções (SOMENTE LEITURA no marketplace): procura um número (Ref ID da etiqueta = envio da venda, envio da devolução ou pedido) no Mercado Livre
// e diz o que é: pedido, situação do envio e se existe reclamação.
// Modo da tela: { numero } (usuário logado). Modo rotina: { modo: "varrer" } (token interno): dispensa sozinho os lotes sem caso cujo pacote
// foi só devolvido pela transportadora (sem reclamação) e apaga as fotos deles.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const ML = "https://api.mercadolibre.com";
async function get(p: string, tk: string, extra: Record<string, string> = {}) {
  try {
    const r = await fetch(`${ML}${p}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json", ...extra }, signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json().catch(() => null);
    return { ok: r.ok, j };
  } catch (_) { return { ok: false, j: null }; }
}
let lojasCache: { id: string; apelido: string; tk: string }[] | null = null;
async function lojasML() {
  if (lojasCache) return lojasCache;
  const { data: lojas } = await admin.from("lojas").select("id, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
  const out: { id: string; apelido: string; tk: string }[] = [];
  for (const l of lojas ?? []) {
    const { data: c } = await admin.from("credenciais_lojas").select("token_acesso, expira_em").eq("loja_id", l.id).maybeSingle();
    if (c?.token_acesso && c.expira_em && new Date(c.expira_em).getTime() > Date.now()) out.push({ id: l.id, apelido: l.apelido, tk: c.token_acesso });
  }
  return (lojasCache = out);
}
async function procurar(num: string) {
  for (const l of await lojasML()) {
    const tk = l.tk;
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
    return { achou: true, loja: l.apelido, pedido, envio, reclamacoes: claims, caso_no_hub: !!caso };
  }
  return { achou: false };
}

async function varrer() {
  const res = { analisados: 0, dispensados: 0, fotos_apagadas: 0, com_reclamacao: 0, ligados: 0 };
  const { data: lotes } = await admin.from("devol_recebimentos").select("id, analise_resumo").is("caso_id", null).is("dispensado_em", null).eq("analise", "concluida")
    .gt("criado_em", new Date(Date.now() - 45 * 86_400_000).toISOString()).order("criado_em", { ascending: false }).limit(25);
  for (const r of lotes ?? []) {
    const nums = [...new Set((r.analise_resumo?.etiqueta ?? []).filter((e: any) => e?.tipo !== "nome" && (e?.confianca === "alta" || (e?.tipo === "ref_id" && String(e.valor ?? "").replace(/\D/g, "").length === 11))).map((e: any) => String(e.valor ?? "").replace(/\D/g, "")).filter((n: string) => n.length >= 8 && n.length <= 16))] as string[];
    if (!nums.length) continue;
    res.analisados++;
    const { data: a } = await admin.rpc("devol_achar_caso", { p_numeros: nums, p_nomes: [] });
    if ((a?.[0]?.n ?? 0) > 0) continue; // já existe caso: a ligação automática cuida
    for (const n of nums) {
      const x: any = await procurar(n);
      if (!x.achou) continue;
      if (x.caso_no_hub) {
        // o número era o Ref ID (envio da venda): acha o caso pelo pedido e liga o lote sozinho
        const { error } = await admin.from("devol_recebimentos").update({ pedido_lido: x.pedido, fonte_identificacao: "Ref ID da etiqueta (pedido do envio da venda)", analise: "pendente", analise_erro: null }).eq("id", r.id).is("caso_id", null).neq("analise", "processando");
        if (!error) res.ligados++;
        res.com_reclamacao++; break;
      }
      if (x.reclamacoes.length) { res.com_reclamacao++; break; }
      const devolvido = /returned|not_delivered/.test(`${x.envio?.status ?? ""} ${x.envio?.substatus ?? ""}`);
      if (!devolvido) break;
      await admin.from("devol_recebimentos").update({ dispensado_em: new Date().toISOString(), dispensado_motivo: `Pacote devolvido pela transportadora, sem reclamação (pedido ${x.pedido}, ${x.loja})` }).eq("id", r.id).is("caso_id", null);
      res.dispensados++;
      break;
    }
  }
  // fotos dos lotes dispensados (manual ou automático) saem do armazenamento
  const { data: desp } = await admin.from("devol_recebimentos").select("id").not("dispensado_em", "is", null).limit(40);
  const ids = (desp ?? []).map((d: any) => d.id);
  if (ids.length) {
    const { data: anexos } = await admin.from("devol_anexos").select("id, caminho").in("recebimento_id", ids).neq("estado", "excluido").limit(200);
    if (anexos?.length) {
      const { error } = await admin.storage.from("devol-provas").remove(anexos.flatMap((a: any) => [a.caminho, `${a.caminho}.t.jpg`]));
      if (!error) {
        await admin.from("devol_anexos").update({ estado: "excluido", excluido_em: new Date().toISOString() }).in("id", anexos.map((a: any) => a.id));
        res.fotos_apagadas = anexos.length;
      }
    }
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const corpo: any = await req.json().catch(() => ({}));
    const segredo = req.headers.get("x-lucro-token") ?? "";
    if (segredo) {
      const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
      if (!seg?.valor || seg.valor !== segredo) return resp({ ok: false }, 401);
      if (corpo.modo === "varrer") return resp({ ok: true, ...(await varrer()) });
      return resp({ ok: false }, 400);
    }
    const usuario = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
    const { data: u } = await usuario.auth.getUser();
    if (!u?.user) return resp({ ok: false, mensagem: "Sessão inválida. Entre de novo." }, 401);
    const { data: acesso } = await usuario.rpc("tem_acesso", { p_app: "devolucoes" });
    if (!acesso) return resp({ ok: false, mensagem: "Sem acesso ao app de devoluções." }, 403);
    const num = String(corpo.numero ?? "").replace(/\D/g, "");
    if (num.length < 8) return resp({ ok: true, achou: false });
    return resp({ ok: true, ...(await procurar(num)) });
  } catch (e) {
    return resp({ ok: false, mensagem: `Erro: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }, 500);
  }
});
