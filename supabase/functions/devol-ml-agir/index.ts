// Devoluções: ações da LOJA em reclamações do Mercado Livre (reembolso total, parcial, aceitar devolução, falar com o mediador ou com o comprador).
// Só age quando uma pessoa da equipe confirma na tela e o ML ainda oferece a ação. A Sandy NÃO chama esta função.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.mercadolibre.com";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ACAO_ML: Record<string, string> = { refund: "refund", allow_return: "allow_return", partial_refund: "allow_partial_refund", mediador_opcao: "send_message_to_mediator", mediador_pct: "send_message_to_mediator", mediador_texto: "send_message_to_mediator", comprador_texto: "send_message_to_complainant" };

async function token(lojaId: string): Promise<string | null> {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  if (c && valido(c)) return c.token_acesso;
  if (!c?.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: c.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) {
    await admin.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return t.access_token;
  }
  const { data: o } = await ler();
  return valido(o) ? o!.token_acesso : null;
}

async function ml(metodo: string, caminho: string, tk: string, corpo?: any) {
  const r = await fetch(`${API}${caminho}`, { method: metodo, headers: { Authorization: `Bearer ${tk}`, Accept: "application/json", ...(corpo ? { "Content-Type": "application/json" } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(25_000) });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch (_) { /* */ }
  return { ok: r.ok, status: r.status, j, txt: txt.slice(0, 300) };
}

const ORIGENS: Record<string, string> = { mediator: "mediador", respondent: "loja", complainant: "comprador" };

async function guardarMensagens(casoId: string, claimId: string, tk: string) {
  const ms = await ml("GET", `/post-purchase/v1/claims/${claimId}/messages`, tk);
  const lista: any[] = Array.isArray(ms.j) ? ms.j : (ms.j?.messages ?? []);
  for (const m of lista) {
    const o = ORIGENS[String(m?.sender_role)];
    if (!o || !m?.message) continue;
    await admin.from("devol_mensagens").upsert({
      caso_id: casoId, origem: o, chave: `ml-msg:${claimId}:${m.hash ?? m.date_created ?? ""}`,
      texto: String(m.message).slice(0, 4000), anexos: Array.isArray(m.attachments) ? m.attachments.length : 0, enviado_em: m.date_created ?? null,
    }, { onConflict: "chave", ignoreDuplicates: true });
  }
  return lista.length;
}

// Atualiza na hora as ações e o prazo da loja (o ML tira as ações da loja quando a bola passa para o comprador ou para o ML).
function acoesDaLoja(claim: any): { nome: string; prazo: string | null }[] {
  const lista: { nome: string; prazo: string | null }[] = [];
  for (const p of claim?.players ?? []) {
    if (p?.role !== "respondent") continue;
    for (const a of p?.available_actions ?? []) {
      const t = a?.due_date ? new Date(a.due_date).getTime() : NaN;
      lista.push({ nome: String(a?.action ?? ""), prazo: Number.isNaN(t) ? null : new Date(t).toISOString() });
    }
  }
  return lista;
}
async function atualizarEstadoDoCaso(casoId: string, claimId: string, tk: string) {
  const c = await ml("GET", `/post-purchase/v1/claims/${claimId}`, tk);
  if (!c.ok) return;
  const acoes = acoesDaLoja(c.j);
  const datas = acoes.map((a) => (a.prazo ? new Date(a.prazo).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  await admin.from("devol_casos").update({ acoes_loja: c.j?.status === "opened" ? acoes.map((a) => a.nome) : [], prazo_em: datas.length ? new Date(Math.min(...datas)).toISOString() : null }).eq("id", casoId);
}

function opcoesDaMensagem(texto: string) {
  const lista: { n: number; titulo: string }[] = [];
  for (const l of texto.split("\n")) {
    const m = l.match(/^\s*(\d+)\.\s*\*\*(.+?)\*\*\s*[—\-:]\s*(.+)$/);
    if (m) lista.push({ n: Number(m[1]), titulo: m[2].trim() });
  }
  return lista;
}

function textoLivreValido(t: string): string | null {
  const x = t.trim();
  if (x.length < 2 || x.length > 400) return null;
  if (/https?:\/\/|www\.|@|\b\d{8,}\b/i.test(x)) return null;
  return x;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const usuario = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u } = await usuario.auth.getUser();
    if (!u?.user) return resp({ ok: false, mensagem: "Sessão inválida. Entre de novo." }, 401);
    const { data: acesso } = await usuario.rpc("tem_acesso", { p_app: "devolucoes" });
    if (!acesso) return resp({ ok: false, mensagem: "Sem acesso ao app de devoluções." }, 403);

    const corpo: any = await req.json().catch(() => ({}));
    const modo = String(corpo.modo ?? "");
    const { data: caso } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, status").eq("id", String(corpo.caso_id ?? "")).maybeSingle();
    if (!caso) return resp({ ok: false, mensagem: "Caso não encontrado." }, 404);
    const { data: loja } = await admin.from("lojas").select("marketplace").eq("id", caso.loja_id).maybeSingle();
    if (loja?.marketplace !== "mercado_livre") return resp({ ok: false, mensagem: "Esta ação só existe para o Mercado Livre." }, 400);
    const tk = await token(caso.loja_id);
    if (!tk) return resp({ ok: false, mensagem: "A conexão desta loja com o Mercado Livre precisa ser refeita." }, 502);
    const claimId = caso.solicitacao_id;

    if (modo === "mensagens") {
      const n = await guardarMensagens(caso.id, claimId, tk);
      await atualizarEstadoDoCaso(caso.id, claimId, tk);
      return resp({ ok: true, mensagens: n });
    }

    const c = await ml("GET", `/post-purchase/v1/claims/${claimId}`, tk);
    if (!c.ok) return resp({ ok: false, mensagem: `O Mercado Livre não respondeu (${c.status}). Tente de novo.` }, 502);
    const disponiveis: string[] = [];
    for (const p of c.j?.players ?? []) if (p?.role === "respondent") for (const a of p?.available_actions ?? []) disponiveis.push(String(a?.action));

    if (modo === "ofertas") {
      const o = await ml("GET", `/post-purchase/v1/claims/${claimId}/partial-refund/available-offers`, tk);
      return resp({ ok: true, status: c.j?.status, acoes: disponiveis, ofertas: o.ok ? (o.j?.available_offers ?? []) : [], moeda: o.j?.currency_id ?? "BRL" });
    }

    if (modo !== "agir") return resp({ ok: false, mensagem: "Pedido inválido." }, 400);
    const acao = String(corpo.acao ?? "");
    if (!ACAO_ML[acao]) return resp({ ok: false, mensagem: "Ação desconhecida." }, 400);

    const { data: cfg } = await admin.from("devol_config").select("chave, valor").in("chave", ["kill_switch", "envio_real"]);
    if ((cfg ?? []).find((x: any) => x.chave === "kill_switch")?.valor === "true") return resp({ ok: false, mensagem: "O interruptor geral está ligado. Nada é enviado." }, 423);
    if ((cfg ?? []).find((x: any) => x.chave === "envio_real")?.valor !== "true") return resp({ ok: false, mensagem: "O envio ao marketplace está desligado nas configurações." }, 423);
    if (corpo.confirmado !== true) return resp({ ok: false, mensagem: "Falta a confirmação da pessoa." }, 400);
    if (c.j?.status !== "opened") return resp({ ok: false, mensagem: "Esta reclamação já não está aberta." }, 409);
    if (!disponiveis.includes(ACAO_ML[acao])) return resp({ ok: false, mensagem: "O Mercado Livre não oferece mais essa ação para a loja neste caso." }, 409);

    let pct: number | null = null;
    let textoMediador = "";
    if (acao === "partial_refund") {
      pct = Number(corpo.percentual);
      const o = await ml("GET", `/post-purchase/v1/claims/${claimId}/partial-refund/available-offers`, tk);
      if (!(o.j?.available_offers ?? []).some((x: any) => Number(x.percentage) === pct)) return resp({ ok: false, mensagem: "Esse percentual não está entre os que o Mercado Livre permite." }, 400);
    }
    if (acao === "mediador_pct") {
      pct = Number(corpo.percentual);
      if (!(pct > 0 && pct <= 100)) return resp({ ok: false, mensagem: "Percentual inválido." }, 400);
      const o = await ml("GET", `/post-purchase/v1/claims/${claimId}/partial-refund/available-offers`, tk);
      let ok = (o.j?.available_offers ?? []).some((x: any) => Number(x.percentage) === pct);
      if (!ok) {
        const ms = await ml("GET", `/post-purchase/v1/claims/${claimId}/messages`, tk);
        const lista: any[] = Array.isArray(ms.j) ? ms.j : (ms.j?.messages ?? []);
        const re = new RegExp(`(^|[^\\d,.])${String(pct).replace(".", "[.,]")}\\s?%`);
        ok = lista.some((m: any) => m?.sender_role === "mediator" && re.test(String(m?.message ?? "")));
      }
      if (!ok) return resp({ ok: false, mensagem: "Esse percentual não foi citado pelo Mercado Livre nem está entre os permitidos." }, 400);
      textoMediador = `Quero oferecer ${pct}% de reembolso parcial.`;
    }
    if (acao === "mediador_opcao") {
      const ms = await ml("GET", `/post-purchase/v1/claims/${claimId}/messages`, tk);
      const lista: any[] = Array.isArray(ms.j) ? ms.j : (ms.j?.messages ?? []);
      const ultima = lista.filter((m: any) => m?.sender_role === "mediator" && m?.message).sort((a: any, b: any) => String(b.date_created).localeCompare(String(a.date_created)))[0];
      const op = opcoesDaMensagem(String(ultima?.message ?? "")).find((x) => x.n === Number(corpo.opcao));
      if (!op) return resp({ ok: false, mensagem: "Essa opção não está na última mensagem do Mercado Livre." }, 400);
      textoMediador = `Escolho a opção ${op.n}: ${op.titulo}.`;
      pct = op.n;
    }
    if (acao === "mediador_texto" || acao === "comprador_texto") {
      const t = textoLivreValido(String(corpo.texto ?? ""));
      if (!t) return resp({ ok: false, mensagem: "Texto inválido: use até 400 caracteres, sem links, e-mails ou telefones." }, 400);
      textoMediador = t;
    }

    const detalhe = { acao, percentual: acao === "partial_refund" || acao === "mediador_pct" ? pct : null, opcao: acao === "mediador_opcao" ? pct : null, texto: acao === "mediador_texto" || acao === "comprador_texto" ? textoMediador : undefined, usuario: u.user.id };
    const { data: recentes } = await admin.from("devol_eventos").select("criado_em, dados").eq("caso_id", caso.id).in("tipo", ["resposta_ml_enviada", "resposta_ml_tentativa"]).gte("criado_em", new Date(Date.now() - 2 * 60_000).toISOString());
    const igual = (recentes ?? []).some((e: any) => e.dados?.acao === acao && (e.dados?.texto ?? null) === (detalhe.texto ?? null) && (e.dados?.percentual ?? null) === (detalhe.percentual ?? null) && (e.dados?.opcao ?? null) === (detalhe.opcao ?? null));
    if (igual) return resp({ ok: false, mensagem: "Esse mesmo envio já foi feito há menos de 2 minutos. Toque em Atualizar conversa para conferir." }, 409);
    if ((recentes ?? []).some((e: any) => Date.now() - new Date(e.criado_em).getTime() < 5000)) return resp({ ok: false, mensagem: "Aguarde alguns segundos e envie de novo." }, 409);
    await admin.from("devol_eventos").insert({ caso_id: caso.id, tipo: "resposta_ml_tentativa", evento_chave: `agir-tent:${caso.id}:${Date.now()}`, dados: detalhe });

    const base = `/marketplace/v2/claims/${claimId}/expected-resolutions`;
    const alvo = acao === "refund" ? await ml("POST", `${base}/refund`, tk)
      : acao === "allow_return" ? await ml("POST", `${base}/allow-return`, tk)
      : acao === "partial_refund" ? await ml("POST", `${base}/partial-refund`, tk, { percentage: pct })
      : await ml("POST", `/post-purchase/v1/claims/${claimId}/actions/send-message`, tk, { receiver_role: acao === "comprador_texto" ? "complainant" : "mediator", message: textoMediador });
    await admin.from("devol_eventos").insert({ caso_id: caso.id, tipo: alvo.ok ? "resposta_ml_enviada" : "resposta_ml_erro", evento_chave: `agir-res:${caso.id}:${Date.now()}`, dados: { ...detalhe, http: alvo.status, resposta: alvo.ok ? "ok" : alvo.txt } });
    if (!alvo.ok) return resp({ ok: false, mensagem: `O Mercado Livre recusou (${alvo.status}): ${alvo.txt.slice(0, 160)}` }, 502);
    let respondeu = false;
    try {
      await new Promise((r) => setTimeout(r, 4000));
      const antes = await admin.from("devol_mensagens").select("id", { count: "exact", head: true }).eq("caso_id", caso.id);
      await guardarMensagens(caso.id, claimId, tk);
      const depois = await admin.from("devol_mensagens").select("id", { count: "exact", head: true }).eq("caso_id", caso.id);
      respondeu = (depois.count ?? 0) - (antes.count ?? 0) >= 2;
      await atualizarEstadoDoCaso(caso.id, claimId, tk);
    } catch (_) { /* a leitura periódica completa depois */ }
    return resp({ ok: true, respondeu, mensagem: acao === "comprador_texto" ? "Mensagem enviada ao comprador." : acao.startsWith("mediador") ? (respondeu ? "Enviado ao mediador do Mercado Livre e ele já respondeu." : "Enviado ao mediador do Mercado Livre. Ele ainda não respondeu: toque em Atualizar conversa.") : "Resposta enviada ao Mercado Livre." });
  } catch (e) {
    return resp({ ok: false, mensagem: `Erro: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }, 500);
  }
});
