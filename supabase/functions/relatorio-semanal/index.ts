// Relatório semanal da Sandy no Telegram (domingo): resultados de chats e devoluções, com análise de pontos a melhorar.
// É o único aviso automático do grupo. Chamada pelo banco (cron de domingo) com o cabeçalho x-lucro-token.
// Modos: {} ou {enviar:true} gera e envia | {simular:true} gera e devolve o texto sem enviar (grava em diagnosticos).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("SANDY_MODELO") ?? "gpt-4.1-mini";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MK: Record<string, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop" };
const DIA = 86_400_000;

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
const topo = (itens: string[], n: number) => {
  const m = new Map<string, number>();
  for (const i of itens) if (i) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([nome, qtd]) => ({ nome, qtd }));
};
const soma = (l: any[], k: string) => Math.round(l.reduce((s, x) => s + (Number(x[k]) || 0), 0) * 100) / 100;

async function coletar() {
  const agora = new Date(), ini7 = new Date(agora.getTime() - 7 * DIA), ini14 = new Date(agora.getTime() - 14 * DIA);
  const [a, b] = await Promise.all([
    supabase.rpc("sandy_resumo_atendimento", { p_inicio: ini7.toISOString(), p_fim: agora.toISOString() }),
    supabase.rpc("sandy_resumo_atendimento", { p_inicio: ini14.toISOString(), p_fim: ini7.toISOString() }),
  ]);
  const { data: escal } = await supabase.from("sandy_registros").select("motivo, decisao").in("decisao", ["escalou", "erro"]).gte("criado_em", ini7.toISOString()).limit(2000);
  const { count: paradas } = await supabase.from("conversas").select("id", { count: "exact", head: true })
    .eq("aguardando_resposta", true).eq("ultima_mensagem_de", "cliente").lt("ultima_mensagem_em", new Date(agora.getTime() - 2 * DIA).toISOString())
    .or("situacao.is.null,situacao.eq.reclamacao").not("bloqueada", "is", true);

  const { data: lojas } = await supabase.from("lojas").select("id, marketplace");
  const mkDe = new Map((lojas ?? []).map((l: any) => [l.id, MK[l.marketplace] ?? l.marketplace]));
  const { data: motivos } = await supabase.from("devol_motivos_ml").select("codigo, rotulo");
  const rot = new Map((motivos ?? []).map((m: any) => [m.codigo, m.rotulo]));
  const cols = "loja_id, categoria, status, desfecho, motivo_original, valor_em_risco, valor_reembolsado, valor_pedido, custo_frete, prazo_em, arquivado_em, criado_em";
  const { data: sem } = await supabase.from("devol_casos").select(cols).gte("criado_em", ini7.toISOString()).limit(3000);
  const { count: semAnterior } = await supabase.from("devol_casos").select("id", { count: "exact", head: true }).gte("criado_em", ini14.toISOString()).lt("criado_em", ini7.toISOString());
  const { count: vencidos } = await supabase.from("devol_casos").select("id", { count: "exact", head: true })
    .in("status", ["NOVO", "AGUARDANDO_PROVAS", "EM_ANALISE", "PREPARADO"]).is("arquivado_em", null).lt("prazo_em", agora.toISOString());
  const casos = sem ?? [];
  return {
    periodo: `${ini7.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} a ${agora.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
    chats: { semana: a.data, semana_anterior: b.data, conversas_paradas_mais_2_dias_agora: paradas ?? 0,
      principais_motivos_para_chamar_pessoa: topo((escal ?? []).map((r: any) => String(r.motivo ?? "").replace(/^\[acolhimento\]\s*/, "").slice(0, 90)), 8) },
    devolucoes: {
      casos_novos_semana: casos.length, casos_novos_semana_anterior: semAnterior ?? 0,
      por_marketplace: topo(casos.map((c: any) => String(mkDe.get(c.loja_id) ?? "?")), 5),
      principais_motivos: topo(casos.map((c: any) => String(rot.get(c.motivo_original) ?? c.motivo_original ?? "sem motivo")), 6),
      categorias_da_analise_de_fotos: topo(casos.map((c: any) => String(c.categoria ?? "")), 6),
      desfechos: topo(casos.map((c: any) => String(c.desfecho ?? "sem desfecho")), 6),
      valor_em_risco: soma(casos, "valor_em_risco"), valor_reembolsado: soma(casos, "valor_reembolsado"), frete_de_devolucao: soma(casos, "custo_frete"),
      abertos_com_prazo_vencido_agora: vencidos ?? 0,
    },
  };
}

async function escrever(dados: any): Promise<string> {
  if (!OPENAI) throw new Error("OPENAI_API_KEY não cadastrada");
  const sistema = [
    "Você é a Sandy, atendente virtual da Sandstride (loja de tênis em Mercado Livre, Shopee e TikTok Shop). Escreva o RELATÓRIO SEMANAL de domingo para a equipe, no Telegram.",
    "Use SOMENTE os números fornecidos; nunca invente. Compare com a semana anterior quando houver dados (diga 'subiu', 'caiu', 'igual'). Se algo não vier nos dados, não cite.",
    "Não escreva título nem cabeçalho de relatório (já vai um no topo); comece direto na seção de chats. Português do Brasil, tom de colega de trabalho, direto. Texto simples, sem markdown (sem ** nem #). Pode usar 1 emoji por título de seção.",
    "Estrutura: 1) 💬 Chats: mensagens de clientes, quanto a Sandy respondeu sozinha, tempo mediano da primeira resposta (em horas e minutos, ex.: 1h44), pendentes e conversas paradas há mais de 2 dias, principais motivos de chamar uma pessoa. 2) 📦 Devoluções: casos novos, marketplace e motivos que mais aparecem, desfechos, valores em risco/reembolsados, prazos vencidos. 3) 🔧 Pontos a melhorar: de 3 a 5 itens numerados, concretos e acionáveis, ligados aos números (ex.: um motivo que se repete e que a Sandy poderia aprender a responder, um gargalo de tempo, um tipo de devolução evitável).",
    "No máximo 2.800 caracteres no total. Arredonde valores em reais (R$ 1.234). Termine sem pergunta e sem oferecer ajuda.",
  ].join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: MODELO, temperature: 0.4, max_tokens: 1200, messages: [{ role: "system", content: sistema }, { role: "user", content: `DADOS (${dados.periodo}):\n${JSON.stringify(dados)}` }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  if (j?.usage) {
    try { await supabase.rpc("sandy_registrar_uso", { p_origem: "relatorio", p_conversa: null, p_modelo: MODELO, p_entrada: j.usage.prompt_tokens ?? 0, p_cache: j.usage.prompt_tokens_details?.cached_tokens ?? 0, p_saida: j.usage.completion_tokens ?? 0 }); } catch (_) { /* ignora */ }
  }
  const t = String(j.choices?.[0]?.message?.content ?? "").trim();
  if (!t) throw new Error("resposta vazia do modelo");
  return `📊 RELATÓRIO SEMANAL · ${dados.periodo}\n\n${t}`.slice(0, 3900);
}

async function rodar(enviar: boolean) {
  try {
    const texto = await escrever(await coletar());
    if (!enviar) { await diag("relatorio-semanal", `SIMULAÇÃO:\n${texto}`); return; }
    const { data: cfg } = await supabase.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
    if (!cfg?.valor || !TOKEN) throw new Error("grupo ou token do Telegram não configurados");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ chat_id: cfg.valor, text: texto, disable_web_page_preview: true }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description ?? r.status}`);
    await diag("relatorio-semanal", "enviado");
  } catch (e) { await diag("relatorio-semanal", `erro: ${e instanceof Error ? e.message : e}`); }
}

Deno.serve(async (req) => {
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || (req.headers.get("x-lucro-token") ?? "") !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(rodar(!corpo.simular));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
