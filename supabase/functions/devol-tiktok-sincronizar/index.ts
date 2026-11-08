// Devoluções (SOMENTE LEITURA): traz as devoluções/reembolsos do TikTok Shop e registra em devol_casos.
// Não responde, não contesta e não envia nada ao marketplace. Respeita a chave kill_switch.
// Também grava o valor reembolsado e o desfecho financeiro (para a tela Custos e saúde).
// Economia de registros (logs do Supabase): os casos da loja são lidos de uma vez só e o evento de leitura só é gravado quando o caso é criado ou muda.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGEM = "devol-tiktok-sincronizar";
const PADRAO = "6lo1ttda2b1bf";
type App = { k: string; s: string };
const appDe = (k: string): App => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function diag(mensagem: string) {
  console.error(ORIGEM, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function credenciais(lojaId: string): Promise<{ token: string; cipher: string; app: App } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const cipher = (cred.dados_extras as any)?.shop_cipher;
  const app = appDe((cred.dados_extras as any)?.app_key ?? PADRAO);
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return { token: cred.token_acesso, cipher, app };
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${AUTH}/api/v2/token/refresh?` + new URLSearchParams({ app_key: app.k, app_secret: app.s, refresh_token: cred.token_renovacao, grant_type: "refresh_token" }));
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) {
    const { data: outra } = await ler();
    return valido(outra) ? { token: outra!.token_acesso, cipher, app } : null;
  }
  const d = t.data;
  await supabase.from("credenciais_lojas").update({
    token_acesso: d.access_token, token_renovacao: d.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return { token: d.access_token, cipher, app };
}

async function tts(metodo: "GET" | "POST", caminho: string, c: { token: string; cipher: string; app: App }, extra: Record<string, string>, corpo?: unknown) {
  const body = corpo ? JSON.stringify(corpo) : "";
  const q: Record<string, string> = { app_key: c.app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + body;
  q.sign = await hmac(c.app.s, c.app.s + base + c.app.s);
  const r = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
    method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, ...(body ? { body } : {}),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok ${r.status} ${caminho}: ${j.code} ${String(j.message).slice(0, 160)}`);
  return j.data;
}

const ESTADOS_INICIAIS = ["NOVO", "AGUARDANDO_ANALISE", "AGUARDANDO_PROVAS", "PREPARADO"];

function proximoEstado(atual: string | null, fechado: boolean): string {
  if (!atual) return fechado ? "DECIDIDO" : "NOVO";
  if (ESTADOS_INICIAIS.includes(atual)) return fechado ? "DECIDIDO" : atual;
  if (["ENVIADO", "EM_ANALISE", "COMPLEMENTACAO", "RECURSO_DISPONIVEL"].includes(atual)) return fechado ? "DECIDIDO" : atual;
  return atual; // ENVIO_INCERTO, DECIDIDO, CREDITO_PENDENTE e finais não mudam sozinhos
}

const fechada = (status: string) => /COMPLETE|CANCEL|REJECT|CLOSE/.test(status.toUpperCase());
const isoDe = (t: any) => (t ? new Date(Number(t) * 1000).toISOString() : null);

// Valor devolvido ao comprador, onde o TikTok informar.
function valorDoReembolso(r: any): number | null {
  const a = r?.refund_amount ?? r?.refund ?? null;
  const cand = [a?.refund_total, a?.total, a?.refund_amount, a?.amount, typeof a === "string" || typeof a === "number" ? a : null, r?.refund_total];
  for (const c of cand) { const v = Number(c); if (Number.isFinite(v) && v > 0) return v; }
  return null;
}

// Reembolso rápido (is_quick_refund) ou só reembolso: o produto NÃO volta para a loja.
function desfechoDe(r: any, status: string): string {
  const s = status.toUpperCase();
  if (!fechada(s)) return "em_andamento";
  if (/CANCEL/.test(s)) return "cancelado";
  if (/REJECT/.test(s)) return "ganhamos";
  const tipo = String(r?.return_type ?? r?.type ?? "").toUpperCase();
  if (r?.is_quick_refund === true) return "reembolsado_total";
  if (tipo === "REFUND") return "reembolsado_total";
  return "devolvido_com_produto";
}

// Todos os casos da loja numa consulta só.
async function carregarCache(lojaId: string): Promise<Map<string, any>> {
  const m = new Map<string, any>();
  const { data } = await supabase.from("devol_casos").select("id, solicitacao_id, status, desfecho, valor_reembolsado").eq("loja_id", lojaId).limit(3000);
  for (const r of data ?? []) m.set(String(r.solicitacao_id), r);
  return m;
}

async function registrar(loja: any, r: any, resumo: any, explorar: boolean, cache: Map<string, any>) {
  const solicitacao = String(r.id ?? r.return_id);
  const status = String(r.status ?? r.return_status ?? "");
  const atual: any = cache.get(solicitacao) ?? null;
  const estado = proximoEstado(atual?.status ?? null, fechada(status));
  const desfecho = desfechoDe(r, status);
  const valor = valorDoReembolso(r);
  const campos: any = {
    pedido: r.order_id ? String(r.order_id) : undefined,
    motivo_original: r.return_reason ?? r.return_reason_text ?? undefined,
    status: estado,
    prioridade: ["ENVIADO", "EM_ANALISE", "DECIDIDO", "CREDITO_PENDENTE"].includes(estado) ? "P3" : "P2",
    desfecho,
    valor_em_risco: valor ?? undefined,
    valor_pedido: valor ?? undefined,
    valor_reembolsado: desfecho === "ganhamos" || desfecho === "cancelado" ? 0 : (valor ?? undefined),
    proxima_verificacao: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  };
  Object.keys(campos).forEach((k) => campos[k] === undefined && delete campos[k]);
  let casoId = atual?.id as string | undefined;
  let gravou = false;
  if (!casoId) {
    const { data: novo, error } = await supabase.from("devol_casos").insert({ loja_id: loja.id, solicitacao_id: solicitacao, ...campos }).select("id").single();
    if (error) throw new Error(`erro ao criar o caso ${solicitacao}: ${error.message}`);
    casoId = novo.id; resumo.novos++; gravou = true;
  } else if (atual!.status !== estado || atual!.desfecho !== desfecho || (valor !== null && Number(atual!.valor_reembolsado ?? 0) !== valor && desfecho !== "cancelado" && desfecho !== "ganhamos")) {
    const { error } = await supabase.from("devol_casos").update(campos).eq("id", casoId);
    if (error) throw new Error(`erro ao atualizar o caso ${solicitacao}: ${error.message}`);
    if (atual!.status !== estado) resumo.mudaram++;
    gravou = true;
  }
  // O evento de leitura só é gravado quando o caso é criado ou muda.
  if (gravou) {
    await supabase.from("devol_eventos").upsert({
      caso_id: casoId, tipo: "leitura_marketplace", evento_chave: `tt:${solicitacao}:${status}:${r.update_time ?? ""}`,
      dados: { fonte: "tiktok_shop", return_id: solicitacao, status, type: r.return_type ?? null, stage: null, reason: r.return_reason ?? null, pedido: r.order_id ?? null, atualizado_em: isoDe(r.update_time), estado_local: estado, desfecho, valor_reembolso: valor },
    }, { onConflict: "evento_chave", ignoreDuplicates: true });
  }
  if (explorar && !resumo.amostra) resumo.amostra = { status, return_type: r.return_type ?? null, refund_amount: r.refund_amount ?? null, chaves: Object.keys(r).slice(0, 30) };
}

async function sincronizarLoja(loja: any, explorar: boolean, inicio: number): Promise<any> {
  const resumo: any = { loja: loja.apelido, novos: 0, mudaram: 0, lidos: 0 };
  const c = await credenciais(loja.id);
  if (!c || !c.cipher) { resumo.erro = "conexão precisa ser refeita"; return resumo; }
  const cache = await carregarCache(loja.id);
  const desde = Math.floor(Date.now() / 1000) - 45 * 86400;
  let pagina: string | undefined;
  for (let n = 0; n < 10 && Date.now() - inicio < 100_000; n++) {
    const extra: Record<string, string> = { page_size: "50", sort_field: "update_time", sort_order: "DESC" };
    if (pagina) extra.page_token = pagina;
    let d: any;
    try { d = await tts("POST", "/return_refund/202309/returns/search", c, extra, { update_time_ge: desde }); }
    catch (e) { resumo.erro_busca = (e as Error).message.slice(0, 250); break; }
    const lista: any[] = d?.return_orders ?? d?.returns ?? [];
    for (const r of lista) {
      try { await registrar(loja, r, resumo, explorar, cache); resumo.lidos++; }
      catch (e) { resumo.erro_registro = (e as Error).message.slice(0, 250); }
    }
    pagina = d?.next_page_token;
    if (!pagina || !lista.length) break;
  }
  return resumo;
}

async function chaveLigada(chave: string): Promise<boolean> {
  const { data } = await supabase.from("devol_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor === "true";
}

async function executar(explorar: boolean) {
  const inicio = Date.now();
  const resultados: any[] = [];
  try {
    if (await chaveLigada("kill_switch")) { await diag("kill_switch ligado: leitura não executada"); return; }
    const { data: lojas } = await supabase.from("lojas").select("id, apelido").eq("marketplace", "tiktok_shop").eq("ativa", true);
    for (const l of lojas ?? []) resultados.push(await sincronizarLoja(l, explorar, inicio));
    await supabase.from("devol_config").upsert({ chave: "ultima_leitura_tiktok", valor: new Date().toISOString(), descricao: "Última leitura de devoluções do TikTok Shop", atualizado_em: new Date().toISOString() });
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : String(e)}`); }
  if (explorar || resultados.some((r) => r.erro || r.erro_busca)) await diag(`resultado: ${JSON.stringify(resultados)}`);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(executar(!!corpo.explorar));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
