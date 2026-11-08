// Devoluções (SOMENTE LEITURA): traz as reclamações/devoluções do Mercado Livre e registra em devol_casos.
// Não responde, não contesta e não envia nada ao marketplace. Respeita a chave kill_switch.
// Modo normal: lê tudo (a cada 15 min), incluindo as encerradas dos últimos 45 dias. Modo foco ({"foco":true}, a cada 3 min): relê só os casos em conversa ou com ação da loja.
// Modo revisões ({"revisoes":true}): varre as reclamações ENCERRADAS à procura das que ainda esperam a revisão do vendedor (return_review_ok), porque o ML encerra a reclamação mas o produto devolvido ainda precisa ser revisado pela loja dentro do prazo.
// Também grava o valor do pedido, o valor REALMENTE reembolsado (pagamentos do pedido), o CUSTO REAL DO FRETE da devolução e o desfecho financeiro (para a tela Custos e saúde).
// Economia de registros e de tráfego (Supabase): no modo normal os casos da loja são lidos de uma vez só; no modo foco só os casos acompanhados. Se a reclamação não mudou desde a última leitura (mkt_atualizado igual a last_updated) e o caso foi gravado há menos de 6 horas, não regrava nada; só confere mensagens novas, gravando apenas as que faltam.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";
const ORIGEM = "devol-ml-sincronizar";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function diag(mensagem: string) {
  console.error(ORIGEM, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

class ErroML extends Error {
  status: number;
  constructor(msg: string, status: number) { super(msg); this.status = status; }
}

async function ml(caminho: string, token: string): Promise<any> {
  const r = await fetch(`${API}${caminho}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) {
    const corpo = (await r.text().catch(() => "")).slice(0, 300);
    throw new ErroML(`Mercado Livre respondeu ${r.status} em ${caminho}: ${corpo}`, r.status);
  }
  return await r.json();
}

const tokens = new Map<string, string | null>();
async function tokenDaLoja(lojaId: string): Promise<string | null> {
  if (tokens.has(lojaId)) return tokens.get(lojaId)!;
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  let resultado: string | null = null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) resultado = cred.token_acesso;
  else if (cred?.token_renovacao) {
    const resp = await fetch(`${API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }),
    });
    const t: any = await resp.json().catch(() => ({}));
    if (resp.ok) {
      await supabase.from("credenciais_lojas").update({
        token_acesso: t.access_token,
        token_renovacao: t.refresh_token ?? cred.token_renovacao,
        expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
        atualizado_em: new Date().toISOString(),
      }).eq("loja_id", lojaId);
      resultado = t.access_token;
    } else {
      const { data: outra } = await ler();
      if (valido(outra)) resultado = outra!.token_acesso;
      else await diag(`falha ao renovar o token da loja ${lojaId}: ${resp.status} ${t?.error ?? ""}`);
    }
  }
  tokens.set(lojaId, resultado);
  return resultado;
}

const ESTADOS_INICIAIS = ["NOVO", "AGUARDANDO_ANALISE", "AGUARDANDO_PROVAS", "PREPARADO"];
const ESTADOS_FINAIS = ["ENCERRADO", "CONCILIADO"];

function acoesDaLoja(claim: any): { nome: string; prazo: string | null; obrigatoria: boolean }[] {
  const lista: { nome: string; prazo: string | null; obrigatoria: boolean }[] = [];
  for (const p of claim?.players ?? []) {
    if (p?.role !== "respondent") continue;
    for (const a of p?.available_actions ?? []) {
      const t = a?.due_date ? new Date(a.due_date).getTime() : NaN;
      lista.push({ nome: String(a?.action ?? ""), prazo: Number.isNaN(t) ? null : new Date(t).toISOString(), obrigatoria: !!a?.mandatory });
    }
  }
  return lista;
}

// Reclamação encerrada pelo ML, mas com a revisão da devolução ainda pendente para a loja (o produto voltou e a loja precisa dizer se veio conforme).
function revisaoPendente(claim: any): boolean {
  return claim?.status === "closed" && acoesDaLoja(claim).some((a) => a.nome === "return_review_ok" || a.nome === "return_review_unified_ok");
}

function proximoEstado(atual: string | null, claim: any): string {
  const pend = revisaoPendente(claim);
  const fechado = claim?.status === "closed" && !pend;
  const disputa = claim?.stage === "dispute";
  if (!atual) return fechado ? "DECIDIDO" : pend ? "NOVO" : disputa ? "EM_ANALISE" : "NOVO";
  if (pend && atual === "DECIDIDO") return "NOVO";
  if (ESTADOS_INICIAIS.includes(atual)) return fechado ? "DECIDIDO" : atual;
  if (atual === "ENVIADO") return fechado ? "DECIDIDO" : disputa ? "EM_ANALISE" : atual;
  if (["EM_ANALISE", "COMPLEMENTACAO", "RECURSO_DISPONIVEL"].includes(atual)) return fechado ? "DECIDIDO" : atual;
  return atual;
}

function prazoDoVendedor(claim: any): string | null {
  const datas = acoesDaLoja(claim).map((a) => (a.prazo ? new Date(a.prazo).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  return datas.length ? new Date(Math.min(...datas)).toISOString() : null;
}

function prioridade(estado: string, prazo: string | null): string {
  if (["ENVIADO", "EM_ANALISE", "DECIDIDO", "CREDITO_PENDENTE"].includes(estado)) return "P3";
  if (prazo) {
    const h = (new Date(prazo).getTime() - Date.now()) / 3_600_000;
    if (h < 24) return "P0";
    if (h < 48) return "P1";
  }
  return "P2";
}

// Desfecho financeiro do caso, segundo a decisão do Mercado Livre.
function desfechoDe(claim: any): string {
  if (claim?.status !== "closed") return "em_andamento";
  const res = claim?.resolution ?? {};
  const quem = String(Array.isArray(res.benefited) ? (res.benefited[0] ?? "") : (res.benefited ?? "")).toLowerCase();
  const motivo = String(res.reason ?? "").toLowerCase();
  if (String(claim?.type ?? "").includes("cancel")) return "cancelado";
  if (quem.includes("respondent") || quem.includes("seller")) return "ganhamos";
  if (quem.includes("complainant") || quem.includes("buyer")) {
    if (motivo.includes("partial")) return "reembolsado_parcial";
    if (motivo.includes("return") || motivo.includes("item_returned")) return "devolvido_com_produto";
    return "reembolsado_total";
  }
  return "cancelado";
}

// Se o que foi realmente devolvido ao comprador é bem menor que o pedido, é reembolso parcial.
function ajustaParcial(desfecho: string, reembolsado: number, total: number): string {
  if ((desfecho === "reembolsado_total" || desfecho === "devolvido_com_produto") && reembolsado > 0 && total > 0 && reembolsado < total * 0.98) return "reembolsado_parcial";
  return desfecho;
}

// Pedido do caso: a reclamação pode ser sobre o pedido (order) ou sobre o envio (shipment).
async function pedidoDoClaim(claim: any, token: string): Promise<string | null> {
  const id = claim?.resource_id ? String(claim.resource_id) : null;
  if (!id) return null;
  if (String(claim?.resource ?? "order") !== "shipment") return id;
  try {
    const e = await ml(`/shipments/${id}`, token);
    const o = e?.order_id ?? e?.orders?.[0]?.id ?? e?.order?.id;
    return o ? String(o) : null;
  } catch (_) { return null; }
}

// Valor do pedido e quanto REALMENTE foi devolvido ao comprador (soma dos pagamentos do pedido).
async function dadosDoPedido(pedido: string, token: string): Promise<{ total: number | null; reembolsado: number }> {
  try {
    const o = await ml(`/orders/${pedido}`, token);
    const t = Number(o?.total_amount ?? o?.paid_amount);
    let reemb = 0;
    for (const p of o?.payments ?? []) { const r = Number(p?.transaction_amount_refunded); if (Number.isFinite(r) && r > 0) reemb += r; }
    return { total: Number.isFinite(t) && t > 0 ? t : null, reembolsado: Math.round(reemb * 100) / 100 };
  } catch (_) { return { total: null, reembolsado: 0 }; }
}

// Custo REAL do frete da devolução (envio do tipo "return" do caso): custo do recebedor menos compensações.
// 404 = o caso não tem devolução física (custo 0, não precisa tentar de novo). Outro erro: tenta de novo na próxima leitura.
async function freteDaDevolucao(claimId: string, token: string): Promise<{ valor: number; lido: boolean }> {
  try {
    const r = await ml(`/post-purchase/v2/claims/${claimId}/returns`, token);
    const envios: any[] = (r?.shipments ?? []).filter((s: any) => String(s?.type ?? "return") === "return" && s?.shipment_id);
    if (!envios.length) return { valor: 0, lido: true };
    let total = 0;
    for (const e of envios) {
      const c = await ml(`/shipments/${e.shipment_id}/costs`, token);
      const custo = Number(c?.receiver?.cost ?? 0), comp = Number(c?.receiver?.compensation ?? 0);
      if (Number.isFinite(custo)) total += Math.max(0, custo - (Number.isFinite(comp) ? comp : 0));
    }
    return { valor: Math.round(total * 100) / 100, lido: true };
  } catch (e) {
    if (e instanceof ErroML && (e.status === 404 || e.status === 400)) return { valor: 0, lido: true };
    return { valor: 0, lido: false };
  }
}

async function chaveLigada(chave: string): Promise<boolean> {
  const { data } = await supabase.from("devol_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor === "true";
}

const ORIGENS: Record<string, string> = { mediator: "mediador", respondent: "loja", complainant: "comprador" };

// Grava só as mensagens que ainda não estão no banco (uma consulta + no máximo uma gravação), em vez de regravar todas a cada leitura.
async function guardarMensagens(casoId: string, claim: any, token: string, resumo: any) {
  try {
    const r = await ml(`/post-purchase/v1/claims/${claim.id}/messages`, token);
    const lista: any[] = Array.isArray(r) ? r : (r?.messages ?? r?.data ?? []);
    const { data: ja } = await supabase.from("devol_mensagens").select("chave").eq("caso_id", casoId);
    const existentes = new Set((ja ?? []).map((x: any) => x.chave));
    const novas: any[] = [];
    for (const m of lista) {
      const o = ORIGENS[String(m?.sender_role)];
      if (!o || !m?.message) continue;
      const chave = `ml-msg:${claim.id}:${m.hash ?? m.date_created ?? ""}`;
      if (existentes.has(chave)) continue;
      novas.push({ caso_id: casoId, origem: o, chave, texto: String(m.message).slice(0, 4000), anexos: Array.isArray(m.attachments) ? m.attachments.length : 0, enviado_em: m.date_created ?? null });
    }
    if (novas.length) await supabase.from("devol_mensagens").upsert(novas, { onConflict: "chave", ignoreDuplicates: true });
  } catch (e) { resumo.erro_mensagens = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
}

async function jaHouveConversa(casoId: string): Promise<boolean> {
  const { count } = await supabase.from("devol_mensagens").select("id", { count: "exact", head: true }).eq("caso_id", casoId);
  return (count ?? 0) > 0;
}

const idadeHoras = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : 9999);

const COLUNAS = "id, solicitacao_id, status, motivo_original, desfecho, valor_pedido, valor_reembolsado, reembolso_lido, frete_lido, mkt_atualizado, atualizado_em";

// Casos da loja numa consulta só (em vez de uma consulta por reclamação). Com a lista de números, lê só esses casos.
async function carregarCache(lojaId: string, ids?: string[]): Promise<Map<string, any>> {
  const m = new Map<string, any>();
  if (ids && !ids.length) return m;
  let q = supabase.from("devol_casos").select(COLUNAS).eq("loja_id", lojaId);
  if (ids) q = q.in("solicitacao_id", ids);
  const { data } = await q.limit(3000);
  for (const r of data ?? []) m.set(String(r.solicitacao_id), r);
  return m;
}

async function registrarClaim(loja: any, claim: any, resumo: any, explorar: boolean, token: string, cache?: Map<string, any>) {
  const solicitacao = String(claim.id);
  let atual: any = null;
  if (cache) atual = cache.get(solicitacao) ?? null;
  else { const { data } = await supabase.from("devol_casos").select(COLUNAS).eq("loja_id", loja.id).eq("solicitacao_id", solicitacao).maybeSingle(); atual = data; }
  const pend = revisaoPendente(claim);
  const fechado = claim?.status === "closed" && !pend;
  const aberto = claim?.status === "opened" || pend;
  let desfecho = pend ? "em_andamento" : ajustaParcial(desfechoDe(claim), Number(atual?.valor_reembolsado ?? 0), Number(atual?.valor_pedido ?? 0));
  const precisaFrete = fechado && desfecho !== "ganhamos" && desfecho !== "cancelado" && !atual?.frete_lido;
  // Encerrada que já está completa no banco: nada a refazer.
  if (fechado && atual && atual.desfecho === desfecho && atual.valor_pedido && atual.reembolso_lido && !precisaFrete && atual.status === "DECIDIDO") return;
  // Reclamação igual à da última leitura e gravada há menos de 6 horas: não regrava o caso nem o evento; só confere mensagens novas.
  // A cada 6 horas o caso é regravado por segurança, caso o ML mude algo sem alterar last_updated.
  const ultima = claim?.last_updated ? String(claim.last_updated) : null;
  if (atual && ultima && atual.mkt_atualizado === ultima && !precisaFrete && idadeHoras(atual.atualizado_em) < 6) {
    if (aberto && (acoesDaLoja(claim).length || (await jaHouveConversa(atual.id)))) await guardarMensagens(atual.id, claim, token, resumo);
    return;
  }
  const prazo = prazoDoVendedor(claim);
  const acoes = acoesDaLoja(claim);
  const estado = proximoEstado(atual?.status ?? null, claim);
  const campos: any = {
    motivo_original: claim.reason_id ?? undefined,
    status: estado,
    prioridade: prioridade(estado, prazo),
    prazo_em: prazo,
    acoes_loja: aberto ? acoes.map((a) => a.nome) : [],
    mkt_atualizado: ultima ?? undefined,
    proxima_verificacao: new Date(Date.now() + (prazo && new Date(prazo).getTime() - Date.now() < 48 * 3_600_000 ? 1 : 3) * 3_600_000).toISOString(),
  };
  // Pedido, valor e reembolso real: uma consulta ao pedido (só enquanto falta algo).
  if (!atual?.valor_pedido || (fechado && !atual?.reembolso_lido)) {
    const pedido = await pedidoDoClaim(claim, token);
    if (pedido) {
      campos.pedido = pedido;
      const d = await dadosDoPedido(pedido, token);
      if (d.total) { campos.valor_pedido = d.total; campos.valor_em_risco = d.total; }
      if (fechado) {
        campos.reembolso_lido = d.total !== null;
        if (d.total !== null) {
          campos.valor_reembolsado = d.reembolsado;
          desfecho = ajustaParcial(desfechoDe(claim), d.reembolsado, d.total);
        }
      }
    }
  }
  if (precisaFrete) {
    const f = await freteDaDevolucao(solicitacao, token);
    campos.custo_frete = f.valor;
    campos.frete_lido = f.lido;
  }
  campos.desfecho = desfecho;
  if (desfecho === "ganhamos" && campos.valor_reembolsado === undefined) campos.valor_reembolsado = 0;
  if (fechado && claim?.last_updated) campos.resolvido_em = claim.last_updated;
  Object.keys(campos).forEach((k) => campos[k] === undefined && delete campos[k]);

  let casoId = atual?.id as string | undefined;
  if (!casoId) {
    const { data: novo, error } = await supabase.from("devol_casos").insert({ loja_id: loja.id, solicitacao_id: solicitacao, pedido: claim.resource_id ? String(claim.resource_id) : undefined, ...campos }).select("id").single();
    if (error) throw new Error(`erro ao criar o caso ${solicitacao}: ${error.message}`);
    casoId = novo.id;
    resumo.novos++;
  } else if (atual) {
    const { error } = await supabase.from("devol_casos").update(campos).eq("id", casoId);
    if (error) throw new Error(`erro ao atualizar o caso ${solicitacao}: ${error.message}`);
    if (atual.status !== estado) resumo.mudaram++;
  }

  const res = claim?.resolution ?? null;
  const resolucao = res ? { reason: res.reason ?? null, benefited: Array.isArray(res.benefited) ? (res.benefited[0] ?? null) : (res.benefited ?? null), closed_by: res.closed_by ?? null, applied_coverage: res.applied_coverage ?? null } : null;
  const chave = `ml:${solicitacao}:${claim.status}:${claim.stage}:${claim.last_updated ?? ""}${pend ? ":rev" : ""}`;
  await supabase.from("devol_eventos").upsert({
    caso_id: casoId, tipo: "leitura_marketplace", evento_chave: chave,
    dados: { fonte: "mercado_livre", claim_id: claim.id, status: pend ? "opened" : claim.status, status_ml: claim.status, revisao_pendente: pend, stage: claim.stage, type: claim.type, reason_id: claim.reason_id, pedido: claim.resource_id, prazo_vendedor: prazo, acoes_loja: acoes.map((a) => a.nome), estado_local: estado, resolucao, desfecho },
  }, { onConflict: "evento_chave", ignoreDuplicates: true });

  if (aberto && (acoes.length || (await jaHouveConversa(casoId!)))) await guardarMensagens(casoId!, claim, token, resumo);
  if (explorar && !resumo.amostra) resumo.amostra = claim;
}

// Modo foco: só os casos que a equipe está acompanhando (ação da loja ou conversa), para perceber rápido quando o ML ou o comprador respondem.
async function focoDaLoja(loja: any, inicio: number): Promise<any> {
  const resumo: any = { loja: loja.id, novos: 0, mudaram: 0, lidos: 0 };
  const token = await tokenDaLoja(loja.id);
  if (!token) { resumo.erro = "sem token"; return resumo; }
  const { data: comAcao } = await supabase.from("devol_casos").select("solicitacao_id").eq("loja_id", loja.id).not("status", "in", `(${ESTADOS_FINAIS.join(",")})`).not("prazo_em", "is", null).limit(40);
  const { data: conv } = await supabase.from("devol_mensagens").select("caso_id").eq("origem", "loja").order("enviado_em", { ascending: false }).limit(60);
  const idsConv = [...new Set((conv ?? []).map((x: any) => x.caso_id))];
  let comConversa: any[] = [];
  if (idsConv.length) {
    const { data } = await supabase.from("devol_casos").select("solicitacao_id").eq("loja_id", loja.id).in("id", idsConv).not("status", "in", `(${ESTADOS_FINAIS.join(",")})`);
    comConversa = data ?? [];
  }
  const alvo = [...new Set([...(comAcao ?? []), ...comConversa].map((x: any) => String(x.solicitacao_id)))];
  const cache = await carregarCache(loja.id, alvo);
  for (const sid of alvo) {
    if (Date.now() - inicio > 100_000) break;
    try { const c = await ml(`/post-purchase/v1/claims/${sid}`, token); await registrarClaim(loja, c, resumo, false, token, cache); resumo.lidos++; }
    catch (e) { resumo.erro_foco = `${e instanceof Error ? e.message : e}`.slice(0, 200); }
  }
  return resumo;
}

// Modo revisões: varre as reclamações encerradas e registra só as que ainda esperam a revisão do vendedor.
async function revisoesDaLoja(loja: any, inicio: number): Promise<any> {
  const resumo: any = { loja: loja.id, novos: 0, mudaram: 0, varridas: 0, pendentes: 0 };
  const token = await tokenDaLoja(loja.id);
  if (!token) { resumo.erro = "sem token"; return resumo; }
  const cache = await carregarCache(loja.id);
  for (let offset = 0; offset < 2000 && Date.now() - inicio < 100_000; offset += 50) {
    let pagina: any;
    try { pagina = await ml(`/post-purchase/v1/claims/search?status=closed&limit=50&offset=${offset}`, token); }
    catch (e) { resumo.erro_busca = `${e instanceof Error ? e.message : e}`.slice(0, 250); break; }
    const lista: any[] = pagina?.data ?? [];
    for (const c of lista) {
      resumo.varridas++;
      if (!revisaoPendente(c)) continue;
      if (Date.now() - inicio > 105_000) break;
      try { await registrarClaim(loja, c, resumo, false, token, cache); resumo.pendentes++; }
      catch (e) { resumo.erro_registro = `${e instanceof Error ? e.message : e}`.slice(0, 250); }
    }
    if (lista.length < 50) break;
  }
  return resumo;
}

async function sincronizarLoja(loja: any, explorar: boolean, inicio: number): Promise<any> {
  const resumo: any = { loja: loja.id, novos: 0, mudaram: 0, lidos: 0 };
  const token = await tokenDaLoja(loja.id);
  if (!token) { resumo.erro = "sem token"; return resumo; }
  const cache = await carregarCache(loja.id);

  const vistos = new Set<string>();
  for (let offset = 0; offset < 200 && Date.now() - inicio < 100_000; offset += 50) {
    let pagina: any;
    try { pagina = await ml(`/post-purchase/v1/claims/search?status=opened&limit=50&offset=${offset}`, token); }
    catch (e) { resumo.erro_busca = `${e instanceof Error ? e.message : e}`.slice(0, 250); break; }
    const lista: any[] = pagina?.data ?? [];
    for (const c of lista) {
      try { await registrarClaim(loja, c, resumo, explorar, token, cache); vistos.add(String(c.id)); resumo.lidos++; }
      catch (e) { resumo.erro_registro = `${e instanceof Error ? e.message : e}`.slice(0, 250); }
    }
    if (lista.length < 50) break;
  }

  const { data: abertos } = await supabase.from("devol_casos").select("solicitacao_id").eq("loja_id", loja.id).not("status", "in", `(${ESTADOS_FINAIS.join(",")})`).order("atualizado_em", { ascending: true }).limit(40);
  for (const a of abertos ?? []) {
    if (vistos.has(a.solicitacao_id) || Date.now() - inicio > 105_000) continue;
    try {
      const c = await ml(`/post-purchase/v1/claims/${a.solicitacao_id}`, token);
      await registrarClaim(loja, c, resumo, explorar, token, cache); resumo.lidos++;
    } catch (e) { resumo.erro_acompanhamento = `${e instanceof Error ? e.message : e}`.slice(0, 250); }
  }

  // Encerradas dos últimos 45 dias: dão o histórico financeiro (quanto foi reembolsado, quem ganhou, quanto custou o frete).
  const corte = Date.now() - 45 * 86_400_000;
  resumo.encerradas = 0;
  for (let offset = 0; offset < 200 && Date.now() - inicio < 100_000; offset += 50) {
    let pagina: any;
    try { pagina = await ml(`/post-purchase/v1/claims/search?status=closed&limit=50&offset=${offset}`, token); }
    catch (e) { resumo.erro_encerradas = `${e instanceof Error ? e.message : e}`.slice(0, 250); break; }
    const lista: any[] = pagina?.data ?? [];
    for (const c of lista) {
      const t = new Date(c?.last_updated ?? c?.date_created ?? 0).getTime();
      if (t && t < corte) continue;
      if (Date.now() - inicio > 105_000) break;
      try { await registrarClaim(loja, c, resumo, false, token, cache); resumo.encerradas++; }
      catch (e) { resumo.erro_registro = `${e instanceof Error ? e.message : e}`.slice(0, 250); }
    }
    if (lista.length < 50) break;
  }
  return resumo;
}

async function executar(explorar: boolean, foco: boolean, revisoes: boolean) {
  const inicio = Date.now();
  const resultados: any[] = [];
  try {
    if (await chaveLigada("kill_switch")) { if (!foco) await diag("kill_switch ligado: leitura de devoluções do ML não executada"); return; }
    const { data: lojas } = await supabase.from("lojas").select("id, id_externo").eq("marketplace", "mercado_livre").eq("ativa", true);
    for (const loja of lojas ?? []) {
      if (Date.now() - inicio > 110_000) break;
      resultados.push(revisoes ? await revisoesDaLoja(loja, inicio) : foco ? await focoDaLoja(loja, inicio) : await sincronizarLoja(loja, explorar, inicio));
    }
    if (!foco && !revisoes) await supabase.from("devol_config").upsert({ chave: "ultima_leitura_ml", valor: new Date().toISOString(), descricao: "Última leitura de devoluções do Mercado Livre", atualizado_em: new Date().toISOString() });
  } catch (e) {
    await diag(`erro: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (revisoes) await supabase.from("devol_config").upsert({ chave: "ultima_varredura_revisoes_ml", valor: JSON.stringify({ em: new Date().toISOString(), resultados }).slice(0, 1500), descricao: "Resultado da última varredura de revisões pendentes do ML", atualizado_em: new Date().toISOString() });
  if (explorar || resultados.some((r) => r.erro_mensagens || r.erro_foco || r.erro_encerradas || r.erro_busca)) await diag(`resultado${foco ? " foco" : ""}${revisoes ? " revisoes" : ""}: ${JSON.stringify(resultados).slice(0, 1200)}`);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(executar(!!corpo.explorar, !!corpo.foco, !!corpo.revisoes));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
