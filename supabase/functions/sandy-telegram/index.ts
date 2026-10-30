// Sandy no grupo do Telegram: conversa com a equipe (resumo do dia, pendentes, pedidos, aprender, responder cliente).
// Recebe as mensagens do grupo pelo webhook do Telegram (cabeçalho X-Telegram-Bot-Api-Secret-Token).
// Só responde quando citam "Sandy", marcam o bot ou respondem a uma mensagem dela, e só no grupo conectado.
// Uso interno (x-lucro-token): {registrar: true} liga o webhook.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const CHAVE_SERVICO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("SANDY_MODELO") ?? "gpt-4.1-mini";
const SITE = "https://sandstridehub.vercel.app";
const FUNCAO = `${URL_BASE}/functions/v1/sandy-telegram`;
const supabase = createClient(URL_BASE, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });

const MK: Record<string, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop" };
const RESPONDER: Record<string, string> = { mercado_livre: "ml-responder", shopee: "shopee-responder", tiktok_shop: "tiktok-responder" };
const SEM_ENVIO = ["cancelado", "devolucao", "devolvido", "analise_ml"];
const FUSO = "America/Sao_Paulo";

async function diag(mensagem: string) {
  console.error("sandy-telegram", mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: "sandy-telegram", mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function telegram(metodo: string, corpo: any = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description ?? r.status}`);
  return j.result;
}
async function segredoWebhook(): Promise<string> {
  const { data } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram:${data?.valor ?? ""}`));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function config(chave: string): Promise<string | null> {
  const { data } = await supabase.from("configuracoes").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor || null;
}
const link = (id: string) => `${SITE}/chat/?c=${id}`;
const hora = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function haQuanto(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} dias`;
}
// Início do dia no fuso de São Paulo (o Brasil não tem horário de verão desde 2019: UTC-3).
function inicioDoDia(diasAtras = 0): Date {
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
  const d = new Date(`${hoje}T00:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() - diasAtras);
  return d;
}

// ---------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------
async function resumoAtendimento(a: any) {
  const p = String(a.periodo ?? "hoje");
  let ini: Date, fim = new Date(), rotulo = "hoje até agora";
  if (p === "ontem") { ini = inicioDoDia(1); fim = inicioDoDia(0); rotulo = "ontem"; }
  else if (p === "7dias") { ini = inicioDoDia(6); rotulo = "últimos 7 dias (incluindo hoje)"; }
  else ini = inicioDoDia(0);
  const { data, error } = await supabase.rpc("sandy_resumo_atendimento", { p_inicio: ini.toISOString(), p_fim: fim.toISOString() });
  if (error) return { erro: error.message };
  const m = Number(data?.tempo_mediano_primeira_resposta_min);
  const tempo = Number.isFinite(m) && m > 0 ? (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}`) : null;
  return { periodo: rotulo, ...data, tempo_mediano_primeira_resposta: tempo };
}

async function listarPendentes(a: any) {
  const limite = Math.min(Math.max(Number(a.limite) || 8, 1), 15);
  const { data } = await supabase.from("conversas")
    .select("id, cliente_nome, ultima_mensagem_texto, ultima_mensagem_em, situacao, escalada_motivo, lojas(nome, marketplace)")
    .eq("aguardando_resposta", true).eq("ultima_mensagem_de", "cliente").or("situacao.is.null,situacao.eq.reclamacao")
    .not("bloqueada", "is", true).order("ultima_mensagem_em", { ascending: true }).limit(limite);
  return {
    total_listado: data?.length ?? 0,
    conversas: (data ?? []).map((c: any) => {
      const l = Array.isArray(c.lojas) ? c.lojas[0] : c.lojas;
      return { cliente: c.cliente_nome, loja: `${l?.nome} (${MK[l?.marketplace] ?? l?.marketplace})`, esperando_ha: haQuanto(c.ultima_mensagem_em),
        ultima_mensagem: String(c.ultima_mensagem_texto ?? "").slice(0, 160), motivo_da_sandy: c.escalada_motivo, link: link(c.id), conversa_id: c.id };
    }),
  };
}

async function buscarConversa(a: any) {
  const termo = String(a.termo ?? "").trim().replace(/[%,()*:\\]/g, "");
  if (termo.length < 3) return { erro: "termo curto demais" };
  const { data } = await supabase.from("conversas")
    .select("id, tipo, cliente_nome, pedido_id_externo, id_externo, produto_titulo, situacao, situacao_detalhe, dados_extras, ultima_mensagem_em, aguardando_resposta, lojas(nome, marketplace)")
    .or(`pedido_id_externo.ilike.%${termo}%,id_externo.ilike.%${termo}%,cliente_nome.ilike.%${termo}%`)
    .order("ultima_mensagem_em", { ascending: false }).limit(4);
  if (!data?.length) return { encontrado: false, aviso: "Só encontro pedidos que têm conversa no chat da Central." };
  const out = [];
  for (const c of data as any[]) {
    const l = Array.isArray(c.lojas) ? c.lojas[0] : c.lojas;
    const { data: ms } = await supabase.from("mensagens").select("de, texto, enviada_em, enviada_por_ia")
      .eq("conversa_id", c.id).order("enviada_em", { ascending: false }).limit(6);
    const d = c.dados_extras ?? {};
    out.push({
      conversa_id: c.id, link: link(c.id), cliente: c.cliente_nome, loja: `${l?.nome} (${MK[l?.marketplace] ?? l?.marketplace})`,
      pedido: c.pedido_id_externo ?? (c.tipo === "pos_venda" ? c.id_externo : null), produto: d.item?.titulo ?? c.produto_titulo,
      variacao: d.item?.variacao, quantidade: d.item?.quantidade, status_pedido: d.status, envio: d.envio ? { status: d.envio.status, cidade: d.envio.cidade, uf: d.envio.uf } : undefined,
      total: d.total, situacao: c.situacao ? `${c.situacao}${c.situacao_detalhe ? ` – ${c.situacao_detalhe}` : ""}` : null,
      esperando_resposta: !!c.aguardando_resposta,
      ultimas_mensagens: (ms ?? []).reverse().map((m: any) => `${hora(m.enviada_em)} ${m.de === "cliente" ? "Cliente" : m.de === "sistema" ? "Aviso" : m.enviada_por_ia ? "Sandy" : "Loja"}: ${String(m.texto ?? "[anexo]").slice(0, 200)}`),
    });
  }
  return { encontrado: true, resultados: out };
}

async function ensinar(a: any, quem: string) {
  const titulo = String(a.titulo ?? "").trim().slice(0, 120), texto = String(a.texto ?? "").trim().slice(0, 2000);
  const escopo = ["todas", "mercado_livre", "shopee", "tiktok_shop"].includes(a.escopo) ? a.escopo : "todas";
  if (!titulo || !texto) return { erro: "faltou título ou texto" };
  const { data: existe } = await supabase.from("sandy_conhecimento").select("id").eq("titulo", titulo).maybeSingle();
  const linha = { titulo, texto: `${texto}\n(Ensinado por ${quem} no Telegram em ${new Date().toLocaleDateString("pt-BR", { timeZone: FUSO })}.)`, escopo, ativo: true, atualizado_em: new Date().toISOString() };
  const { error } = existe ? await supabase.from("sandy_conhecimento").update(linha).eq("id", existe.id) : await supabase.from("sandy_conhecimento").insert(linha);
  return error ? { erro: error.message } : { salvo: true, atualizou_existente: !!existe, titulo, escopo };
}
async function listarConhecimento() {
  const { data } = await supabase.from("sandy_conhecimento").select("titulo, escopo").eq("ativo", true).order("titulo");
  return { assuntos: (data ?? []).map((k: any) => `${k.titulo} (${k.escopo})`) };
}
async function esquecer(a: any) {
  const titulo = String(a.titulo ?? "").trim();
  const { data } = await supabase.from("sandy_conhecimento").update({ ativo: false, atualizado_em: new Date().toISOString() }).eq("titulo", titulo).select("titulo");
  return data?.length ? { desativado: titulo } : { erro: "não achei um assunto com esse título exato; use listar_conhecimento" };
}

// Envio para o cliente pelo mesmo caminho da equipe, como Sandy.
async function jwtSandy(): Promise<string> {
  const id = await config("sandy_usuario_id");
  if (!id) throw new Error("usuário da Sandy ainda não criado");
  const { data: u } = await supabase.auth.admin.getUserById(id);
  const email = u?.user?.email;
  if (!email) throw new Error("usuário da Sandy sem e-mail");
  const { data: l, error: e1 } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
  if (e1 || !l?.properties?.hashed_token) throw new Error(`link da Sandy: ${e1?.message}`);
  const outro = createClient(URL_BASE, CHAVE_SERVICO, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e2 } = await outro.auth.verifyOtp({ token_hash: l.properties.hashed_token, type: "magiclink" });
  if (e2 || !s?.session?.access_token) throw new Error(`sessão da Sandy: ${e2?.message}`);
  return s.session.access_token;
}
async function responderCliente(a: any) {
  const id = String(a.conversa_id ?? ""), texto = String(a.texto ?? "").trim();
  if (!/^[0-9a-f-]{36}$/.test(id)) return { erro: "conversa_id inválido" };
  if (!texto || texto.length > 700) return { erro: "texto vazio ou longo demais (máx. 700)" };
  if (/https?:\/\/|www\.|\.com\b|@\w|\b\d{8,}\b|whats/i.test(texto)) return { erro: "o texto tem link ou contato; o marketplace proíbe" };
  const { data: c } = await supabase.from("conversas").select("id, situacao, bloqueada, cliente_nome, lojas(marketplace)").eq("id", id).maybeSingle();
  if (!c) return { erro: "conversa não encontrada" };
  const l: any = Array.isArray(c.lojas) ? c.lojas[0] : c.lojas;
  if (c.bloqueada || (c.situacao && SEM_ENVIO.includes(c.situacao))) return { erro: "o marketplace não aceita mensagens nesta conversa" };
  const r = await fetch(`${URL_BASE}/functions/v1/${RESPONDER[l.marketplace]}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await jwtSandy()}`, apikey: CHAVE_SERVICO },
    body: JSON.stringify({ conversa_id: id, texto }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) return { erro: `não consegui enviar: ${String(j.erro ?? r.status).slice(0, 200)}` };
  if (j.mensagem_id) await supabase.from("mensagens").update({ enviada_por_ia: true, enviada_por: null }).eq("id", j.mensagem_id);
  await supabase.from("conversas").update({ escalada_motivo: null }).eq("id", id);
  await supabase.from("sandy_registros").insert({ conversa_id: id, decisao: "respondeu", motivo: "Enviado a pedido da equipe pelo Telegram", resposta: texto, modelo: "equipe" });
  return { enviado: true, cliente: c.cliente_nome };
}

const FERRAMENTAS = [
  { type: "function", function: { name: "resumo_atendimento", description: "Números do atendimento: mensagens de clientes, conversas, respostas, tempo mediano de primeira resposta, pendentes agora, decisões da Sandy.",
    parameters: { type: "object", properties: { periodo: { type: "string", enum: ["hoje", "ontem", "7dias"] } }, required: ["periodo"], additionalProperties: false } } },
  { type: "function", function: { name: "listar_pendentes", description: "Conversas esperando resposta agora, das mais antigas para as mais novas.",
    parameters: { type: "object", properties: { limite: { type: "integer" } }, required: ["limite"], additionalProperties: false } } },
  { type: "function", function: { name: "buscar_conversa", description: "Procura conversa por número de pedido (ou parte dele) ou nome/usuário do cliente. Traz dados do pedido e as últimas mensagens.",
    parameters: { type: "object", properties: { termo: { type: "string" } }, required: ["termo"], additionalProperties: false } } },
  { type: "function", function: { name: "ensinar", description: "Guarda uma orientação na base de conhecimento da Sandy (o que ela deve saber ou como deve responder). Use quando a equipe disser 'aprende', 'de agora em diante', 'responda assim' sobre um tipo de situação.",
    parameters: { type: "object", properties: { titulo: { type: "string", description: "Assunto curto, ex.: 'Prazo de troca'" }, texto: { type: "string", description: "A orientação escrita de forma clara, como regra para a Sandy" }, escopo: { type: "string", enum: ["todas", "mercado_livre", "shopee", "tiktok_shop"] } }, required: ["titulo", "texto", "escopo"], additionalProperties: false } } },
  { type: "function", function: { name: "listar_conhecimento", description: "Lista os assuntos que a Sandy sabe.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "esquecer", description: "Desativa um assunto da base de conhecimento (título exato).",
    parameters: { type: "object", properties: { titulo: { type: "string" } }, required: ["titulo"], additionalProperties: false } } },
  { type: "function", function: { name: "responder_cliente", description: "Envia uma mensagem a um cliente pelo marketplace. Use SOMENTE quando a pessoa pedir claramente para mandar algo a um cliente específico.",
    parameters: { type: "object", properties: { conversa_id: { type: "string" }, texto: { type: "string" } }, required: ["conversa_id", "texto"], additionalProperties: false } } },
];

async function executarFerramenta(nome: string, a: any, quem: string) {
  try {
    if (nome === "resumo_atendimento") return await resumoAtendimento(a);
    if (nome === "listar_pendentes") return await listarPendentes(a);
    if (nome === "buscar_conversa") return await buscarConversa(a);
    if (nome === "ensinar") return await ensinar(a, quem);
    if (nome === "listar_conhecimento") return await listarConhecimento();
    if (nome === "esquecer") return await esquecer(a);
    if (nome === "responder_cliente") return await responderCliente(a);
    return { erro: "ferramenta desconhecida" };
  } catch (e) { return { erro: e instanceof Error ? e.message : String(e) }; }
}

function instrucoes(quem: string, contexto: string) {
  const agora = new Date().toLocaleString("pt-BR", { timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return [
    "Você é a Sandy, atendente virtual da Sandstride (loja de tênis em Mercado Livre, Shopee e TikTok Shop), conversando com a equipe no grupo interno do Telegram.",
    `Agora: ${agora} (horário de Brasília). Quem está falando: ${quem}.`,
    "Fale em português do Brasil como uma colega de trabalho de verdade conversando no WhatsApp/Telegram: natural, leve, simpática e direta. Nada de tom de relatório ou de robô.",
    "Divida a resposta em 1 a 4 mensagens curtas, do jeito que uma pessoa mandaria (ex.: primeiro a visão geral, depois o detalhe, depois um comentário). Separe cada mensagem com uma linha contendo só ||| . Respostas simples cabem numa mensagem só.",
    "Arredonde e humanize números: tempos em horas e minutos (ex.: 1h44, não 103,8 minutos), use 'quase', 'umas', 'mais ou menos' quando fizer sentido. Pode comentar se o número está bom ou ruim de forma leve.",
    "Texto simples, sem markdown, sem listas com marcadores longas; no máximo 1 emoji no total. Não termine toda resposta oferecendo ajuda ou fazendo pergunta; só pergunte quando fizer sentido.",
    "Para números, pendentes e pedidos, use SEMPRE as ferramentas; nunca invente dados. Se a ferramenta não trouxer, diga que não encontrou.",
    "Ao citar conversas, inclua o link para abrir.",
    "Quando a equipe ensinar algo ('aprende', 'de agora em diante', 'responda mais ou menos assim' sobre um tipo de situação), use a ferramenta ensinar e depois confirme em uma frase o que guardou.",
    "Se pedirem para responder um cliente específico com um texto, use responder_cliente com o conversa_id certo e confirme o envio. Se não estiver claro qual cliente, pergunte antes. Nunca envie a um cliente algo que não foi pedido.",
    "Você também recebe áudios (já transcritos) e imagens (prints, fotos de produto, de etiqueta, de conversa). Use o que vê na imagem para ajudar; se não der para ler, diga.",
    "Assuntos fora do atendimento da loja: responda brevemente que você cuida do atendimento.",
    contexto ? `CONTEXTO (mensagem a que estão respondendo): ${contexto}` : "",
  ].filter(Boolean).join("\n");
}

async function conversarComModelo(texto: string, quem: string, contexto: string, imagem?: string): Promise<string> {
  const conteudo: any = imagem ? [{ type: "text", text: texto || "(sem texto, só a imagem)" }, { type: "image_url", image_url: { url: imagem } }] : texto;
  const msgs: any[] = [{ role: "system", content: instrucoes(quem, contexto) }, { role: "user", content: conteudo }];
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: MODELO, temperature: 0.5, max_tokens: 700, tools: FERRAMENTAS, messages: msgs }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
    const m = j.choices?.[0]?.message;
    if (!m) throw new Error("resposta vazia do modelo");
    msgs.push(m);
    if (!m.tool_calls?.length) return String(m.content ?? "").trim() || "Não entendi, pode repetir?";
    for (const t of m.tool_calls) {
      let args: any = {};
      try { args = JSON.parse(t.function.arguments || "{}"); } catch (_) { /* vazio */ }
      const res = await executarFerramenta(t.function.name, args, quem);
      msgs.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify(res).slice(0, 6000) });
    }
  }
  return "Me enrolei aqui com essa pergunta. Pode tentar de outro jeito?";
}

// ---------------------------------------------------------------------
// Áudio e imagem (arquivos do Telegram, até 20 MB)
// ---------------------------------------------------------------------
async function baixarArquivo(fileId: string): Promise<Uint8Array> {
  const f = await telegram("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`não consegui baixar o arquivo (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
async function transcrever(bytes: Uint8Array, nome: string): Promise<string> {
  const f = new FormData();
  f.append("file", new Blob([bytes]), nome);
  f.append("model", "gpt-4o-mini-transcribe");
  f.append("language", "pt");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI}` }, body: f, signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`transcrição ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  return String(j.text ?? "").trim();
}
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------
// Mensagens do grupo
// ---------------------------------------------------------------------
let usuarioBot: string | null = null;
async function processar(u: any) {
  const msg = u.message;
  if (!msg) return;
  const grupo = await config("telegram_chat_id");
  // Grupo virou supergrupo: o Telegram troca o id.
  if (msg.migrate_to_chat_id && String(msg.chat?.id) === grupo) {
    await supabase.from("configuracoes").upsert({ chave: "telegram_chat_id", valor: String(msg.migrate_to_chat_id) }, { onConflict: "chave" });
    await diag(`grupo migrou para ${msg.migrate_to_chat_id}`);
    return;
  }
  if (msg.from?.is_bot) return;
  let texto = String(msg.text ?? msg.caption ?? "").trim();
  const audio = msg.voice ?? msg.audio ?? (String(msg.document?.mime_type ?? "").startsWith("audio/") ? msg.document : null);
  const foto = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1]
    : (String(msg.document?.mime_type ?? "").startsWith("image/") ? msg.document : null);
  if (!texto && !audio && !foto) return;
  if (String(msg.chat?.id) !== grupo) {
    if (msg.chat?.type === "private") await telegram("sendMessage", { chat_id: msg.chat.id, text: "Oi! Eu só converso no grupo da equipe da Sandstride. 🙂" }).catch(() => {});
    return;
  }
  if (!usuarioBot) usuarioBot = (await telegram("getMe")).username ?? "";
  const respondeABot = msg.reply_to_message?.from?.username === usuarioBot;
  const citaSandy = (t: string) => /\bsandy\b/i.test(t) || (!!usuarioBot && t.toLowerCase().includes(`@${usuarioBot.toLowerCase()}`));
  // Áudio: só transcreve se for resposta a ela ou se o áudio for curto o bastante para valer a pena conferir (até 3 min).
  if (audio && !texto && (respondeABot || Number(audio.duration ?? 0) <= 180) && Number(audio.file_size ?? 0) < 20_000_000) {
    try { texto = await transcrever(await baixarArquivo(audio.file_id), msg.voice ? "audio.ogg" : (audio.file_name ?? "audio.mp3")); }
    catch (e) { await diag(`áudio: ${e instanceof Error ? e.message : e}`); if (respondeABot) texto = "[áudio que não consegui ouvir]"; }
    if (texto && !respondeABot && !citaSandy(texto)) return; // áudio para outra pessoa do grupo
  }
  if (!(respondeABot || citaSandy(texto))) return;
  let imagem: string | undefined;
  if (foto && Number(foto.file_size ?? 0) < 15_000_000) {
    try { imagem = `data:${foto.mime_type ?? "image/jpeg"};base64,${base64(await baixarArquivo(foto.file_id))}`; }
    catch (e) { await diag(`imagem: ${e instanceof Error ? e.message : e}`); }
  }
  if (audio) texto = `(mensagem de áudio transcrita) ${texto}`;

  await telegram("sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
  const quem = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "alguém da equipe";
  let contexto = "";
  if (msg.reply_to_message) {
    const rt = String(msg.reply_to_message.text ?? msg.reply_to_message.caption ?? "");
    const ents = [...(msg.reply_to_message.entities ?? [])].map((e: any) => e.url).filter(Boolean).join(" ");
    const conv = `${rt} ${ents}`.match(/[?&]c=([0-9a-f-]{36})/);
    contexto = `${rt.slice(0, 800)}${conv ? `\n(conversa_id desta conversa: ${conv[1]})` : ""}`;
  }
  let resposta: string;
  try { resposta = await conversarComModelo(texto.replace(new RegExp(`@${usuarioBot}`, "ig"), "").trim(), quem, contexto, imagem); }
  catch (e) { await diag(`erro: ${e instanceof Error ? e.message : e}`); resposta = "Tive um problema para responder agora. Tenta de novo daqui a pouco?"; }
  // Envia em partes, com "digitando..." entre elas, como uma pessoa.
  const partes = resposta.split(/\n?\s*\|\|\|\s*\n?/).map((t) => t.trim()).filter(Boolean).slice(0, 5);
  for (let i = 0; i < partes.length; i++) {
    if (i > 0) {
      await telegram("sendChatAction", { chat_id: msg.chat.id, action: "typing" }).catch(() => {});
      await new Promise((r) => setTimeout(r, Math.min(900 + partes[i].length * 25, 3500)));
    }
    await telegram("sendMessage", {
      chat_id: msg.chat.id, text: partes[i].slice(0, 3900), disable_web_page_preview: true,
      ...(i === 0 ? { reply_to_message_id: msg.message_id } : {}),
    });
  }
}

Deno.serve(async (req) => {
  // Uso interno: registrar o webhook.
  const interno = req.headers.get("x-lucro-token");
  if (interno) {
    const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
    if (!seg?.valor || interno !== seg.valor) return new Response("não autorizado", { status: 401 });
    const corpo: any = await req.json().catch(() => ({}));
    try {
      if (corpo.registrar) {
        await telegram("setWebhook", { url: FUNCAO, secret_token: await segredoWebhook(), allowed_updates: ["message"], drop_pending_updates: true });
        const info = await telegram("getWebhookInfo");
        await diag(`webhook registrado: ${info.url} (pendentes ${info.pending_update_count})`);
      }
    } catch (e) { await diag(`registrar: ${e instanceof Error ? e.message : e}`); }
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await segredoWebhook()) return new Response("não autorizado", { status: 401 });
  const u: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil(processar(u).catch((e) => diag(`processar: ${e instanceof Error ? e.message : e}`)));
  return new Response("ok");
});
