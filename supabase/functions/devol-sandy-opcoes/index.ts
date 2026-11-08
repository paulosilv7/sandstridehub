// Sandy das devoluções: lê a conversa com o mediador do Mercado Livre (opções para a loja ou pergunta de porcentagem), interpreta a situação,
// faz a conta de custo e sugere o que escolher. SÓ sugere: nunca responde ao marketplace. Mesmo modelo e chave da Sandy do chat.
// As regras de cálculo ficam em devol_config (chave sandy_opcoes_regras), para ajustar sem publicar a função de novo.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGEM = "devol-sandy-opcoes";
const API = "https://api.mercadolibre.com";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("SANDY_MODELO") ?? "gpt-4.1-mini";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function diag(m: string) { console.error(ORIGEM, m); try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: m.slice(0, 1500) }); } catch (_) { /* */ } }
async function cfg(k: string) { const { data } = await supabase.from("devol_config").select("valor").eq("chave", k).maybeSingle(); return data?.valor ?? null; }

const tokens = new Map<string, string | null>();
async function token(lojaId: string): Promise<string | null> {
  if (tokens.has(lojaId)) return tokens.get(lojaId)!;
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  let r: string | null = null;
  if (c && valido(c)) r = c.token_acesso;
  else if (c?.token_renovacao) {
    const resp = await fetch(`${API}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: c.token_renovacao }) });
    const t: any = await resp.json().catch(() => ({}));
    if (resp.ok) {
      await supabase.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
      r = t.access_token;
    } else { const { data: o } = await ler(); r = valido(o) ? o!.token_acesso : null; }
  }
  tokens.set(lojaId, r);
  return r;
}

const brl = (n: number) => "R$ " + n.toFixed(2).replace(".", ",");
const num = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));

function opcoesDaMensagem(texto: string) {
  const lista: { n: number; titulo: string; desc: string; pcts: number[]; valores: number[] }[] = [];
  for (const l of texto.split("\n")) {
    const m = l.match(/^\s*(\d+)\.\s*\*\*(.+?)\*\*\s*[—\-:]\s*(.+)$/);
    if (!m) continue;
    const desc = m[3];
    const pcts = [...desc.matchAll(/(\d{1,3}(?:,\d+)?)\s?%/g)].map((x) => Number(x[1].replace(",", ".")));
    const valores = [...desc.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((x) => num(x[1]));
    lista.push({ n: Number(m[1]), titulo: m[2].trim(), desc: desc.trim(), pcts, valores });
  }
  return lista;
}

// Percentual que o PRÓPRIO Mercado Livre sugeriu para o reembolso parcial nas mensagens anteriores (ex.: "devolve 5% do valor da venda").
function percentualDoML(textos: string[]): number | null {
  for (const t of textos) {
    for (const o of opcoesDaMensagem(t)) {
      if (/parcial/i.test(o.titulo + " " + o.desc) && o.pcts.length) return o.pcts[0];
    }
  }
  return null;
}

const ESQ = {
  name: "sugestao_resposta", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["situacao", "recomendada", "motivo", "comparacao", "alerta"],
    properties: {
      situacao: { type: "string", description: "PRIMEIRO interprete o que está acontecendo, em até 3 frases: motivo da reclamação, o que o comprador relatou, o que o Mercado Livre propôs ou pede agora (inclua valores e percentuais que o próprio ML citou) e o prazo, se houver." },
      recomendada: { type: "integer", description: "Número da opção (ou a porcentagem, quando a pergunta é de porcentagem) recomendada, exatamente como nas opções fornecidas" },
      motivo: { type: "string", description: "Depois da situação: até 3 frases curtas, com os números em reais, dizendo por que esta opção" },
      comparacao: { type: "array", items: { type: "object", additionalProperties: false, required: ["opcao", "custo_brl", "observacao"], properties: { opcao: { type: "integer" }, custo_brl: { type: ["number", "null"], description: "Custo estimado para a loja em reais, ou null se depender de dado que não temos" }, observacao: { type: "string" } } } },
      alerta: { type: "string", description: "Risco ou dado que falta para decidir melhor; vazio se não houver" },
    },
  },
};

const REGRAS_PADRAO = [
  "Você é a Sandy, analista de devoluções de uma loja de calçados e meias de Nova Serrana-MG que vende no Mercado Livre. Você SUGERE; quem decide e envia é o dono.",
  "Faça SEMPRE em dois passos: (1) interprete a situação no campo 'situacao', usando a conversa inteira; (2) só depois recomende. A recomendação precisa ser coerente com o que o Mercado Livre já disse na conversa. Nunca contradiga um número que o próprio ML citou sem uma razão clara escrita no motivo.",
  "Use SOMENTE os números fornecidos. Nunca invente preço, custo de produto, frete ou riscos que não estão nos dados. Se um custo depende de dado que não existe, use custo_brl null no campo numérico e, nos textos, escreva 'custo ainda não calculado'. NUNCA escreva a palavra null nos textos.",
  "REGRA DO DONO PARA AS CONTAS (siga exatamente): quando o produto VOLTA para a loja (devolução), o valor reembolsado ao comprador é recuperado porque o produto volta ao estoque e pode ser vendido de novo pelo mesmo valor. Portanto o CUSTO REAL da devolução é apenas o custo da etiqueta de devolução informado na mensagem. NUNCA some o valor do pedido ao custo da devolução. O risco da devolução é o produto voltar danificado ou sujo e perder valor de revenda; se o problema for defeito de fábrica, o dono pode pedir troca ao fornecedor, o que reduz a perda.",
  "Demais contas: reembolso total SEM devolução = perda de 100% do valor do pedido (o produto fica com o comprador). Reembolso parcial de X% = valor do pedido x X% (o comprador fica com o produto e, se aceitar, o caso fecha). Orientação ao comprador = custo zero agora, mas pode não resolver e a reclamação continuar.",
  "Opções em que a LOJA organiza o envio (enviar o item faltante, troca, entregar produto novo) NÃO são baratas por padrão: exigem transportadora ou entrega própria, pagar o item e o frete, tempo e risco de nova falha. {FRETE} Quando o reembolso parcial está disponível e o problema é pequeno ou o item faltante é barato, o parcial costuma compensar mais. Só recomende o envio pela loja se a conta mostrar claramente que é mais barato.",
  "Como escolher: compare o custo real. Se o produto pode voltar em boas condições e a etiqueta é menor que o reembolso parcial, a devolução costuma ser a melhor (custo só da etiqueta e o produto volta ao estoque). Se o reembolso parcial for menor ou igual à etiqueta e o problema for pequeno (ex.: acessório faltando, defeito leve), o parcial encerra o caso mais rápido e sem risco de dano na volta. Reembolso total sem devolução só se a devolução não for possível ou o produto não tiver valor de revenda.",
  "No motivo, cite pelo menos uma conta em reais da opção recomendada e de uma alternativa, e diga o risco principal da opção escolhida em uma frase. Escreva em português do Brasil, direto, como colega de trabalho. Valores no formato R$ 37,39.",
].join("\n");

const REGRA_PORCENTAGEM = "ESTA PERGUNTA É DE PORCENTAGEM: o mediador pergunta qual percentual de reembolso parcial a loja quer oferecer. As opções são os percentuais permitidos pelo Mercado Livre e 'recomendada' deve ser UM desses percentuais (o número). Quando o dado 'percentual_sugerido_pelo_ml' existir, esse é o percentual que o PRÓPRIO Mercado Livre apresentou na mensagem anterior como referência justa: recomende ESSE percentual, a menos que o motivo da reclamação mostre claramente que ele é pequeno demais ou exagerado, e nesse caso explique em uma frase a razão. Nunca recomende percentual maior ou menor sem essa explicação. Não invente risco de recusa: se citar risco, diga apenas que o comprador pode não aceitar e o caso continuar aberto.";

async function regras(frete: number | null, porcentagem: boolean) {
  const salvo = await cfg("sandy_opcoes_regras");
  const base = salvo && salvo.trim().length > 200 ? salvo : REGRAS_PADRAO;
  const f = frete != null ? `O dono informou que o frete próprio custa cerca de ${brl(frete)} por envio; use na conta.` : "O valor do frete próprio NÃO foi informado: não assuma que é barato.";
  return base.replace("{FRETE}", f) + (porcentagem ? "\n" + REGRA_PORCENTAGEM : "");
}

async function processar(caso: any, msg: any, anteriores: string[], frete: number | null) {
  let opcoes = opcoesDaMensagem(msg.texto);
  const tk = await token(caso.loja_id);
  let valor: number | null = null; let titulo = ""; let qtd = 1;
  if (tk && caso.pedido) {
    const r = await fetch(`${API}/orders/${caso.pedido}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
    if (r.ok) {
      const o: any = await r.json().catch(() => ({}));
      const it = o?.order_items?.[0];
      valor = Number(o?.total_amount ?? 0) || (it ? Number(it.unit_price) * Number(it.quantity ?? 1) : null);
      titulo = String(it?.item?.title ?? "").slice(0, 120); qtd = Number(it?.quantity ?? 1);
    }
  }
  let porcentagem = false;
  let pctML: number | null = null;
  if (!opcoes.length && /porcentagem|percentual/i.test(msg.texto) && tk) {
    pctML = percentualDoML(anteriores);
    const r = await fetch(`${API}/post-purchase/v1/claims/${caso.solicitacao_id}/partial-refund/available-offers`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      opcoes = (j?.available_offers ?? []).map((o: any) => ({ n: Number(o.percentage), titulo: `${o.percentage}%`, desc: `reembolso de ${brl(Number(o.amount))}`, pcts: [Number(o.percentage)], valores: [Number(o.amount)] }));
      const rec = (j?.recommendations ?? [])[0];
      if (rec?.percentage) pctML = pctML ?? Number(rec.percentage);
    }
    // O percentual que o próprio ML citou entra como opção mesmo que a API não o liste (a resposta vai por mensagem ao mediador).
    if (pctML != null && !opcoes.some((o) => o.n === pctML)) {
      opcoes.unshift({ n: pctML, titulo: `${pctML}%`, desc: `sugerido pelo próprio Mercado Livre${valor != null ? `: reembolso de ${brl(valor * pctML / 100)}` : ""}`, pcts: [pctML], valores: valor != null ? [Number((valor * pctML / 100).toFixed(2))] : [] });
    }
    porcentagem = opcoes.length > 0;
  }
  if (!opcoes.length) {
    await supabase.from("devol_sugestoes").upsert({ caso_id: caso.id, mensagem_chave: msg.chave, recomendada: null, situacao: null, pct_ml: null, motivo: "A mensagem do Mercado Livre não traz opções para escolher. Responda com o campo de texto ou pelo painel.", comparacao: [], alerta: null, valor_pedido: valor, modelo: MODELO, criado_em: new Date().toISOString() }, { onConflict: "caso_id" });
    return;
  }
  const fatos = opcoes.map((o) => ({ opcao: o.n, titulo: o.titulo, descricao: o.desc, percentuais_citados: o.pcts, valores_citados_brl: o.valores, custo_do_percentual_brl: valor && o.pcts[0] ? Number((valor * o.pcts[0] / 100).toFixed(2)) : null }));
  const hist = anteriores.length ? `\n\nMENSAGENS ANTERIORES DO MEDIADOR (da mais recente para a mais antiga; a etiqueta de devolução, o problema relatado e o percentual que o ML citou podem estar aqui):\n${anteriores.join("\n---\n").slice(0, 3000)}` : "";
  const extra = pctML != null ? `\npercentual_sugerido_pelo_ml: ${pctML}% (${valor != null ? brl(valor * pctML / 100) : "valor desconhecido"})` : "";
  const usuario = `Motivo da reclamação: ${caso.motivo_original ?? "não informado"}. Produto: ${titulo || "não informado"} (qtd ${qtd}). Valor do pedido: ${valor != null ? brl(valor) : "desconhecido"}.${extra}\n\nMENSAGEM ATUAL DO MEDIADOR (texto original):\n${msg.texto}${hist}\n\nOPÇÕES E NÚMEROS JÁ EXTRAÍDOS (confie nestes cálculos):\n${JSON.stringify(fatos)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: MODELO, temperature: 0.2, max_tokens: 800, response_format: { type: "json_schema", json_schema: ESQ }, messages: [{ role: "system", content: await regras(frete, porcentagem) }, { role: "user", content: usuario }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 160)}`);
  if (j?.usage) { try { await supabase.rpc("sandy_registrar_uso", { p_origem: "devolucao_opcoes", p_conversa: null, p_modelo: MODELO, p_entrada: j.usage.prompt_tokens ?? 0, p_cache: j.usage.prompt_tokens_details?.cached_tokens ?? 0, p_saida: j.usage.completion_tokens ?? 0 }); } catch (_) { /* */ } }
  const s = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
  const limpa = (t: any) => String(t ?? "").replace(/\(null\)/gi, "").replace(/\bnull\b/gi, "ainda não calculado");
  const validos = new Set(opcoes.map((o) => o.n));
  let rec = validos.has(Number(s.recomendada)) ? Number(s.recomendada) : null;
  let alerta = limpa(s.alerta).slice(0, 300);
  // Trava no código: em pergunta de porcentagem, o percentual do próprio ML é o padrão; sair dele exige justificativa no motivo.
  if (porcentagem && pctML != null && validos.has(pctML) && rec !== pctML) {
    const justificou = /pequen|exager|insuficiente|baixo demais|alto demais|grave|leve/i.test(String(s.motivo ?? ""));
    if (!justificou) { rec = pctML; alerta = (alerta ? alerta + " " : "") + `Mantive ${pctML}%, o percentual que o próprio Mercado Livre apresentou.`; }
  }
  const comp = (Array.isArray(s.comparacao) ? s.comparacao : []).filter((c: any) => validos.has(Number(c.opcao))).map((c: any) => ({ opcao: Number(c.opcao), custo_brl: typeof c.custo_brl === "number" ? c.custo_brl : null, observacao: limpa(c.observacao).slice(0, 200) }));
  await supabase.from("devol_sugestoes").upsert({ caso_id: caso.id, mensagem_chave: msg.chave, recomendada: rec, situacao: limpa(s.situacao).slice(0, 600) || null, pct_ml: pctML, motivo: limpa(s.motivo).slice(0, 600), comparacao: comp, alerta: alerta || null, valor_pedido: valor, modelo: MODELO, criado_em: new Date().toISOString() }, { onConflict: "caso_id" });
}

async function executar() {
  try {
    if ((await cfg("kill_switch")) === "true" || (await cfg("ia_ativa")) !== "true") return;
    const f = Number(String((await cfg("custo_envio_proprio_brl")) ?? "").replace(",", "."));
    const frete = Number.isFinite(f) && f > 0 ? f : null;
    const { data: lojas } = await supabase.from("lojas").select("id").eq("marketplace", "mercado_livre");
    const ids = (lojas ?? []).map((l: any) => l.id);
    const { data: casos } = await supabase.from("devol_casos").select("id, loja_id, solicitacao_id, pedido, motivo_original, acoes_loja, prazo_em, status").in("loja_id", ids).not("prazo_em", "is", null).not("status", "in", "(DECIDIDO,CREDITO_PENDENTE,CONCILIADO,ENCERRADO)");
    let feitos = 0;
    for (const c of casos ?? []) {
      if (feitos >= 8 || !(c.acoes_loja ?? []).length) continue;
      const { data: ms } = await supabase.from("devol_mensagens").select("chave, texto, enviado_em").eq("caso_id", c.id).eq("origem", "mediador").order("enviado_em", { ascending: false }).limit(4);
      const msg = ms?.[0];
      if (!msg) continue;
      const { data: ja } = await supabase.from("devol_sugestoes").select("mensagem_chave").eq("caso_id", c.id).maybeSingle();
      if (ja?.mensagem_chave === msg.chave) continue;
      try { await processar(c, msg, (ms ?? []).slice(1).map((m: any) => m.texto), frete); feitos++; } catch (e) { await diag(`erro no caso ${c.id}: ${e instanceof Error ? e.message : e}`); }
    }
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : String(e)}`); }
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  EdgeRuntime.waitUntil(executar());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
