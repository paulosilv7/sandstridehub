// Avisos de DEVOLUÇÕES no grupo do Telegram (sem link: só se o dono pedir). Chamada pelo banco com o cabeçalho x-lucro-token.
// Tipos: nova (reclamação/devolução nova), resposta (o ML voltou a pedir uma ação da loja), encerrada (o marketplace encerrou o caso).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MK: Record<string, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop" };
async function diag(m: string) { console.error("devol-avisar-telegram", m); try { await supabase.from("diagnosticos").insert({ origem: "devol-avisar-telegram", mensagem: m.slice(0, 1500) }); } catch (_) { /* */ } }

// Mensagens do ML podem vir em HTML (atendentes humanos): vira texto simples.
function texto(t: string): string {
  let x = String(t ?? "");
  if (/<[a-z][\s\S]*>/i.test(x)) x = x.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "");
  const ent: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú", "&agrave;": "à", "&acirc;": "â", "&ecirc;": "ê", "&ocirc;": "ô", "&atilde;": "ã", "&otilde;": "õ", "&ccedil;": "ç", "&Aacute;": "Á", "&Eacute;": "É", "&Ccedil;": "Ç" };
  x = x.replace(/&[a-zA-Z#0-9]+;/g, (m) => ent[m] ?? "");
  return x.replace(/\*\*/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
const corta = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

function quando(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const data = d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const h = Math.round((d.getTime() - Date.now()) / 3_600_000);
  return `${data}${h > 0 ? ` (faltam ${h} h)` : ""}`;
}

async function enviar(chat: string, linhas: (string | null)[]) {
  const msg = linhas.filter((l) => l !== null).join("\n");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram: ${j.description ?? r.status}`);
}

async function avisar(casoId: string, tipo: string) {
  if (!TOKEN) return;
  const { data: cfg } = await supabase.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
  const chat = cfg?.valor;
  if (!chat) return;
  const { data: c } = await supabase.from("devol_casos").select("id, loja_id, solicitacao_id, pedido, produto, motivo_original, tipo_origem, etapa_origem, status, prazo_em, situacao_mkt, valor_em_risco").eq("id", casoId).maybeSingle();
  if (!c) return;
  const { data: loja } = await supabase.from("lojas").select("apelido, marketplace").eq("id", c.loja_id).maybeSingle();
  const mk = MK[loja?.marketplace ?? ""] ?? loja?.marketplace ?? "";
  const identificacao = [
    `<b>Loja:</b> ${esc(loja?.apelido ?? "")} · ${esc(mk)}`,
    c.pedido ? `<b>Pedido:</b> ${esc(c.pedido)}` : null,
    `<b>Reclamação:</b> ${esc(c.solicitacao_id)}`,
  ];
  // Última mensagem do ML ou do comprador (contexto do que está acontecendo).
  const { data: ms } = await supabase.from("devol_mensagens").select("origem, texto, enviado_em").eq("caso_id", c.id).in("origem", ["mediador", "comprador"]).order("enviado_em", { ascending: false }).limit(1);
  const ultima = ms?.[0];
  const { data: sug } = await supabase.from("devol_sugestoes").select("situacao").eq("caso_id", c.id).maybeSingle();

  if (tipo === "encerrada") {
    await enviar(chat, [
      "✅ <b>DEVOLUÇÕES · CASO ENCERRADO</b>", "O marketplace encerrou este caso.", "",
      ...identificacao, "",
      "<b>Resultado:</b>", esc(c.situacao_mkt || "Encerrado pelo marketplace"),
    ]);
    return;
  }
  if (tipo === "resposta") {
    const prazo = quando(c.prazo_em);
    await enviar(chat, [
      "📦 <b>DEVOLUÇÕES · PRECISA DE RESPOSTA</b>", "O marketplace voltou a pedir uma ação da loja.", "",
      ...identificacao, "",
      sug?.situacao ? "<b>O que está acontecendo:</b>" : (ultima ? `<b>${ultima.origem === "comprador" ? "O comprador escreveu" : "Mensagem do Mercado Livre"}:</b>` : null),
      sug?.situacao ? esc(corta(sug.situacao, 380)) : (ultima ? esc(corta(texto(ultima.texto), 380)) : null),
      prazo ? "" : null,
      prazo ? "<b>Prazo:</b>" : null,
      prazo ? esc(prazo) : null,
      "", "Responda na tela Responder.",
    ]);
    return;
  }
  // nova
  const prazo = quando(c.prazo_em);
  await enviar(chat, [
    "🔔 <b>DEVOLUÇÕES · NOVO CASO</b>", `Chegou uma ${c.etapa_origem === "dispute" ? "reclamação em mediação" : "nova reclamação ou devolução"}.`, "",
    ...identificacao, "",
    ultima ? `<b>${ultima.origem === "comprador" ? "O comprador escreveu" : "Mensagem do Mercado Livre"}:</b>` : null,
    ultima ? esc(corta(texto(ultima.texto), 300)) : null,
    prazo ? "" : null,
    prazo ? "<b>Prazo da loja:</b>" : null,
    prazo ? esc(prazo) : null,
  ]);
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  EdgeRuntime.waitUntil((async () => { try { await avisar(String(corpo.caso_id ?? ""), String(corpo.tipo ?? "")); } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : e}`); } })());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
