// Sandy das devoluções: lê os lotes de fotos recebidos, confere os arquivos, identifica o caso (número exato, depois rastreio, depois nome do comprador),
// compara o que foi COMPRADO com o que VOLTOU (itens do pedido + fotos + conferência da equipe + o que o cliente disse), analisa o estado
// e decide com liberdade: contestar, aceitar a devolução (não contestar) ou pedir informação.
// Grava duas coisas separadas: a indicação para a equipe (interna) e o texto que iria ao marketplace.
// NUNCA envia nada a marketplace: o envio só acontece quando uma pessoa aprova na tela.
// ECONOMIA DE TOKENS: se o número informado já acha o caso, não lê a etiqueta nas fotos; em nova análise do mesmo lote, reaproveita a etiqueta e a leitura do estado das fotos já feitas.
// v10: o nome lido na etiqueta é o do REMETENTE (o cliente que devolve); nomes da equipe/loja (destinatário) são descartados.
// v11: a leitura das fotos (estado) também recebe as regras 'Detalhe do modelo' (detalhes de outra cor que são de fábrica), para não tomar o desenho do modelo por erro de cor.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGEM = "devol-sandy-analisar";
const BUCKET = "devol-provas";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("DEVOL_SANDY_MODELO") ?? "gpt-4.1";
const MAX_FOTOS = 6;
const ETIQUETA_V = 3;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

// Nomes da equipe/loja: aparecem na etiqueta como destinatário e nunca podem identificar o cliente.
const NOMES_DA_LOJA = ["paulo silva", "lucas felix", "lucima felix"];
function semAcento(s: string): string { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }
function nomeDaLoja(v: string): boolean {
  const n = semAcento(v);
  return n.includes("sandstride") || NOMES_DA_LOJA.some((x) => n.includes(x));
}

async function diag(mensagem: string) {
  console.error(ORIGEM, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function cfg(chave: string): Promise<string | null> {
  const { data } = await supabase.from("devol_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor ?? null;
}
async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function perguntar(origemUso: string, esquema: any, mensagens: any[], maxTokens = 700): Promise<any> {
  if (!OPENAI) throw new Error("OPENAI_API_KEY não cadastrada nos Segredos do Supabase");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: MODELO, temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_schema", json_schema: esquema }, messages: mensagens }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  if (j?.usage) {
    try {
      await supabase.rpc("sandy_registrar_uso", { p_origem: origemUso, p_conversa: null, p_modelo: MODELO, p_entrada: j.usage.prompt_tokens ?? 0, p_cache: j.usage.prompt_tokens_details?.cached_tokens ?? 0, p_saida: j.usage.completion_tokens ?? 0 });
    } catch (_) { /* não atrapalha */ }
  }
  return JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
}

const S_ETIQUETA = {
  name: "leitura_etiqueta", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["identificadores", "legivel"],
    properties: {
      legivel: { type: "boolean", description: "true se há etiqueta ou documento com texto legível nas fotos" },
      identificadores: { type: "array", items: { type: "object", additionalProperties: false, required: ["tipo", "valor", "confianca"],
        properties: {
          tipo: { type: "string", enum: ["pedido", "rastreio", "solicitacao", "nome", "outro"] },
          valor: { type: "string", description: "Exatamente como está impresso, sem inventar dígitos. Para tipo nome: SOMENTE o nome completo da pessoa no campo REMETENTE (quem envia o pacote de volta, o cliente). Nunca o destinatário." },
          confianca: { type: "string", enum: ["alta", "media", "baixa"] },
        } } },
    },
  },
};

function esquemaEstado(ids: string[]) {
  return {
    name: "estado_do_retorno", strict: true,
    schema: {
      type: "object", additionalProperties: false,
      required: ["categoria_id", "itens_visiveis", "visivel_nas_fotos", "nao_comprovado_pelas_fotos", "confianca"],
      properties: {
        categoria_id: { type: "string", enum: ids },
        itens_visiveis: { type: "string", description: "Quantos pares/unidades aparecem nas fotos, com cor e modelo de cada um (ex.: '2 pares: 1 caramelo, 1 preto e branco'). Se não der para contar, diga." },
        visivel_nas_fotos: { type: "string", description: "Só o que aparece de fato nas fotos, em frases curtas" },
        nao_comprovado_pelas_fotos: { type: "string", description: "O que a equipe relatou mas as fotos não provam" },
        confianca: { type: "string", enum: ["alta", "media", "baixa"] },
      },
    },
  };
}

const S_RELATO = {
  name: "decisao_da_sandy", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    required: ["recomendacao", "loja_enviou_errado", "ha_evidencia_forte", "risco_de_contestar", "comparacao_itens", "indicacao_equipe", "relato", "pedido_financeiro", "provas_sugeridas", "alertas"],
    properties: {
      recomendacao: { type: "string", enum: ["contestar", "nao_contestar", "pedir_informacao"], description: "nao_contestar = aceitar a devolução para o cliente" },
      loja_enviou_errado: { type: "boolean", description: "true se o comprador reclamou de item/cor/modelo/tamanho errado E as fotos ou a equipe mostram que o que voltou (ou o que ele descreve ter recebido) difere do que foi comprado, mesmo que em uma só cor ou detalhe. Ou seja: o erro foi da loja." },
      ha_evidencia_forte: { type: "boolean", description: "true SOMENTE se há evidência concreta de que o comprador causou o problema: dano ou uso causado depois da entrega, par faltando, peça trocada por outra. false se o produto voltou íntegro, se só a caixa foi afetada, se o defeito alegado não aparece, ou se o erro foi da loja." },
      risco_de_contestar: { type: "string", enum: ["baixo", "medio", "alto"], description: "Risco de a contestação ser negada e gerar penalização para a loja. Alto se a base for fraca ou se o comprador provavelmente tem razão." },
      comparacao_itens: { type: "string", description: "Uma frase comparando o que foi comprado, o que o comprador pediu para devolver e o que chegou (ex.: 'Comprado: kit 2 pares preto/branco e caramelo. Voltou: os 2 pares do kit, conforme a venda.')" },
      indicacao_equipe: { type: "string", description: "Para a EQUIPE (nunca vai ao marketplace): 2 a 4 frases dizendo o que você concluiu, por que, e o risco de contestar (penalidade, advertência) ou de aceitar." },
      relato: { type: "string", description: "Texto PRONTO PARA ENVIAR ao MARKETPLACE se a equipe aprovar a contestação: completo, sem colchetes nem campos a preencher. Vazio se não for contestar." },
      pedido_financeiro: { type: "string", description: "Pedido proporcional ao prejuízo demonstrado. Sem custo documentado, pedir avaliação sem inventar valor. Vazio se não for contestar." },
      provas_sugeridas: { type: "array", items: { type: "string" } },
      alertas: { type: "array", items: { type: "string" }, description: "Riscos ou dúvidas para a equipe conferir antes de aprovar" },
    },
  },
};

const REGRAS_FIXAS = [
  "Você tem liberdade total para decidir. Contestar só vale a pena quando há evidência forte de que o retorno NÃO corresponde ao que foi vendido por culpa do comprador (faltando item ou par, peça trocada pelo cliente, dano causado depois da entrega, sinais claros de uso). Se o produto voltou conforme a venda, ou a evidência é fraca, ou o comprador provavelmente tem razão, recomende nao_contestar (aceitar a devolução): contestar sem base gera advertências e penalidades da conta no marketplace, que custam mais que o produto.",
  "Compare SEMPRE: (1) itens comprados no pedido, (2) itens que o comprador pediu para devolver, (3) o que aparece nas fotos, (4) a conferência da equipe e (5) o que o comprador disse ao abrir a solicitação. Kit de 2 pares que voltou com 1 par = retorno incompleto. Cor ou modelo diferente do vendido = produto diferente. Quantidade e variação batendo com o pedido e produto em bom estado = retorno conforme.",
  "Use somente fatos verdadeiros: o que está nas fotos, o que a equipe descreveu e os dados do pedido. Nunca invente dano, defeito, fraude, falta de produto ou acessório.",
  "A descrição da equipe é a fonte do que as fotos não mostram (por exemplo, itens que faltam). Escreva esse ponto como conferência da equipe, nunca como algo visível na foto.",
  "Peça solução proporcional ao prejuízo demonstrado. Preço da venda não é custo do dano. Valor integral só com produto ausente ou diferente confirmado, ou perda total documentada. Sem custo conhecido, peça avaliação, sem inventar valor.",
  "Não acuse o comprador nem afirme uso, fraude ou impossibilidade de revenda por mera aparência.",
  "Nunca ponha telefone, e-mail, link ou contato fora da plataforma no texto.",
  "Produto íntegro com apenas a caixa/embalagem danificada não justifica contestação: recomende nao_contestar.",
  "Se o problema que a equipe encontrou é o mesmo que o comprador já informou na reclamação original (ex.: comprador disse que veio cor errada e voltou a cor errada que a loja enviou), o erro foi da loja: recomende nao_contestar.",
  "ERRO DE ENVIO DA LOJA (decida por isso antes de tudo): se o comprador reclama de item/cor/modelo/tamanho errado e as fotos ou a equipe mostram cores, modelo ou tamanho DIFERENTES do que foi comprado (variação do pedido) em QUALQUER par, mesmo que só em uma cor ou detalhe, ou o que o comprador descreve que recebeu coincide com o que voltou, o erro foi da loja. Nesse caso marque loja_enviou_errado=true, risco_de_contestar=alto, recomende nao_contestar (aceitar a devolução) e diga na indicacao_equipe, em linguagem simples, qual foi o erro (ex.: 'pedido era preto/branco e caramelo, mas voltou um par verde-água e um caramelo'). A loja sabe o que enviou; o cliente só devolve o que recebeu. Só contestar produto diferente se houver evidência de que a loja enviou o correto e o cliente devolveu outra coisa. ATENÇÃO: detalhes de outra cor que fazem parte do desenho do modelo (veja 'Detalhe do modelo' nas regras) NÃO são diferença de cor.",
  "Confira cor por cor: para cada par, compare as cores vistas nas fotos com a variação comprada (ex.: 'Preto/Branco e Caramelo'). Nunca escreva que o retorno está 'conforme o pedido' sem ter conferido cada par. Se alguma cor das fotos não bate com a variação do pedido, diga isso na comparacao_itens. Se as fotos não permitem conferir as cores, use pedir_informacao.",
  "Dê peso à alegação do comprador (campo 'Texto do comprador'): se o que ele descreve bate com as fotos, ele provavelmente tem razão.",
  "Só marque ha_evidencia_forte=true quando houver prova concreta de que o comprador causou o problema. Se o defeito alegado não aparece nas fotos, ou o produto voltou íntegro, marque false e recomende nao_contestar. Sua recomendação deve ser coerente com o risco: se o risco_de_contestar for alto, recomende nao_contestar.",
  "Se a equipe disse que o retorno está completo mas as fotos mostram menos itens, as fotos podem estar incompletas: não conclua falta de item só por isso; recomende pedir_informacao pedindo foto de todos os itens.",
  "Se faltar informação indispensável (por exemplo, a equipe não descreveu a condição e as fotos não permitem concluir), recomende pedir_informacao e diga o que falta. Não use pedir_informacao quando a conclusão já é clara.",
  "A indicacao_equipe é conversa interna com a equipe; o relato é o texto formal para o marketplace. Nunca misture: o relato não fala de risco, penalidade nem da equipe interna.",
  "O relato deve estar PRONTO PARA ENVIAR como está: sem colchetes, sem campos a preencher, sem pedir para a equipe completar nada. A equipe só aprova e envia.",
  "Escreva em português do Brasil, texto objetivo e profissional, relato com até 8 frases.",
].join("\n");

const FORCADO = "\n\nATENÇÃO: o dono já viu sua recomendação de NÃO contestar e decidiu contestar mesmo assim. Escreva o melhor relato possível usando SOMENTE fatos verdadeiros (fotos, descrição da equipe e dados do pedido), sem inventar nada para sustentar a contestação. Use recomendacao=contestar. Se não houver como escrever um relato honesto, use pedir_informacao e explique. Liste em alertas os riscos reais de contestar este caso.";

const PROIBIDO = /https?:\/\/|www\.|\.com\b|@\w|whats|\b\d{10,}\b/i;

function textoItens(it: any): string {
  if (!it || !Array.isArray(it.comprados) || !it.comprados.length) return "Itens do pedido: não disponíveis.";
  const f = (l: any[]) => l.map((x: any) => `${x.qtd}x ${x.nome}${x.variacao ? ` (${x.variacao})` : ""}`).join("; ");
  let t = `Itens comprados no pedido: ${f(it.comprados)}.`;
  if (Array.isArray(it.devolvidos) && it.devolvidos.length) t += ` Itens que o comprador pediu para devolver: ${f(it.devolvidos)}.`;
  if (it.motivo_comprador) t += ` Texto do comprador ao abrir a devolução: "${String(it.motivo_comprador).slice(0, 400)}".`;
  return t;
}

async function processar(rec: any) {
  const resumo: any = { passos: [] };
  const prev: any = rec.analise_resumo ?? {};
  const { data: anexos } = await supabase.from("devol_anexos").select("id, caminho, tipo, sha256, estado, bytes").eq("recebimento_id", rec.id).in("estado", ["pendente", "arquivado"]);
  const lista = anexos ?? [];
  if (!lista.length) { resumo.passos.push("sem arquivos"); return resumo; }

  const urls: string[] = [];
  const problemas: string[] = [];
  for (const a of lista) {
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(a.caminho);
    if (error || !blob) { problemas.push(`arquivo não encontrado: ${a.caminho}`); continue; }
    const hash = await sha256(await blob.arrayBuffer());
    if (a.sha256 && hash !== a.sha256) { problemas.push(`hash divergente: ${a.caminho}`); continue; }
    await supabase.from("devol_anexos").update({ estado: "arquivado", sha256: hash, bytes: blob.size }).eq("id", a.id);
    if (a.tipo !== "video" && urls.length < MAX_FOTOS) {
      const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(a.caminho, 900);
      if (s?.signedUrl) urls.push(s.signedUrl);
    }
  }
  resumo.arquivados = lista.length - problemas.length;
  if (problemas.length) resumo.problemas = problemas.slice(0, 5);
  if (lista.some((a: any) => a.tipo === "video")) resumo.passos.push("vídeo guardado, mas não analisado");

  const imagens = urls.map((u) => ({ type: "image_url", image_url: { url: u, detail: "auto" } }));

  let caso: any = null;
  const colunas = "id, loja_id, solicitacao_id, pedido, status, categoria, motivo_original, tipo_origem, itens_pedido";
  if (rec.caso_id) {
    const { data } = await supabase.from("devol_casos").select(colunas).eq("id", rec.caso_id).maybeSingle();
    caso = data;
  }
  let origemId = rec.fonte_identificacao ?? "";
  if (!caso) {
    // Procura o caso: número (pedido/solicitação/envio da devolução) -> rastreio -> nome do comprador. Só liga se achar UM caso.
    const achar = async (nums: string[], nomes: string[]): Promise<{ n: number; caso?: any; por?: string }> => {
      const { data } = await supabase.rpc("devol_achar_caso", { p_numeros: nums, p_nomes: nomes });
      const r: any = Array.isArray(data) ? data[0] : data;
      if (!r || !r.n) return { n: 0 };
      if (r.n > 1) return { n: r.n };
      const { data: c } = await supabase.from("devol_casos").select(colunas).eq("id", r.caso_id).maybeSingle();
      return { n: c ? 1 : 0, caso: c, por: r.por };
    };
    const informado = String(rec.pedido_lido ?? "").trim();
    const nums: string[] = []; const nomes: string[] = [];
    if (informado) { nums.push(informado, informado.replace(/^#/, "")); }
    // 1) o número já informado acha um caso só? Então não gasta a leitura da etiqueta.
    let res = informado ? await achar(nums, []) : { n: 0 } as any;
    if (res.n === 1) origemId = "número informado por você no lote";
    else {
      // 2) lê a etiqueta nas fotos (ou reaproveita a leitura já feita deste lote, se ela já era da versão atual)
      let ident: any[] = prev.etiqueta_v === ETIQUETA_V && Array.isArray(prev.etiqueta) ? prev.etiqueta : [];
      if (ident.length) resumo.etiqueta_reaproveitada = true;
      else if (imagens.length) {
        const et = await perguntar("devolucao_etiqueta", S_ETIQUETA, [
          { role: "system", content: "Você lê etiquetas de devolução de marketplaces. Transcreva SOMENTE o que está impresso e legível nas fotos: números (pedido, rastreio, solicitação) e o NOME do CLIENTE (tipo nome). Atenção: numa etiqueta de devolução, o CLIENTE é quem aparece no campo REMETENTE (quem está enviando o pacote de volta). O campo DESTINATÁRIO é a loja que recebe: NUNCA transcreva o destinatário como nome. Os nomes Paulo Silva, Lucas Felix (Félix), Lucima Felix (Félix) e Sandstride são da loja e jamais devem ser transcritos como nome. Se não houver remetente legível, não inclua nenhum nome. Se não estiver legível, não inclua. Nunca complete nem invente dígitos ou letras." },
          { role: "user", content: [{ type: "text", text: "Leia os identificadores e o nome do REMETENTE (cliente) das etiquetas e documentos nestas fotos." }, ...imagens] },
        ], 450);
        ident = (et.identificadores ?? []).map((i: any) => ({ tipo: i.tipo, valor: i.valor, confianca: i.confianca }));
        resumo.etiqueta_v = ETIQUETA_V;
      } else if (Array.isArray(prev.etiqueta)) ident = prev.etiqueta;
      // descarta nomes da loja/equipe, mesmo que a leitura os traga
      ident = ident.filter((i: any) => !(i.tipo === "nome" && nomeDaLoja(String(i.valor ?? ""))));
      if (ident.length) { resumo.etiqueta = ident; if (!resumo.etiqueta_v) resumo.etiqueta_v = prev.etiqueta_v ?? 1; }
      for (const i of ident) {
        if (i.confianca !== "alta") continue;
        const v = String(i.valor ?? "").trim();
        if (i.tipo === "nome") { if (v.length >= 8) nomes.push(v); continue; }
        if (v.length >= 5) { nums.push(v, v.replace(/^#/, ""), v.replace(/\D/g, "")); }
      }
      res = await achar(nums, nomes);
      if (res.n === 1) origemId = `etiqueta lida pela Sandy (${res.por})`;
    }
    if (res.n === 1) caso = res.caso;
    else resumo.passos.push(res.n > 1 ? `${res.n} casos com esses dados: identificação manual` : (nums.length || nomes.length ? "nenhum caso com esses dados" : "sem número legível ou informado"));
    if (!caso) return resumo;
    await supabase.from("devol_recebimentos").update({ caso_id: caso.id, identificacao: "identificado", fonte_identificacao: origemId || "número exato", loja_id: caso.loja_id }).eq("id", rec.id);
    await supabase.from("devol_anexos").update({ caso_id: caso.id }).eq("recebimento_id", rec.id);
  }
  resumo.identificado = { caso: caso.id, fonte: origemId };
  if (Array.isArray(prev.etiqueta) && prev.etiqueta.length && !resumo.etiqueta) { resumo.etiqueta = prev.etiqueta; resumo.etiqueta_v = prev.etiqueta_v ?? 1; }

  if (["DECIDIDO", "CREDITO_PENDENTE", "CONCILIADO", "ENCERRADO", "ENVIADO", "EM_ANALISE"].includes(caso.status) && !rec.forcar_contestacao) {
    resumo.passos.push("caso já com o marketplace ou decidido: fotos ligadas, sem relato novo");
    await supabase.from("devol_eventos").upsert({ caso_id: caso.id, tipo: "lote_ligado", evento_chave: `lote:${rec.id}`, dados: { recebimento: rec.id, fonte: origemId } }, { onConflict: "evento_chave", ignoreDuplicates: true });
    return resumo;
  }

  const { data: loja } = await supabase.from("lojas").select("apelido, marketplace").eq("id", caso.loja_id).maybeSingle();
  const mkt = loja?.marketplace ?? "mercado_livre";
  const { data: modelos } = await supabase.from("devol_modelos").select("id, titulo, termos, corpo").eq("ativo", true);
  const catalogo = (modelos ?? []).map((m: any) => `- ${m.id}: ${m.titulo} (${(m.termos ?? []).slice(0, 5).join(", ")})`).join("\n");
  const equipe = String(rec.descricao_equipe ?? "").trim() || "(a equipe não descreveu a condição)";
  const itens = textoItens(caso.itens_pedido);
  const dadosCaso = `Marketplace: ${mkt}. Loja: ${loja?.apelido}. Tipo da reclamação: ${caso.tipo_origem ?? "—"}. Motivo original do comprador: ${caso.motivo_original ?? "não informado"}.\n${itens}`;

  // A leitura das fotos não depende do pedido: se este lote já foi lido antes (nova análise), reaproveita.
  const idsModelos = (modelos ?? []).map((m: any) => m.id);
  let est: any = prev.estado && idsModelos.includes(prev.estado.categoria_id) ? prev.estado : null;
  if (est) resumo.estado_reaproveitado = true;
  else {
    // detalhes de modelo conhecidos (cores que fazem parte do desenho do tenis): evita tomar o modelo por erro de cor
    const { data: rm } = await supabase.from("devol_regras").select("texto").eq("marketplace", mkt).eq("ativa", true).ilike("titulo", "Detalhe do modelo%");
    const detalhes = (rm ?? []).map((r: any) => `* ${r.texto}`).join("\n");
    est = await perguntar("devolucao_estado", esquemaEstado(idsModelos), [
      { role: "system", content: `Você analisa fotos de produtos devolvidos de uma loja de calçados e meias. Descreva só o que aparece nas fotos, SEM se guiar pelo pedido para decidir cores. Conte os pares/unidades e descreva a cor real de cada par (cada cor visível: solado, cabedal, detalhes) e o modelo, para depois comparar com o pedido. Se uma cor não for a do pedido, diga qual é. Escolha a categoria mais adequada:\n${catalogo}\nLembre: a descrição da equipe é a fonte do que não se vê.${detalhes ? `\n\nDETALHES CONHECIDOS DOS MODELOS (fazem parte do desenho do produto: não conte como cor diferente nem como erro, e não escolha a categoria de produto diferente por causa deles):\n${detalhes}` : ""}` },
      { role: "user", content: [{ type: "text", text: `${dadosCaso}\nDescrição da equipe (texto exato): ${equipe}\n${imagens.length ? "Fotos do lote:" : "Sem fotos analisáveis."}` }, ...imagens] },
    ], 600);
  }
  resumo.estado = est;

  const modelo = (modelos ?? []).find((m: any) => m.id === est.categoria_id);
  const [{ data: regras }, { data: aprend }] = await Promise.all([
    supabase.from("devol_regras").select("titulo, texto").eq("marketplace", mkt).eq("ativa", true),
    supabase.from("devol_aprendizados").select("resultado, regra, limites").eq("categoria", est.categoria_id).eq("marketplace", mkt),
  ]);
  const txtRegras = (regras ?? []).map((r: any) => `* ${r.titulo}: ${r.texto}`).join("\n") || "(sem regras cadastradas)";
  const txtAprend = (aprend ?? []).map((a: any) => `* ${a.regra ?? ""} Limites: ${String(a.limites ?? "").slice(0, 600)}`).join("\n") || "(sem aprendizados)";
  const forcado = rec.forcar_contestacao === true;
  const rel = await perguntar("devolucao_relato", S_RELATO, [
    { role: "system", content: `Você é a Sandy, analista de devoluções da Sandstride. Analisa o caso por completo e decide o melhor para a loja; a equipe aprova antes de qualquer envio.\nREGRAS:\n${REGRAS_FIXAS}\n\nREGRAS DO MARKETPLACE (${mkt}):\n${txtRegras}\n\nAPRENDIZADOS DA CATEGORIA:\n${txtAprend}\n\nMODELO DA CATEGORIA (só para o relato; adapte, preencha todos os campos entre colchetes, nunca deixe colchete no texto):\n${modelo?.corpo ?? "(sem modelo)"}${forcado ? FORCADO : ""}` },
    { role: "user", content: `${dadosCaso}\nDescrição da equipe (texto exato): ${equipe}\nItens visíveis nas fotos: ${est.itens_visiveis}\nVisível nas fotos: ${est.visivel_nas_fotos}\nNão comprovado pelas fotos: ${est.nao_comprovado_pelas_fotos}\nConfiança da leitura das fotos: ${est.confianca}\nCompare os itens, decida e prepare a indicação para a equipe e, se for contestar, o relato PRONTO PARA ENVIAR ao marketplace.` },
  ], 1100);

  const alertas: string[] = [...(rel.alertas ?? [])];
  let rec2 = rel.recomendacao as string, texto = String(rel.relato ?? "").trim();
  let indicacao = String(rel.indicacao_equipe ?? "").trim();
  if (!forcado && rec2 === "contestar" && rel.loja_enviou_errado === true) {
    rec2 = "nao_contestar"; texto = "";
    indicacao = "O erro parece ter sido da loja: o que voltou não bate com o que foi comprado e o comprador reclamou disso. " + indicacao;
  }
  if (!forcado && rec2 === "contestar" && rel.risco_de_contestar === "alto") {
    rec2 = "nao_contestar"; texto = "";
    indicacao = "O risco de contestar é alto (base fraca ou o comprador provavelmente tem razão), e uma contestação negada pode penalizar a conta. " + indicacao;
  }
  if (!forcado && rec2 === "contestar" && rel.ha_evidencia_forte !== true) {
    rec2 = "nao_contestar"; texto = "";
    indicacao = "Não há evidência forte de que o problema foi causado pelo comprador; contestar arrisca advertência da conta. " + indicacao;
  }
  const sem = ["embalagem-isolada", "retorno-conforme"].includes(est.categoria_id);
  if (sem && !forcado && rec2 === "contestar") {
    rec2 = "nao_contestar"; texto = "";
    indicacao = (est.categoria_id === "embalagem-isolada" ? "Só a embalagem foi afetada; o produto voltou íntegro. " : "O produto voltou conforme a venda. ") + "Contestar sem dano real no produto arrisca advertência da conta. " + indicacao;
  }
  if (sem && forcado) alertas.push("O produto voltou íntegro. Contestar sem dano real no produto pode gerar advertência (o Mercado Livre já advertiu a loja Sandstride I em 13/10).");
  if (forcado && rec2 === "nao_contestar") rec2 = "pedir_informacao";
  if (rec2 === "contestar" && (PROIBIDO.test(texto) || /\[[^\]]+\]/.test(texto) || texto.length < 40)) {
    rec2 = "pedir_informacao"; alertas.push("O texto gerado ficou incompleto ou com contato externo; revise antes de usar."); texto = "";
  }
  if (rec2 !== "contestar") texto = "";
  if (est.confianca === "baixa" && rec2 === "contestar") alertas.push("A leitura das fotos teve confiança baixa: confira as fotos antes de aprovar.");
  if (!imagens.length && rec2 === "contestar") alertas.push("Este lote não tem fotos analisáveis (só vídeo ou arquivos): confira as provas.");
  if (!caso.itens_pedido) alertas.push("Os itens do pedido ainda não foram lidos do marketplace: confira se o que voltou é o que foi vendido.");
  if (forcado) alertas.push("Contestação pedida por você, contra a recomendação inicial da Sandy.");

  const { error: er } = await supabase.from("devol_relatos").upsert({
    caso_id: caso.id, recebimento_id: rec.id, categoria: est.categoria_id, recomendacao: rec2, motivo: indicacao.slice(0, 900), relato: texto || null,
    pedido_financeiro: rec2 === "contestar" ? (String(rel.pedido_financeiro ?? "").slice(0, 600) || null) : null, provas: rel.provas_sugeridas ?? [], alertas,
    visao: { ...est, comparacao_itens: String(rel.comparacao_itens ?? ""), loja_enviou_errado: rel.loja_enviou_errado, risco: rel.risco_de_contestar, evidencia_forte: rel.ha_evidencia_forte }, modelo: MODELO, criado_em: new Date().toISOString(),
  }, { onConflict: "recebimento_id" });
  if (er) throw new Error(`erro ao guardar o relato: ${er.message}`);

  const inicial = ["NOVO", "AGUARDANDO_ANALISE", "AGUARDANDO_PROVAS", "PREPARADO"].includes(caso.status);
  const novoStatus = !inicial ? caso.status : rec2 === "contestar" ? "PREPARADO" : rec2 === "pedir_informacao" ? "AGUARDANDO_PROVAS" : "NOVO";
  await supabase.from("devol_casos").update({ categoria: est.categoria_id, status: novoStatus, ...(novoStatus === "PREPARADO" ? { proxima_verificacao: new Date().toISOString() } : {}) }).eq("id", caso.id);
  await supabase.from("devol_eventos").upsert({ caso_id: caso.id, tipo: "sandy_preparou", evento_chave: `sandy:${rec.id}:${forcado ? "forcado" : "inicial"}:${Date.now()}`, dados: { recomendacao: rec2, categoria: est.categoria_id, recebimento: rec.id, forcado } }, { onConflict: "evento_chave", ignoreDuplicates: true });
  resumo.recomendacao = rec2; resumo.status = novoStatus;
  return resumo;
}

async function executar() {
  try {
    if ((await cfg("kill_switch")) === "true" || (await cfg("ia_ativa")) !== "true") return;
    const limite = new Date(Date.now() - 30_000).toISOString();
    const { data: fila } = await supabase.from("devol_recebimentos").select("id, caso_id, fonte_identificacao, pedido_lido, rastreio, descricao_equipe, criado_em, forcar_contestacao, analise_resumo").eq("analise", "pendente").lt("criado_em", limite).order("criado_em").limit(3);
    for (const r of fila ?? []) {
      const { data: reservado } = await supabase.from("devol_recebimentos").update({ analise: "processando" }).eq("id", r.id).eq("analise", "pendente").select("id");
      if (!reservado?.length) continue;
      try {
        const resumo = await processar(r);
        await supabase.from("devol_recebimentos").update({ analise: "concluida", analise_em: new Date().toISOString(), analise_resumo: resumo, analise_erro: null }).eq("id", r.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await diag(`erro no lote ${r.id}: ${msg}`);
        await supabase.from("devol_recebimentos").update({ analise: "erro", analise_em: new Date().toISOString(), analise_erro: msg.slice(0, 400) }).eq("id", r.id);
      }
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
