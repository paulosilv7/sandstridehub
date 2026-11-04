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
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function ler(mime: string, bytes: Uint8Array, nome: string, categorias: string[]): Promise<any> {
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
        required: ["e_comprovante", "tipo", "valor", "data", "favorecido", "id_transacao", "descricao", "categoria", "pagador_nome", "pagador_documento", "pagador_instituicao"],
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
        } } } },
      messages: [
        { role: "system", content: "Você lê comprovantes de pagamento brasileiros (Pix, boleto, TED, DAS, notas e recibos) de uma loja de tênis. Devolva só os dados que aparecem no documento. valor em reais como número (ex.: 85.98). data no formato AAAA-MM-DD (data do pagamento ou, se não houver, a do documento); vazio se não achar. favorecido = quem RECEBEU o dinheiro (nome ou empresa). id_transacao = ID da transação Pix (E2E, começa com E) ou código de autenticação; vazio se não houver. descricao = frase curta do que foi pago. categoria = a que melhor combina entre as permitidas, ou vazio se não tiver certeza. pagador_nome = quem PAGOU (titular da conta de origem, o campo "De", "Pagador" ou "Origem"); pagador_documento = CPF/CNPJ dele como aparece (mesmo mascarado); pagador_instituicao = banco ou instituição de origem (ex.: Mercado Pago, Sicoob, Nubank); vazio se não houver. e_comprovante=false se a imagem não for um comprovante ou documento de pagamento." },
        { role: "user", content: [{ type: "text", text: "Leia este comprovante." }, parte] },
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
  if (!arq) return; // só reage a foto ou PDF; conversa normal do grupo é ignorada
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
  try { l = await ler(mime, bytes, pdf?.file_name ?? "comprovante.pdf", nomes); }
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
  const mes = (data ?? new Date().toISOString().slice(0, 10)).slice(0, 7) + "-01";
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
  // Sem nome que case, mas com regra de categoria: se só UMA conta fixa dessa categoria tem este valor, é ela.
  if (!conta && regra) {
    const iguais = (contas ?? []).filter((c: any) => !jaPagas.has(c.id) && c.categoria === regra.categoria && Math.abs(+c.valor - valor) <= Math.max(0.5, +c.valor * 0.01));
    if (iguais.length === 1) conta = iguais[0];
  }
  if (conta) liga = `Baixa a conta fixa ${conta.nome} (vence dia ${conta.dia})`;

  const path = `telegram/${hash}.${pdf ? "pdf" : "jpg"}`;
  const up = await supabase.storage.from("financeiro-comprovantes").upload(path, bytes, { contentType: mime, upsert: true });
  if (up.error) await diag(`upload: ${up.error.message}`);
  const linha = {
    sha256: hash, chat_id: String(chat), message_id: msg.message_id, enviado_por: quem, tipo: l.tipo, valor, data_pagamento: data,
    favorecido: String(l.favorecido ?? "").slice(0, 120) || null, e2e_id: e2e, descricao: String(l.descricao ?? "").slice(0, 200) || null,
    categoria_sugerida: (regra?.categoria ?? conta?.categoria ?? l.categoria) || null, conta_fixa_id: conta?.id ?? null,
    liga: repetido ? `Parece repetido: já existe um comprovante de ${brl(+repetido.valor)}${repetido.favorecido ? " para " + repetido.favorecido : ""}.` : liga || null,
    pagador_nome: String(l.pagador_nome ?? "").slice(0, 120) || null, pagador_documento: String(l.pagador_documento ?? "").slice(0, 40) || null, pagador_instituicao: String(l.pagador_instituicao ?? "").slice(0, 60) || null,
    arquivo_path: up.error ? null : path, estado: repetido ? "repetido" : "novo",
  };
  const ins = await supabase.from("financeiro_comprovantes").insert(linha);
  if (ins.error) { await diag(`inserir: ${ins.error.message}`); return responder("Li o comprovante, mas não consegui guardar. Tenta de novo?"); }
  if (repetido) return responder(`Esse parece repetido (${brl(valor)}${l.favorecido ? " · " + l.favorecido : ""}). Deixei sinalizado na Central, nada foi lançado.`);
  await responder(`Li: ${l.tipo} de ${brl(valor)}${l.favorecido ? " para " + l.favorecido : ""}${data ? " em " + data.split("-").reverse().join("/") : ""}${linha.categoria_sugerida ? ` → ${linha.categoria_sugerida}` : ""}.${conta ? ` Combina com a conta fixa ${conta.nome}.` : ""}\nConfirme na Central: ${SITE}/financeiro/#despesas`);
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
