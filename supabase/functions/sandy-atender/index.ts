// Sandy: atende sozinha as perguntas simples dos clientes e passa o resto para a equipe.
// Chamada pelo banco quando chega mensagem de cliente (e por uma varredura a cada 5 minutos).
// Só age se a chave geral e a loja estiverem ligadas na tela da Sandy. Cabeçalho x-lucro-token.
// Modos: {conversa_id}                  atendimento normal
//        {conversa_id, simular: true}   mostra o que faria, sem enviar nada e sem alterar a conversa
//        {ping: true}                   testa a chave da OpenAI
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const CHAVE_SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("SANDY_MODELO") ?? "gpt-4.1-mini";
const supabase = createClient(URL_BASE, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });

const ESPERA_SEGUNDOS = 20; // junta mensagens seguidas do cliente antes de responder
const MAX_RESPOSTAS_24H = 3; // depois disso, passa para uma pessoa
const JANELA_MIN = 30; // só atende mensagens recentes (nunca histórico importado)
const SEM_ENVIO = ["cancelado", "devolucao", "devolvido", "analise_ml"];
const RESPONDER: Record<string, string> = { mercado_livre: "ml-responder", shopee: "shopee-responder", tiktok_shop: "tiktok-responder" };

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---------------------------------------------------------------------
// Usuário da Sandy (para enviar pelas mesmas funções da equipe)
// ---------------------------------------------------------------------
async function usuarioSandy(): Promise<string> {
  const { data: c } = await supabase.from("configuracoes").select("valor").eq("chave", "sandy_usuario_id").maybeSingle();
  if (c?.valor) return c.valor;
  const email = "sandy.atendente@sandstride.local";
  let id: string | null = null;
  const { data: novo, error } = await supabase.auth.admin.createUser({
    email, password: crypto.randomUUID() + crypto.randomUUID(), email_confirm: true, user_metadata: { nome: "Sandy" },
  });
  if (novo?.user) id = novo.user.id;
  else {
    const { data: lista } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    id = lista?.users?.find((u: any) => u.email === email)?.id ?? null;
    if (!id) throw new Error(`não consegui criar o usuário da Sandy: ${error?.message}`);
  }
  await supabase.from("equipe").upsert({ usuario_id: id, nome: "Sandy", papel: "atendente" }, { onConflict: "usuario_id" });
  await supabase.from("configuracoes").upsert({ chave: "sandy_usuario_id", valor: id }, { onConflict: "chave" });
  return id!;
}
async function jwtSandy(): Promise<string> {
  const id = await usuarioSandy();
  const { data: u } = await supabase.auth.admin.getUserById(id);
  const email = u?.user?.email;
  if (!email) throw new Error("usuário da Sandy sem e-mail");
  const { data: l, error: e1 } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
  if (e1 || !l?.properties?.hashed_token) throw new Error(`link da Sandy: ${e1?.message}`);
  // Cliente separado: assim a sessão da Sandy não troca as permissões do cliente principal.
  const outro = createClient(URL_BASE, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e2 } = await outro.auth.verifyOtp({ token_hash: l.properties.hashed_token, type: "magiclink" });
  if (e2 || !s?.session?.access_token) throw new Error(`sessão da Sandy: ${e2?.message}`);
  return s.session.access_token;
}

// ---------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------
const ESQUEMA = {
  name: "decisao_sandy",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["acao", "resposta", "motivo"],
    properties: {
      acao: { type: "string", enum: ["responder", "escalar"] },
      resposta: { type: "string", description: "Texto para o cliente. Vazio se a ação for escalar." },
      motivo: { type: "string", description: "Em uma frase curta, para a equipe: por que respondeu ou por que passou para uma pessoa." },
    },
  },
};

function instrucoes(ctx: any): string {
  return [
    `Você é a Sandy, atendente virtual da loja "${ctx.loja}" no ${ctx.marketplace}. Responde em português do Brasil, com educação, calor humano e objetividade.`,
    "REGRAS:",
    "1. Use SOMENTE as informações da seção BASE DE CONHECIMENTO e os dados do pedido/anúncio fornecidos. Nunca invente prazos, preços, estoque, políticas, medidas ou características.",
    "2. Se a resposta não estiver nessas informações, ou você tiver qualquer dúvida, escolha acao=escalar. Errar para o lado de escalar é sempre melhor do que arriscar.",
    "3. Escale SEMPRE quando o cliente: pedir reembolso, devolução, troca, cancelamento, indenização; relatar defeito, produto errado, atraso grave ou não recebimento; estiver irritado, ameaçar ou reclamar; pedir para falar com uma pessoa; mandar algo que você não entende.",
    "4. Nunca prometa reembolso, troca, desconto, brinde ou prazo que não esteja na base. Nunca peça nem passe telefone, e-mail, link, WhatsApp ou qualquer contato fora da plataforma (o marketplace proíbe).",
    "5. Mensagem curta: até 4 frases, sem listas, sem markdown, no máximo 1 emoji. Cumprimente pelo primeiro nome apenas se ainda não houve resposta da loja nesta conversa.",
    "6. Se o cliente apenas agradecer ou se despedir, responda de forma breve e cordial (acao=responder).",
    "7. Responda a pergunta que o cliente fez agora, sem repetir o que já foi dito antes.",
  ].join("\n");
}

async function perguntarAoModelo(ctx: any): Promise<{ acao: string; resposta: string; motivo: string }> {
  if (!OPENAI) throw new Error("OPENAI_API_KEY não cadastrada nos Segredos do Supabase");
  const base = ctx.conhecimento.length
    ? ctx.conhecimento.map((k: any) => `### ${k.titulo}\n${k.texto}`).join("\n\n")
    : "(vazia)";
  const dados = [
    `Primeiro nome do cliente: ${ctx.primeiroNome}`,
    ctx.produto ? `Anúncio/produto: ${ctx.produto}` : null,
    ctx.pedido ? `Dados do pedido: ${JSON.stringify(ctx.pedido)}` : "Sem pedido associado (pergunta antes da compra).",
    ctx.situacao ? `Situação: ${ctx.situacao}` : null,
    `A loja já respondeu nesta conversa: ${ctx.jaRespondeu ? "sim" : "não"}`,
  ].filter(Boolean).join("\n");
  const historico = ctx.mensagens.map((m: any) => `${m.de === "cliente" ? "CLIENTE" : "LOJA"}: ${m.texto}`).join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: MODELO,
      temperature: 0.3,
      max_tokens: 400,
      response_format: { type: "json_schema", json_schema: ESQUEMA },
      messages: [
        { role: "system", content: instrucoes(ctx) },
        { role: "user", content: `BASE DE CONHECIMENTO:\n${base}\n\nDADOS:\n${dados}\n\nCONVERSA (mais recente por último):\n${historico}\n\nDecida agora.` },
      ],
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  const bruto = j?.choices?.[0]?.message?.content;
  const d = JSON.parse(bruto ?? "{}");
  if (!["responder", "escalar"].includes(d.acao)) throw new Error("resposta do modelo fora do formato");
  return { acao: d.acao, resposta: String(d.resposta ?? "").trim(), motivo: String(d.motivo ?? "").trim() };
}

// ---------------------------------------------------------------------
// Decisão
// ---------------------------------------------------------------------
async function registrar(conversaId: string, decisao: string, motivo: string | null, resposta: string | null, simular: boolean) {
  if (simular) return;
  await supabase.from("sandy_registros").insert({ conversa_id: conversaId, decisao, motivo: motivo?.slice(0, 500) ?? null, resposta: resposta?.slice(0, 1500) ?? null, modelo: MODELO });
}
async function escalar(conversaId: string, motivo: string, simular: boolean) {
  if (simular) return;
  await supabase.from("conversas").update({ escalada_motivo: motivo.slice(0, 300), atendida_por_ia: false }).eq("id", conversaId);
  await registrar(conversaId, "escalou", motivo, null, false);
}

// Verifica se o texto da Sandy é seguro de enviar.
function textoSeguro(t: string): string | null {
  if (!t) return "resposta vazia";
  if (t.length > 700) return "resposta longa demais";
  if (/https?:\/\/|www\.|\.com\b|@\w|\b\d{8,}\b|whats/i.test(t)) return "resposta com contato ou link externo";
  return null;
}

async function atender(conversaId: string, simular: boolean, textoTeste?: string): Promise<any> {
  const saida: any = { conversa: conversaId, simular };

  const { data: cfg } = await supabase.from("configuracoes").select("chave, valor").in("chave", ["sandy_ativa", "sandy_escalar_palavras"]);
  const c = Object.fromEntries((cfg ?? []).map((x: any) => [x.chave, x.valor]));
  const { data: conv } = await supabase.from("conversas")
    .select("id, loja_id, tipo, cliente_nome, produto_titulo, dados_extras, situacao, bloqueada, atendente_id, ultima_mensagem_em, ultima_mensagem_de, sandy_trava_em, lojas(nome, marketplace, sandy_ativa)")
    .eq("id", conversaId).maybeSingle();
  if (!conv) return { ...saida, resultado: "conversa não encontrada" };
  const loja: any = Array.isArray(conv.lojas) ? conv.lojas[0] : conv.lojas;

  if (!simular) {
    if (c.sandy_ativa !== "true") return { ...saida, resultado: "Sandy desligada" };
    if (!loja?.sandy_ativa) return { ...saida, resultado: "Sandy desligada nesta loja" };
    if (conv.atendente_id) return { ...saida, resultado: "uma pessoa está atendendo" };
    if (conv.bloqueada) return { ...saida, resultado: "conversa bloqueada" };
    if (conv.situacao && SEM_ENVIO.includes(conv.situacao)) return { ...saida, resultado: "marketplace não aceita mensagens" };
    if (conv.ultima_mensagem_de !== "cliente") return { ...saida, resultado: "a última mensagem não é do cliente" };
    if (!conv.ultima_mensagem_em || Date.now() - new Date(conv.ultima_mensagem_em).getTime() > JANELA_MIN * 60_000) return { ...saida, resultado: "mensagem antiga demais" };
    if (!RESPONDER[loja.marketplace]) return { ...saida, resultado: "marketplace sem envio" };
    // Trava para duas execuções não responderem a mesma conversa ao mesmo tempo.
    const limite = new Date(Date.now() - 2 * 60_000).toISOString();
    const { data: trava } = await supabase.from("conversas").update({ sandy_trava_em: new Date().toISOString() })
      .eq("id", conversaId).or(`sandy_trava_em.is.null,sandy_trava_em.lt.${limite}`).select("id");
    if (!trava?.length) return { ...saida, resultado: "já em atendimento" };
  }

  try {
    // Mensagens da conversa
    const { data: msgs } = await supabase.from("mensagens").select("id, de, texto, anexos, enviada_em, enviada_por_ia")
      .eq("conversa_id", conversaId).order("enviada_em", { ascending: false }).limit(14);
    let ordem = (msgs ?? []).slice().reverse();
    let ultimaLoja = [...ordem].reverse().find((m: any) => m.de === "loja");
    let novas = ordem.filter((m: any) => m.de === "cliente" && (!ultimaLoja || m.enviada_em > ultimaLoja.enviada_em));
    // Teste: avalia uma frase avulsa de cliente como se fosse a única mensagem da conversa.
    if (simular && textoTeste) {
      novas = [{ de: "cliente", texto: textoTeste, anexos: [], enviada_em: new Date().toISOString() }];
      ordem = [...novas]; ultimaLoja = undefined;
    }
    if (!novas.length) return { ...saida, resultado: "sem mensagem nova do cliente" };

    // Se chegou mensagem depois da espera, deixa a execução mais nova cuidar.
    const textoNovo = novas.map((m: any) => m.texto ?? "").join(" \n ");

    // 1. Regras fixas (sem gastar com o modelo)
    if (novas.some((m: any) => Array.isArray(m.anexos) && m.anexos.length)) {
      const motivo = "Cliente enviou foto ou arquivo. Uma pessoa precisa ver.";
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    const palavras = String(c.sandy_escalar_palavras ?? "").split(",").map((p) => norm(p.trim())).filter(Boolean);
    const alvo = norm(textoNovo);
    const achada = palavras.find((p) => alvo.includes(p));
    if (achada) {
      const motivo = `Assunto sensível (“${achada}”). Uma pessoa precisa responder.`;
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    const { count } = await supabase.from("sandy_registros").select("id", { count: "exact", head: true })
      .eq("conversa_id", conversaId).eq("decisao", "respondeu").gt("criado_em", new Date(Date.now() - 24 * 3600_000).toISOString());
    if ((count ?? 0) >= MAX_RESPOSTAS_24H) {
      const motivo = "A Sandy já respondeu várias vezes hoje nesta conversa. Uma pessoa deve continuar.";
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }

    // 2. Modelo
    const { data: base } = await supabase.from("sandy_conhecimento").select("titulo, texto, escopo").eq("ativo", true);
    const conhecimento = (base ?? []).filter((k: any) => k.escopo === "todas" || k.escopo === loja.marketplace);
    const rotulo: Record<string, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop" };
    const de = conv.dados_extras ?? {};
    const pedido = de?.tipo === "pedido" ? { status: de.status, envio: de.envio, item: de.item, total: de.total, feito_em: de.feito_em } : null;
    const ctx = {
      loja: loja.nome, marketplace: rotulo[loja.marketplace] ?? loja.marketplace,
      primeiroNome: String(conv.cliente_nome ?? "").trim().split(/\s+/)[0] || "cliente",
      produto: conv.produto_titulo, pedido, situacao: conv.situacao, jaRespondeu: !!ultimaLoja, conhecimento,
      mensagens: ordem.filter((m: any) => m.texto).map((m: any) => ({ de: m.de, texto: String(m.texto).slice(0, 600) })),
    };
    let d;
    try { d = await perguntarAoModelo(ctx); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await diag("sandy-atender", `erro no modelo: ${msg}`);
      await registrar(conversaId, "erro", msg, null, simular);
      if (!simular) await escalar(conversaId, "A Sandy não conseguiu analisar esta conversa. Uma pessoa precisa responder.", false);
      return { ...saida, decisao: "erro", motivo: msg };
    }
    saida.modelo = d;
    if (d.acao === "escalar") {
      const motivo = d.motivo || "A Sandy não tem certeza da resposta.";
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    const problema = textoSeguro(d.resposta);
    if (problema) {
      const motivo = `A resposta da Sandy foi barrada (${problema}). Uma pessoa precisa responder.`;
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo, bloqueada: d.resposta };
    }
    if (simular) return { ...saida, decisao: "responderia", resposta: d.resposta, motivo: d.motivo };

    // 3. Confere de novo antes de enviar: alguém pode ter assumido nesse meio tempo.
    const { data: agora } = await supabase.from("conversas").select("atendente_id, ultima_mensagem_de, ultima_mensagem_em").eq("id", conversaId).maybeSingle();
    if (agora?.atendente_id || agora?.ultima_mensagem_de !== "cliente" || agora?.ultima_mensagem_em !== conv.ultima_mensagem_em) {
      return { ...saida, resultado: "a conversa mudou durante a análise; não enviei" };
    }

    // 4. Envio pelo mesmo caminho da equipe
    const jwt = await jwtSandy();
    const r = await fetch(`${URL_BASE}/functions/v1/${RESPONDER[loja.marketplace]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: CHAVE_SERVICO },
      body: JSON.stringify({ conversa_id: conversaId, texto: d.resposta }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const motivo = `Não consegui enviar: ${String(j.erro ?? r.status).slice(0, 200)}`;
      await registrar(conversaId, "erro", motivo, d.resposta, false);
      await escalar(conversaId, `A Sandy não conseguiu enviar a resposta (${String(j.erro ?? r.status).slice(0, 120)}). Uma pessoa precisa responder.`, false);
      return { ...saida, decisao: "erro", motivo };
    }
    // A mensagem aparece como da Sandy e a conversa fica com ela (a equipe pode assumir a qualquer momento).
    if (j.mensagem_id) await supabase.from("mensagens").update({ enviada_por_ia: true, enviada_por: null }).eq("id", j.mensagem_id);
    await supabase.from("conversas").update({ atendente_id: null, atendida_por_ia: true, escalada_motivo: null }).eq("id", conversaId);
    await registrar(conversaId, "respondeu", d.motivo, d.resposta, false);
    return { ...saida, decisao: "respondeu", resposta: d.resposta };
  } finally {
    if (!simular) await supabase.from("conversas").update({ sandy_trava_em: null }).eq("id", conversaId);
  }
}

async function executar(conversaId: string, simular: boolean, esperar: boolean, textoTeste?: string) {
  try {
    if (esperar) await dormir(ESPERA_SEGUNDOS * 1000);
    const r = await atender(conversaId, simular, textoTeste);
    if (textoTeste) r.pergunta = textoTeste;
    if (simular || r.decisao === "erro") await diag(simular ? "sandy-simulacao" : "sandy-atender", JSON.stringify(r));
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await diag("sandy-atender", `erro inesperado: ${msg}`);
    return { erro: msg };
  }
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));

  if (corpo.ping) {
    try {
      if (!OPENAI) throw new Error("OPENAI_API_KEY não cadastrada");
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` },
        body: JSON.stringify({ model: MODELO, max_tokens: 5, messages: [{ role: "user", content: "Responda apenas: ok" }] }),
      });
      const j: any = await r.json().catch(() => ({}));
      await diag("sandy-ping", r.ok ? `ok (${MODELO}): ${j?.choices?.[0]?.message?.content}` : `falhou ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
    } catch (e) { await diag("sandy-ping", `falhou: ${e instanceof Error ? e.message : e}`); }
    return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
  }

  const conversaId = String(corpo.conversa_id ?? "");
  if (!conversaId) return new Response(JSON.stringify({ ok: false, erro: "conversa_id obrigatório" }), { status: 400 });
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(executar(conversaId, !!corpo.simular, !corpo.simular && !corpo.sem_espera, corpo.simular && corpo.texto_teste ? String(corpo.texto_teste).slice(0, 800) : undefined));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
