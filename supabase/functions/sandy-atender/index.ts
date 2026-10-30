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
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const ML_API = "https://api.mercadolibre.com";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("SANDY_MODELO") ?? "gpt-4.1-mini";
const supabase = createClient(URL_BASE, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });

const ESPERA_MIN_SEG = 30; // nunca responde na hora: espera entre 30 s e 60 s (também junta mensagens seguidas)
const ESPERA_MAX_SEG = 60;
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
// Ficha do anúncio (dados reais da API do Mercado Livre: descrição, atributos, tamanhos e cores)
// ---------------------------------------------------------------------
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) return cred.token_acesso;
  if (!cred?.token_renovacao) return null;
  const resp = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: cred.token_renovacao }),
  });
  const t: any = await resp.json().catch(() => ({}));
  if (resp.ok) {
    await supabase.from("credenciais_lojas").update({
      token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
      expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
    }).eq("loja_id", lojaId);
    return t.access_token;
  }
  const { data: outra } = await ler();
  return valido(outra) ? outra!.token_acesso : null;
}
async function chamarML(caminho: string, token: string | null): Promise<any> {
  const r = await fetch(`${ML_API}${caminho}`, {
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ML ${r.status} em ${caminho}`);
  return await r.json();
}
// Devolve só o que ajuda a responder; nunca quantidades de estoque (apenas disponível sim/não).
async function fichaDoAnuncio(lojaId: string, marketplace: string, extras: any): Promise<any | null> {
  if (marketplace !== "mercado_livre") return null;
  const itemId = String(extras?.item_id ?? extras?.item?.id ?? "").trim();
  if (!/^MLB\d+$/i.test(itemId)) return null;
  try {
    const token = await tokenML(lojaId);
    const [it, ds] = await Promise.all([
      chamarML(`/items/${itemId}`, token),
      chamarML(`/items/${itemId}/description`, token).catch(() => null),
    ]);
    const ignorar = /gtin|sku|codigo|código|condi/i;
    const atributos = (it.attributes ?? []).filter((a: any) => a.value_name && !ignorar.test(`${a.id} ${a.name}`)).slice(0, 30).map((a: any) => `${a.name}: ${a.value_name}`);
    const variacoes = (it.variations ?? []).slice(0, 60).map((v: any) => ({
      opcoes: (v.attribute_combinations ?? []).map((a: any) => `${a.name}: ${a.value_name}`).join(", "),
      disponivel: Number(v.available_quantity ?? 0) > 0 ? "sim" : "não",
    }));
    return {
      titulo: it.title, status_do_anuncio: it.status, preco: it.price,
      disponivel: variacoes.length ? undefined : (Number(it.available_quantity ?? 0) > 0 ? "sim" : "não"),
      atributos, variacoes_tamanho_cor: variacoes.length ? variacoes : "o anúncio não tem variações (tamanho e cor são os do título)",
      descricao: String(ds?.plain_text ?? "").replace(/\s+/g, " ").trim().slice(0, 1500) || undefined,
    };
  } catch (e) {
    await diag("sandy-atender", `ficha do anúncio ${itemId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// Acolhimento: pedido errado, cancelamento, devolução (texto fixo, aprovado pelo Paulo)
// ---------------------------------------------------------------------
function montarAcolhimento(nome: string, tom: string, jaRespondeu: boolean): string {
  const nomeOk = /^[A-Za-zÀ-ÿ]{2,20}$/.test(nome) ? nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase() : "";
  const partes = [
    `${nomeOk && !jaRespondeu ? `Olá, ${nomeOk}! ` : ""}Sentimos muito pela situação.`,
    "Essa não é a experiência que queremos proporcionar aos nossos clientes.",
    "Você tem direito à devolução gratuita do seu pedido.",
    "Nossa equipe vai te acompanhar por aqui nos próximos passos.",
  ];
  if (tom === "calmo") partes.push("Se depois do reembolso você quiser comprar conosco novamente, vamos redobrar a nossa atenção com o seu pedido.");
  return partes.join(" ");
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
    required: ["acao", "resposta", "motivo", "tom", "nome"],
    properties: {
      acao: { type: "string", enum: ["responder", "acolher", "escalar"] },
      resposta: { type: "string", description: "Texto para o cliente. Vazio se a ação for escalar ou acolher." },
      tom: { type: "string", enum: ["calmo", "irritado"], description: "calmo SOMENTE se o cliente for educado e tranquilo. irritado se houver reclamação enfática, exigência, ironia, palavrão, caixa alta, exclamações, ofensa ou ameaça. Na dúvida, irritado." },
      nome: { type: "string", description: "Primeiro nome do cliente se for nome de pessoa de verdade; vazio se for apelido, usuário com números ou sem cara de nome." },
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
    "3. Use acao=acolher quando o cliente disser que recebeu pedido errado, diferente do anúncio ou com defeito, ou quiser cancelar, devolver ou ser reembolsado. Nesse caso não escreva resposta (o texto de acolhimento é montado pelo sistema); preencha tom e nome. Escale (acao=escalar) quando o cliente: pedir troca de tamanho/cor ou indenização; relatar atraso grave ou não recebimento; ameaçar ou reclamar de forma geral; pedir para falar com uma pessoa; mandar algo que você não entende.",
    "4. Nunca prometa reembolso, troca, desconto, brinde ou prazo que não esteja na base. Nunca peça nem passe telefone, e-mail, link, WhatsApp ou qualquer contato fora da plataforma (o marketplace proíbe).",
    "5. Mensagem curta: até 4 frases, sem listas, sem markdown, no máximo 1 emoji. Cumprimente pelo primeiro nome apenas se ainda não houve resposta da loja nesta conversa.",
    "6. Se o cliente apenas agradecer ou se despedir, responda de forma breve e cordial (acao=responder).",
    "7. Responda a pergunta que o cliente fez agora, sem repetir o que já foi dito antes.",
    "8. Se existir FICHA DO ANÚNCIO nos dados, ela é a fonte para descrição, material, gênero, tamanhos e cores. Só confirme um tamanho ou cor se ele aparecer em variacoes_tamanho_cor com disponivel=sim (ou, em anúncio sem variações, se for o do título e disponivel=sim). Se não aparecer, estiver indisponível, ou não houver ficha, escale. Nunca informe quantidade em estoque.",
  ].join("\n");
}

async function perguntarAoModelo(ctx: any): Promise<{ acao: string; resposta: string; motivo: string; tom: string; nome: string }> {
  if (!OPENAI) throw new Error("OPENAI_API_KEY não cadastrada nos Segredos do Supabase");
  const base = ctx.conhecimento.length
    ? ctx.conhecimento.map((k: any) => `### ${k.titulo}\n${k.texto}`).join("\n\n")
    : "(vazia)";
  const dados = [
    `Primeiro nome do cliente: ${ctx.primeiroNome}`,
    ctx.produto ? `Anúncio/produto: ${ctx.produto}` : null,
    ctx.pedido ? `Dados do pedido: ${JSON.stringify(ctx.pedido)}` : "Sem pedido associado (pergunta antes da compra).",
    ctx.ficha ? `FICHA DO ANÚNCIO (dados reais do marketplace): ${JSON.stringify(ctx.ficha)}` : "Sem ficha do anúncio disponível.",
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
  if (!["responder", "acolher", "escalar"].includes(d.acao)) throw new Error("resposta do modelo fora do formato");
  return { acao: d.acao, resposta: String(d.resposta ?? "").trim(), motivo: String(d.motivo ?? "").trim(), tom: d.tom === "irritado" ? "irritado" : "calmo", nome: String(d.nome ?? "").trim() };
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

  const { data: cfg } = await supabase.from("configuracoes").select("chave, valor").in("chave", ["sandy_ativa", "sandy_escalar_palavras", "sandy_graves_palavras", "sandy_acolher_palavras"]);
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
    const lista = (k: string) => String(c[k] ?? "").split(",").map((p) => norm(p.trim())).filter(Boolean);
    const alvo = norm(textoNovo);
    const grave = lista("sandy_graves_palavras").find((p) => alvo.includes(p));
    if (grave) {
      const motivo = `Assunto grave (“${grave}”). Uma pessoa precisa responder.`;
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    const gatilhoAcolher = lista("sandy_acolher_palavras").find((p) => alvo.includes(p));
    if (!gatilhoAcolher) {
      if (novas.some((m: any) => Array.isArray(m.anexos) && m.anexos.length)) {
        const motivo = "Cliente enviou foto ou arquivo. Uma pessoa precisa ver.";
        await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
      }
      const achada = lista("sandy_escalar_palavras").find((p) => alvo.includes(p));
      if (achada) {
        const motivo = `Assunto sensível (“${achada}”). Uma pessoa precisa responder.`;
        await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
      }
    }
    // Já acolheu este cliente nas últimas 24 h: o caso está com a equipe, a Sandy não continua.
    const { count: acolhimentos } = await supabase.from("sandy_registros").select("id", { count: "exact", head: true })
      .eq("conversa_id", conversaId).eq("decisao", "respondeu").like("motivo", "[acolhimento]%").gt("criado_em", new Date(Date.now() - 24 * 3600_000).toISOString());
    if ((acolhimentos ?? 0) > 0) {
      const motivo = "A Sandy já acolheu o cliente (pedido errado/cancelamento/devolução). Uma pessoa precisa dar andamento.";
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
    const ficha = await fichaDoAnuncio(conv.loja_id, loja.marketplace, de);
    const ctx = {
      ficha,
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
    if (simular) saida.ficha = ficha ? JSON.stringify(ficha).slice(0, 700) : null;
    if (d.acao === "escalar") {
      const motivo = d.motivo || "A Sandy não tem certeza da resposta.";
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    // Palavra de pedido errado/cancelamento/devolução: nunca vai como resposta comum.
    if (gatilhoAcolher && d.acao === "responder") {
      const motivo = `Assunto de pedido errado/cancelamento/devolução (“${gatilhoAcolher}”). Uma pessoa precisa responder.`;
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo };
    }
    const acolhendo = d.acao === "acolher";
    if (acolhendo) {
      // Segurança extra: palavras de raiva ou texto em caixa alta contam como cliente irritado (não oferece nova compra).
      const letras = textoNovo.replace(/[^A-Za-zÀ-ÿ]/g, "");
      const caixaAlta = letras.length >= 15 && letras.replace(/[^A-ZÀ-Ý]/g, "").length / letras.length > 0.6;
      const raiva = /absurd|pessim|vergonha|ridicul|inadmiss|lixo|palhacada|horrivel|nunca mais|exijo|cansad|ja pedi|toda hora|!{2,}/.test(alvo);
      if (caixaAlta || raiva) d.tom = "irritado";
      d.resposta = montarAcolhimento(d.nome, d.tom, ctx.jaRespondeu);
    }
    const problema = textoSeguro(d.resposta);
    if (problema) {
      const motivo = `A resposta da Sandy foi barrada (${problema}). Uma pessoa precisa responder.`;
      await escalar(conversaId, motivo, simular); return { ...saida, decisao: "escalou", motivo, bloqueada: d.resposta };
    }
    if (simular) return { ...saida, decisao: acolhendo ? "acolheria" : "responderia", resposta: d.resposta, motivo: d.motivo };

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
    if (acolhendo) {
      // Acolheu o cliente e passa para uma pessoa dar andamento (aparece como precisando de atenção).
      await supabase.from("conversas").update({ atendente_id: null, atendida_por_ia: false, escalada_motivo: "A Sandy acolheu o cliente (pedido errado, cancelamento ou devolução). Uma pessoa precisa dar andamento." }).eq("id", conversaId);
      await registrar(conversaId, "respondeu", `[acolhimento] ${d.motivo}`, d.resposta, false);
      return { ...saida, decisao: "acolheu", resposta: d.resposta };
    }
    await supabase.from("conversas").update({ atendente_id: null, atendida_por_ia: true, escalada_motivo: null }).eq("id", conversaId);
    await registrar(conversaId, "respondeu", d.motivo, d.resposta, false);
    return { ...saida, decisao: "respondeu", resposta: d.resposta };
  } finally {
    if (!simular) await supabase.from("conversas").update({ sandy_trava_em: null }).eq("id", conversaId);
  }
}

async function executar(conversaId: string, simular: boolean, esperar: boolean, textoTeste?: string) {
  try {
    if (esperar) await dormir((ESPERA_MIN_SEG + Math.random() * (ESPERA_MAX_SEG - ESPERA_MIN_SEG)) * 1000);
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
