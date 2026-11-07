// Financeiro > comprovantes do grupo do Telegram.
// Recebe do sandy-telegram (que é dono do webhook do robô) as mensagens do grupo Financeiro,
// lê o comprovante (foto ou PDF) com IA, barra repetidos e deixa "para confirmar" na tela Despesas.
// Nada vira despesa sem o toque em Confirmar na Central.
// Autenticação: cabeçalho x-fin-token (mesmo segredo derivado do webhook do Telegram).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("FIN_MODELO") ?? "gpt-4.1-mini";
const SITE = "https://sandstridehub.vercel.app";
const supabase = createClient(URL_BASE, CHAVE, { auth: { persistSession: false, autoRefreshToken: false } });
const brl = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function segredoWebhook(): Promise<string> {
  const { data } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`telegram:${data?.valor ?? ""}`));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function diag(m: string) {
  console.error("financeiro-telegram", m);
  try { await supabase.from("diagnosticos").insert({ origem: "financeiro-telegram", mensagem: m.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function telegram(metodo: string, corpo: any = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description ?? r.status}`);
  return j.result;
}
async function baixar(fileId: string): Promise<Uint8Array> {
  const f = await telegram("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function sha256(b: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", b);
  return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// O valor da conta fixa é só uma previsão: aceita até 40% de diferença, desde que só UMA conta da lista caiba.
const perto = (lista: any[], valor: number) => { const ok = lista.filter((c: any) => Math.abs(+c.valor - valor) <= +c.valor * 0.4); return ok.length === 1 ? ok[0] : null; };

async function ler(mime: string, bytes: Uint8Array, nome: string, categorias: string[], legenda = ""): Promise<any> {
  const dados = `data:${mime};base64,${base64(bytes)}`;
  const parte = mime === "application/pdf"
    ? { type: "file", file: { filename: nome, file_data: dados } }
    : { type: "image_url", image_url: { url: dados } };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: MODELO, temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "comprovante", strict: true, schema: {
        type: "object", additionalProperties: false,
        required: ["e_comprovante", "tipo", "valor", "data", "favorecido", "id_transacao", "descricao", "categoria", "pagador_nome", "pagador_documento", "pagador_instituicao", "mes_referencia", "conta_ref"],
        properties: {
          e_comprovante: { type: "boolean" },
          tipo: { type: "string", enum: ["Pix", "Boleto", "TED", "Cartão", "DAS", "Nota fiscal", "Outro"] },
          valor: { type: "number" },
          data: { type: "string" },
          favorecido: { type: "string" },
          id_transacao: { type: "string" },
          descricao: { type: "string" },
          categoria: { type: "string", enum: [...categorias, ""] },
          pagador_nome: { type: "string" },
          pagador_documento: { type: "string" },
          pagador_instituicao: { type: "string" },
          mes_referencia: { type: "string" },
          conta_ref: { type: "string", enum: ["", "I", "II", "III"] },
        } } } },
      messages: [
        { role: "system", content: "Você lê comprovantes de pagamento brasileiros (Pix, boleto, TED, DAS, notas e recibos) de uma loja de tênis. Devolva só os dados que aparecem no documento. valor em reais como número (ex.: 85.98). data no formato AAAA-MM-DD (data do pagamento ou, se não houver, a do documento); vazio se não achar. favorecido = quem RECEBEU o dinheiro (nome ou empresa). id_transacao = ID da transação Pix (E2E, começa com E) ou código de autenticação; vazio se não houver. descricao = frase curta do que foi pago. categoria = a que melhor combina entre as permitidas, ou vazio se não tiver certeza. pagador_nome = quem PAGOU (titular da conta de origem, o campo \"De\", \"Pagador\" ou \"Origem\"); pagador_documento = CPF/CNPJ dele como aparece (mesmo mascarado); pagador_instituicao = banco ou instituição de origem (ex.: Mercado Pago, Sicoob, Nubank); vazio se não houver. mes_referencia = o mês a que o pagamento SE REFERE, no formato AAAA-MM, só se a legenda enviada junto disser (ex.: \"aluguel de outubro\" => o outubro mais plausível, do ano do pagamento ou do anterior); vazio se a legenda não disser. conta_ref = \"I\", \"II\" ou \"III\" só se a legenda disser de qual empresa/conta (ex.: \"da II\"); vazio se não disser. e_comprovante=false se a imagem não for um comprovante ou documento de pagamento." },
        { role: "user", content: [{ type: "text", text: legenda ? `Leia este comprovante. Legenda enviada junto pela equipe: \"${legenda.slice(0, 400)}\"` : "Leia este comprovante." }, parte] },
      ],
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
  return JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
}

async function processar(u: any) {
  const msg = u.message;
  if (!msg) return;
  const chat = msg.chat.id;
  const doc = msg.document;
  const mimeDoc = String(doc?.mime_type ?? "");
  const foto = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : (mimeDoc.startsWith("image/") ? doc : null);
  const pdf = mimeDoc === "application/pdf" ? doc : null;
  const arq = foto ?? pdf;
  if (!arq) { // sem arquivo: texto com valor ("Nota Fiscal R$2100") vira lançamento; senão, só reage a complemento ("é de outubro", "da II")
    if (await lancamentoTexto(msg)) return;
    return complementar(msg);
  }
  const quem = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "alguém";
  const responder = (t: string) => telegram("sendMessage", { chat_id: chat, text: t, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true }).catch(() => {});
  if (Number(arq.file_size ?? 0) > 15_000_000) return responder("Esse arquivo é grande demais (máx. 15 MB).");
  await telegram("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});

  const bytes = await baixar(arq.file_id);
  const hash = await sha256(bytes);
  const { data: ja } = await supabase.from("financeiro_comprovantes").select("id,valor,favorecido,criado_em,estado").eq("sha256", hash).maybeSingle();
  if (ja) return responder(`Esse comprovante já foi enviado antes${ja.valor ? ` (${brl(+ja.valor)}${ja.favorecido ? " · " + ja.favorecido : ""})` : ""}. Não criei nada de novo.`);

  const { data: cats } = await supabase.from("financeiro_categorias").select("nome").order("ordem");
  const nomes = (cats ?? []).map((c: any) => c.nome);
  const mime = pdf ? "application/pdf" : (foto?.mime_type ?? "image/jpeg");
  let l: any;
  const legenda = String(msg.caption ?? "").trim();
  try { l = await ler(mime, bytes, pdf?.file_name ?? "comprovante.pdf", nomes, legenda); }
  catch (e) { await diag(`leitura: ${e instanceof Error ? e.message : e}`); return responder("Não consegui ler esse arquivo agora. Tenta enviar de novo daqui a pouco?"); }
  if (!l.e_comprovante || !(Number(l.valor) > 0)) return responder("Isso não parece um comprovante de pagamento (ou não achei o valor). Se for, tenta mandar uma foto mais nítida.");

  const valor = Math.round(Number(l.valor) * 100) / 100;
  const data = /^\d{4}-\d{2}-\d{2}$/.test(l.data) ? l.data : null;
  const e2e = String(l.id_transacao ?? "").trim() || null;
  let repetido: any = null;
  if (e2e) { const { data: x } = await supabase.from("financeiro_comprovantes").select("id,valor,favorecido").eq("e2e_id", e2e).neq("estado", "descartado").limit(1).maybeSingle(); repetido = x; }
  if (!repetido && data) { const { data: x } = await supabase.from("financeiro_comprovantes").select("id,valor,favorecido").eq("valor", valor).eq("data_pagamento", data).ilike("favorecido", String(l.favorecido ?? "").slice(0, 12) + "%").neq("estado", "descartado").limit(1).maybeSingle(); repetido = x; }

  // casa com conta fixa do mês ainda não paga
  let conta: any = null, liga = "";
  const mesRef = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(l.mes_referencia ?? "")) ? String(l.mes_referencia) : null;
  const mes = (mesRef ?? (data ?? new Date().toISOString().slice(0, 10)).slice(0, 7)) + "-01";
  const { data: contas } = await supabase.from("financeiro_contas_fixas").select("id,nome,categoria,valor,dia").eq("ativa", true);
  const { data: pagas } = await supabase.from("financeiro_contas_pagas").select("conta_id").eq("mes", mes);
  const jaPagas = new Set((pagas ?? []).map((p: any) => p.conta_id));
  const fav = norm(String(l.favorecido ?? "") + " " + String(l.descricao ?? ""));
  let melhor = 0;
  // Regras aprendidas na planilha / nas confirmações: o termo no favorecido ou na descrição manda na categoria (e na conta fixa, se houver).
  const { data: regras } = await supabase.from("financeiro_regras").select("termo,categoria,conta_fixa_id");
  const regra = (regras ?? []).filter((r: any) => ` ${fav} `.includes(` ${norm(r.termo)} `)).sort((a: any, b: any) => b.termo.length - a.termo.length)[0];
  if (regra?.conta_fixa_id && !jaPagas.has(regra.conta_fixa_id)) conta = (contas ?? []).find((c: any) => c.id === regra.conta_fixa_id) ?? null;
  for (const c of conta ? [] : contas ?? []) {
    if (jaPagas.has(c.id)) continue;
    const palavras = norm(c.nome).split(" ").filter((p) => p.length > 2 && !/^\d+$/.test(p) && !["fixa", "conta"].includes(p));
    const nome = palavras.length && palavras.every((p) => fav.includes(p));
    const val = Math.abs(+c.valor - valor) <= Math.max(0.5, +c.valor * 0.01);
    const score = (nome ? 2 : 0) + (val ? 1 : 0);
    if (nome && score > melhor) { melhor = score; conta = c; }
  }
  // A conta que pagou diz qual das contas fixas é: pago pela Sandstride II => a conta "... II" da categoria, pelo valor.
  const { data: origens } = await supabase.from("financeiro_contas_origem").select("termo,rotulo");
  const pag = norm(String(l.pagador_nome ?? "") + " " + String(l.pagador_documento ?? ""));
  const dig = (t: string) => String(t ?? "").replace(/\D/g, "");
  const pagDig = dig(`${l.pagador_documento ?? ""}`);
  // Documento: compara só os números (o leitor às vezes devolve 58.258.487, às vezes 58258487 ou 58986174NOME).
  const origem = (origens ?? []).find((o: any) => dig(o.termo).length >= 6 ? pagDig.includes(dig(o.termo)) : ` ${pag} `.includes(` ${norm(o.termo)} `));
  const sufixo = l.conta_ref || (origem ? String(origem.rotulo).trim().split(/\s+/).pop()!.toUpperCase() : "");
  const catAlvo = regra?.categoria ?? l.categoria ?? "";
  if (!conta && /^(I|II|III)$/.test(sufixo) && catAlvo) {
    const doSufixo = (contas ?? []).filter((c: any) => !jaPagas.has(c.id) && c.categoria === catAlvo && String(c.nome).trim().toUpperCase().split(/\s+/).pop() === sufixo);
    const exatas = doSufixo.filter((c: any) => Math.abs(+c.valor - valor) <= Math.max(0.5, +c.valor * 0.01));
    conta = exatas.length === 1 ? exatas[0] : doSufixo.length === 1 ? doSufixo[0] : perto(doSufixo, valor);
  }
  // Sem nome que case, mas com regra de categoria: se só UMA conta fixa dessa categoria tem este valor, é ela.
  if (!conta && regra) {
    const naCat = (contas ?? []).filter((c: any) => !jaPagas.has(c.id) && c.categoria === regra.categoria);
    const iguais = naCat.filter((c: any) => Math.abs(+c.valor - valor) <= Math.max(0.5, +c.valor * 0.01));
    conta = iguais.length === 1 ? iguais[0] : perto(naCat, valor);
  }
  if (conta) liga = `Baixa a conta fixa ${conta.nome} (vence dia ${conta.dia})${mesRef ? " de " + MESES[+mesRef.slice(5) - 1] + "/" + mesRef.slice(0, 4) : ""}`;

  const path = `telegram/${hash}.${pdf ? "pdf" : "jpg"}`;
  const up = await supabase.storage.from("financeiro-comprovantes").upload(path, bytes, { contentType: mime, upsert: true });
  if (up.error) await diag(`upload: ${up.error.message}`);
  const linha = {
    sha256: hash, chat_id: String(chat), message_id: msg.message_id, enviado_por: quem, tipo: l.tipo, valor, data_pagamento: data,
    favorecido: String(l.favorecido ?? "").slice(0, 120) || null, e2e_id: e2e, descricao: String(l.descricao ?? "").slice(0, 200) || null,
    categoria_sugerida: (regra?.categoria ?? conta?.categoria ?? l.categoria) || null, conta_fixa_id: conta?.id ?? null,
    liga: repetido ? `Parece repetido: já existe um comprovante de ${brl(+repetido.valor)}${repetido.favorecido ? " para " + repetido.favorecido : ""}.` : liga || null,
    pagador_nome: String(l.pagador_nome ?? "").slice(0, 120) || null, pagador_documento: String(l.pagador_documento ?? "").slice(0, 40) || null, pagador_instituicao: String(l.pagador_instituicao ?? "").slice(0, 60) || null,
    legenda: legenda || null, mes_referencia: mesRef ? mesRef + "-01" : null,
    arquivo_path: up.error ? null : path, estado: repetido ? "repetido" : "novo",
  };
  const ins = await supabase.from("financeiro_comprovantes").insert(linha);
  if (ins.error) { await diag(`inserir: ${ins.error.message}`); return responder("Li o comprovante, mas não consegui guardar. Tenta de novo?"); }
  if (repetido) return responder(`Esse parece repetido (${brl(valor)}${l.favorecido ? " · " + l.favorecido : ""}). Deixei sinalizado na Central, nada foi lançado.`);
  await responder(`Li: ${l.tipo} de ${brl(valor)}${l.favorecido ? " para " + l.favorecido : ""}${data ? " em " + data.split("-").reverse().join("/") : ""}${linha.categoria_sugerida ? ` → ${linha.categoria_sugerida}` : ""}.${conta ? ` Combina com a conta fixa ${conta.nome}.` : ""}${mesRef ? ` Anotei: referente a ${MESES[+mesRef.slice(5) - 1]}/${mesRef.slice(0, 4)}.` : ""}\nConfirme na Central: ${SITE}/financeiro/#despesas`);
}

// Texto sem arquivo com um valor em reais ("Nota Fiscal R$2100", "pix 350 para o motoboy"): vira um lançamento "para confirmar".
async function lancamentoTexto(msg: any): Promise<boolean> {
  const texto = String(msg.text ?? "").trim();
  if (!texto || texto.length > 300 || !/(r\$\s*\d|\d\s*reais|\b\d{2,}([.,]\d{1,3})*\b)/i.test(texto)) return false;
  const chat = msg.chat.id;
  const responder = (t: string) => telegram("sendMessage", { chat_id: chat, text: t, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, disable_web_page_preview: true }).catch(() => {});
  const quem = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "alguém";
  const { data: cats } = await supabase.from("financeiro_categorias").select("nome").order("ordem");
  const nomes = (cats ?? []).map((c: any) => c.nome);
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: MODELO, temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "lancamento", strict: true, schema: { type: "object", additionalProperties: false,
        required: ["e_gasto", "tipo", "valor", "data", "favorecido", "descricao", "categoria", "mes_referencia", "conta_ref"],
        properties: { e_gasto: { type: "boolean" }, tipo: { type: "string", enum: ["Pix", "Boleto", "TED", "Cartão", "DAS", "Nota fiscal", "Outro"] }, valor: { type: "number" }, data: { type: "string" }, favorecido: { type: "string" }, descricao: { type: "string" }, categoria: { type: "string", enum: [...nomes, ""] }, mes_referencia: { type: "string" }, conta_ref: { type: "string", enum: ["", "I", "II", "III"] } } } } },
      messages: [
        { role: "system", content: `Hoje é ${hoje}. A equipe de uma loja de tênis escreveu uma mensagem no grupo Financeiro. e_gasto=true só se a mensagem registra um pagamento ou gasto com valor em reais (ex.: "Nota Fiscal R$2100", "pix 350 motoboy"); false para conversa comum. valor como número. data AAAA-MM-DD só se a mensagem disser; vazio se não disser. favorecido = quem recebe, só se disser. descricao = frase curta do gasto. categoria = a que melhor combina entre as permitidas, ou vazio se não tiver certeza. mes_referencia AAAA-MM só se a mensagem disser o mês a que se refere. conta_ref "I", "II" ou "III" só se disser a empresa/conta.` },
        { role: "user", content: texto }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) { await diag(`lancamento IA ${r.status}`); await responder("Vi sua mensagem, mas não consegui ler agora. Tenta de novo daqui a pouco?"); return true; }
  const l = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
  if (!l.e_gasto || !(Number(l.valor) > 0)) return false;
  const valor = Math.round(Number(l.valor) * 100) / 100;
  const data = /^\d{4}-\d{2}-\d{2}$/.test(l.data) ? l.data : null;
  const mesRef = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(l.mes_referencia ?? "")) ? String(l.mes_referencia) : null;
  const fav = norm(String(l.favorecido ?? "") + " " + String(l.descricao ?? "") + " " + texto);
  const { data: regras } = await supabase.from("financeiro_regras").select("termo,categoria,conta_fixa_id");
  const regra = (regras ?? []).filter((x: any) => ` ${fav} `.includes(` ${norm(x.termo)} `)).sort((a: any, b: any) => b.termo.length - a.termo.length)[0];
  const mes = (mesRef ?? (data ?? hoje).slice(0, 7)) + "-01";
  const { data: contas } = await supabase.from("financeiro_contas_fixas").select("id,nome,categoria,valor,dia").eq("ativa", true);
  const { data: pagas } = await supabase.from("financeiro_contas_pagas").select("conta_id").eq("mes", mes);
  const jaPagas = new Set((pagas ?? []).map((p: any) => p.conta_id));
  let conta: any = regra?.conta_fixa_id && !jaPagas.has(regra.conta_fixa_id) ? (contas ?? []).find((c: any) => c.id === regra.conta_fixa_id) ?? null : null;
  if (!conta) for (const c of contas ?? []) {
    if (jaPagas.has(c.id)) continue;
    const palavras = norm(c.nome).split(" ").filter((p) => p.length > 2 && !/^\d+$/.test(p) && !["fixa", "conta"].includes(p));
    if (palavras.length && palavras.every((p) => fav.includes(p))) { conta = c; break; }
  }
  const hash = await sha256(new TextEncoder().encode(`texto:${chat}:${msg.message_id}`));
  const ins = await supabase.from("financeiro_comprovantes").insert({
    sha256: hash, chat_id: String(chat), message_id: msg.message_id, enviado_por: quem, tipo: l.tipo, valor, data_pagamento: data ?? hoje,
    favorecido: String(l.favorecido ?? "").slice(0, 120) || null, descricao: String(l.descricao ?? "").slice(0, 200) || null,
    categoria_sugerida: (regra?.categoria ?? conta?.categoria ?? l.categoria) || null, conta_fixa_id: conta?.id ?? null,
    liga: conta ? `Baixa a conta fixa ${conta.nome} (vence dia ${conta.dia})` : null, legenda: texto.slice(0, 400),
    mes_referencia: mesRef ? mesRef + "-01" : null, arquivo_path: null, estado: "novo",
  });
  if (ins.error) { await diag(`lancamento inserir: ${ins.error.message}`); await responder("Entendi o gasto, mas não consegui guardar. Tenta de novo?"); return true; }
  const cat = (regra?.categoria ?? conta?.categoria ?? l.categoria) || "";
  await responder(`Anotei: ${l.tipo} de ${brl(valor)}${l.favorecido ? " para " + l.favorecido : ""}${cat ? ` → ${cat}` : ""}${data ? " em " + data.split("-").reverse().join("/") : ""}. Sem comprovante anexado.${conta ? ` Combina com a conta fixa ${conta.nome}.` : ""}\nConfirme na Central: ${SITE}/financeiro/#despesas`);
  return true;
}

// Texto sem arquivo, logo depois de um comprovante (ou respondendo a ele): "é de outubro", "da II".
async function complementar(msg: any) {
  const texto = String(msg.text ?? "").trim();
  if (!texto || texto.length > 300 || !/(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|m[eê]s|referente|\b(I|II|III)\b)/i.test(texto)) return;
  const quem = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
  let alvo: any = null;
  if (msg.reply_to_message?.message_id) {
    const { data } = await supabase.from("financeiro_comprovantes").select("*").eq("chat_id", String(msg.chat.id)).eq("message_id", msg.reply_to_message.message_id).eq("estado", "novo").maybeSingle();
    alvo = data;
  }
  if (!alvo) {
    const desde = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data } = await supabase.from("financeiro_comprovantes").select("*").eq("chat_id", String(msg.chat.id)).eq("estado", "novo").eq("enviado_por", quem).gt("criado_em", desde).order("criado_em", { ascending: false }).limit(1).maybeSingle();
    alvo = data;
  }
  if (!alvo) return;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: MODELO, temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "complemento", strict: true, schema: { type: "object", additionalProperties: false, required: ["mes_referencia", "conta_ref"], properties: { mes_referencia: { type: "string" }, conta_ref: { type: "string", enum: ["", "I", "II", "III"] } } } } },
      messages: [
        { role: "system", content: `Pagamento de ${alvo.data_pagamento ?? "data desconhecida"} (${alvo.favorecido ?? ""}). A equipe escreveu um complemento. mes_referencia = mês a que o pagamento se refere no formato AAAA-MM (ex.: "é de outubro" => o outubro mais plausível, do ano do pagamento ou do anterior); vazio se não disser. conta_ref = "I", "II" ou "III" só se o texto disser de qual empresa/conta; vazio se não disser.` },
        { role: "user", content: texto }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) return;
  const c = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
  const mesRef = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c.mes_referencia ?? "")) ? String(c.mes_referencia) : null;
  if (!mesRef && !c.conta_ref) return;
  const upd: any = { legenda: [alvo.legenda, texto].filter(Boolean).join(" | ").slice(0, 400) };
  const partes: string[] = [];
  if (mesRef) { upd.mes_referencia = mesRef + "-01"; partes.push(`referente a ${MESES[+mesRef.slice(5) - 1]}/${mesRef.slice(0, 4)}`); }
  if (c.conta_ref && alvo.categoria_sugerida) {
    const { data: contas } = await supabase.from("financeiro_contas_fixas").select("id,nome,categoria,valor,dia").eq("ativa", true);
    const doSuf = (contas ?? []).filter((k: any) => k.categoria === alvo.categoria_sugerida && String(k.nome).trim().toUpperCase().split(/\s+/).pop() === c.conta_ref);
    const exatas = doSuf.filter((k: any) => Math.abs(+k.valor - +alvo.valor) <= Math.max(0.5, +k.valor * 0.01));
    const achou = exatas.length === 1 ? exatas[0] : doSuf.length === 1 ? doSuf[0] : perto(doSuf, +alvo.valor);
    if (achou) { upd.conta_fixa_id = achou.id; upd.liga = `Baixa a conta fixa ${achou.nome} (vence dia ${achou.dia})`; partes.push(`conta ${achou.nome}`); }
  }
  await supabase.from("financeiro_comprovantes").update(upd).eq("id", alvo.id);
  if (partes.length) await telegram("sendMessage", { chat_id: msg.chat.id, text: `Anotei no comprovante de ${brl(+alvo.valor)}: ${partes.join(" e ")}.`, reply_to_message_id: msg.message_id, allow_sending_without_reply: true }).catch(() => {});
}

// Relê comprovantes já guardados que ainda não têm o pagador (uso interno).
async function reler() {
  const { data: cats } = await supabase.from("financeiro_categorias").select("nome").order("ordem");
  const nomes = (cats ?? []).map((c: any) => c.nome);
  const { data: rows } = await supabase.from("financeiro_comprovantes").select("id,arquivo_path").is("pagador_nome", null).not("arquivo_path", "is", null).limit(20);
  for (const r of rows ?? []) {
    try {
      const { data: blob, error } = await supabase.storage.from("financeiro-comprovantes").download(r.arquivo_path);
      if (error || !blob) { await diag(`reler baixar ${r.id}: ${error?.message}`); continue; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const pdf = r.arquivo_path.endsWith(".pdf");
      const l = await ler(pdf ? "application/pdf" : "image/jpeg", bytes, "comprovante.pdf", nomes);
      await supabase.from("financeiro_comprovantes").update({
        pagador_nome: String(l.pagador_nome ?? "").slice(0, 120) || "—", pagador_documento: String(l.pagador_documento ?? "").slice(0, 40) || null, pagador_instituicao: String(l.pagador_instituicao ?? "").slice(0, 60) || null,
      }).eq("id", r.id);
    } catch (e) { await diag(`reler ${r.id}: ${e instanceof Error ? e.message : e}`); }
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-fin-token") !== await segredoWebhook()) return new Response("não autorizado", { status: 401 });
  const u: any = await req.json().catch(() => ({}));
  if (u?.reler) { await reler(); return new Response("ok"); }
  try { await processar(u); } catch (e) { await diag(`processar: ${e instanceof Error ? e.message : e}`); }
  return new Response("ok");
});
