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

function dist(a: string, b: string): number {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// guarda em cada caso do ML o envio da venda (= Ref ID da etiqueta), para a comparação por aproximação
async function preencherEnviosVenda() {
  const lojas = await lojasML();
  if (!lojas.length) return 0;
  const { data: casos } = await admin.from("devol_casos").select("id, pedido, loja_id").is("envio_venda_id", null).is("arquivado_em", null).not("pedido", "is", null)
    .in("loja_id", lojas.map((l) => l.id)).gt("criado_em", new Date(Date.now() - 75 * 86_400_000).toISOString()).order("criado_em", { ascending: false }).limit(30);
  let n = 0;
  for (const c of casos ?? []) {
    const tk = lojas.find((l) => l.id === c.loja_id)?.tk; if (!tk) continue;
    const o = await get(`/orders/${String(c.pedido).replace(/\D/g, "")}`, tk);
    const ship = o.ok ? o.j?.shipping?.id : null;
    await admin.from("devol_casos").update({ envio_venda_id: ship ? String(ship) : "-" }).eq("id", c.id);
    n++;
  }
  return n;
}

async function ligarPorAproximacao(r: any, nums: string[]) {
  const { data: casos } = await admin.from("devol_casos").select("id, loja_id, pedido, envio_venda_id, envio_devolucao_id").is("arquivado_em", null)
    .gt("criado_em", new Date(Date.now() - 75 * 86_400_000).toISOString());
  const { data: usados } = await admin.from("devol_recebimentos").select("caso_id").not("caso_id", "is", null);
  const jaTem = new Set((usados ?? []).map((u: any) => u.caso_id));
  const cand: { c: any; d: number; n: string; campo: string }[] = [];
  for (const c of casos ?? []) {
    if (jaTem.has(c.id)) continue;
    let melhor: { d: number; n: string; campo: string } | null = null;
    for (const n of nums) {
      if (n.length < 9 || n.length > 13) continue;
      for (const [campo, alvo] of [["Ref ID", c.envio_venda_id], ["rastreio", c.envio_devolucao_id]] as [string, string | null][]) {
        if (!alvo || alvo === "-" || alvo.length < 9) continue;
        const d = dist(n, alvo);
        if (d > 0 && d <= 2 && (!melhor || d < melhor.d)) melhor = { d, n, campo };
      }
    }
    if (melhor) cand.push({ c, ...melhor });
  }
  cand.sort((a, b) => a.d - b.d);
  if (cand.length !== 1 && !(cand.length > 1 && cand[1].d - cand[0].d >= 2)) return false;
  const { c, n, campo } = cand[0];
  const esperado = campo === "Ref ID" ? c.envio_venda_id : c.envio_devolucao_id;
  const detalhe = `Número lido na etiqueta: ${n}. Número do caso (${campo}): ${esperado}. Pedido ${c.pedido}.`;
  const { error } = await admin.from("devol_recebimentos").update({ caso_id: c.id, identificacao: "identificado", fonte_identificacao: `APROXIMAÇÃO pelo ${campo} (conferir)`, loja_id: c.loja_id, ligacao_aproximada: true, ligacao_detalhe: detalhe, analise: "pendente", analise_erro: null })
    .eq("id", r.id).is("caso_id", null).neq("analise", "processando");
  if (error) return false;
  await admin.from("devol_anexos").update({ caso_id: c.id }).eq("recebimento_id", r.id);
  return true;
}

async function varrer() {
  const res = { analisados: 0, dispensados: 0, fotos_apagadas: 0, com_reclamacao: 0, ligados: 0, aproximados: 0, envios_preenchidos: 0 };
  try { res.envios_preenchidos = await preencherEnviosVenda(); } catch (_) { /* não atrapalha */ }
  const { data: lotes } = await admin.from("devol_recebimentos").select("id, analise_resumo").is("caso_id", null).is("dispensado_em", null).eq("analise", "concluida")
    .gt("criado_em", new Date(Date.now() - 45 * 86_400_000).toISOString()).order("criado_em", { ascending: false }).limit(25);
  for (const r of lotes ?? []) {
    const nums = [...new Set((r.analise_resumo?.etiqueta ?? []).filter((e: any) => e?.tipo !== "nome" && (e?.confianca === "alta" || (e?.tipo === "ref_id" && String(e.valor ?? "").replace(/\D/g, "").length === 11))).map((e: any) => String(e.valor ?? "").replace(/\D/g, "")).filter((n: string) => n.length >= 8 && n.length <= 16))] as string[];
    const numsAprox = [...new Set((r.analise_resumo?.etiqueta ?? []).filter((e: any) => e?.tipo === "ref_id" || e?.tipo === "rastreio").map((e: any) => String(e.valor ?? "").replace(/\D/g, "")).filter((n: string) => n.length >= 9 && n.length <= 13))] as string[];
    if (!nums.length && !numsAprox.length) continue;
    res.analisados++;
    let resolvido = false;
    const { data: a } = await admin.rpc("devol_achar_caso", { p_numeros: nums, p_nomes: [] });
    if ((a?.[0]?.n ?? 0) > 0) continue; // já existe caso: a ligação automática cuida
    for (const n of nums) {
      const x: any = await procurar(n);
      if (!x.achou) continue;
      resolvido = true;
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
    if (!resolvido && numsAprox.length && (await ligarPorAproximacao(r, numsAprox))) res.aproximados++;
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
