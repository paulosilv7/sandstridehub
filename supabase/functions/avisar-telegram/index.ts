// Avisa a equipe no grupo do Telegram quando a Sandy passa uma conversa para uma pessoa.
// Chamada pelo banco (gatilho em sandy_registros) com o cabeçalho x-lucro-token.
// Modos: {registro_id}     avisa sobre um registro da Sandy
//        {descobrir: true} acha o grupo em que o bot foi adicionado e guarda o id (configuracoes.telegram_chat_id)
//        {teste: true}     manda uma mensagem de teste no grupo
// O token do bot fica no segredo TELEGRAM_BOT_TOKEN (Supabase > Edge Functions > Secrets).
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SITE = "https://sandstridehub.vercel.app";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function diag(mensagem: string) {
  console.error("avisar-telegram", mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: "avisar-telegram", mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MK: Record<string, string> = { mercado_livre: "Mercado Livre", shopee: "Shopee", tiktok_shop: "TikTok Shop" };

async function telegram(metodo: string, corpo: any = {}) {
  if (!TOKEN) throw new Error("segredo TELEGRAM_BOT_TOKEN não cadastrado");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description ?? r.status}`);
  return j.result;
}
async function grupo(): Promise<string | null> {
  const { data } = await supabase.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
  return data?.valor || null;
}

async function descobrir() {
  const ups: any[] = await telegram("getUpdates", { allowed_updates: ["message", "my_chat_member"] });
  const chats = ups.map((u) => u.message?.chat ?? u.my_chat_member?.chat).filter((c) => c && (c.type === "group" || c.type === "supergroup"));
  if (!chats.length) {
    const eu: any = await telegram("getMe").catch(() => ({}));
    const tipos = ups.map((u) => Object.keys(u).filter((k) => k !== "update_id").join("+") + ":" + (u.message?.chat?.type ?? u.my_chat_member?.chat?.type ?? "?"));
    await diag(`nenhum grupo encontrado (bot @${eu.username ?? "?"}, ${ups.length} atualizações: ${tipos.join(", ").slice(0, 400) || "nenhuma"}). Adicione o bot ao grupo e mande uma mensagem no grupo.`);
    return;
  }
  const c = chats[chats.length - 1];
  await supabase.from("configuracoes").upsert({ chave: "telegram_chat_id", valor: String(c.id) }, { onConflict: "chave" });
  await telegram("sendMessage", { chat_id: c.id, text: "✅ Sandy conectada a este grupo. Vou avisar aqui quando um cliente precisar de uma pessoa." });
  await diag(`grupo conectado: ${c.title ?? c.id}`);
}

// Troca a foto de perfil do bot (JPG publicado no site).
async function trocarFoto(url: string) {
  if (!TOKEN) throw new Error("segredo TELEGRAM_BOT_TOKEN não cadastrado");
  if (!url.startsWith(SITE + "/")) throw new Error("a foto precisa estar no site da Central");
  const img = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!img.ok) throw new Error(`não consegui baixar a foto (${img.status})`);
  const bytes = new Uint8Array(await img.arrayBuffer());
  const f = new FormData();
  f.append("photo", JSON.stringify({ type: "static", photo: "attach://foto" }));
  f.append("foto", new Blob([bytes], { type: "image/jpeg" }), "sandy.jpg");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/setMyProfilePhoto`, { method: "POST", body: f, signal: AbortSignal.timeout(20_000) });
  const j: any = await r.json().catch(() => ({}));
  await diag(j.ok ? "foto de perfil atualizada" : `foto: ${j.description ?? r.status}`);
}

async function avisar(registroId: number) {
  const chat = await grupo();
  if (!chat) return;
  const { data: r } = await supabase.from("sandy_registros").select("id, conversa_id, decisao, motivo, resposta").eq("id", registroId).maybeSingle();
  if (!r) return;
  const acolheu = r.decisao === "respondeu" && String(r.motivo ?? "").startsWith("[acolhimento]");
  if (!acolheu && !["escalou", "erro"].includes(r.decisao)) return;
  const { data: c } = await supabase.from("conversas")
    .select("id, cliente_nome, produto_titulo, ultima_mensagem_texto, lojas(nome, marketplace)").eq("id", r.conversa_id).maybeSingle();
  if (!c) return;
  const loja: any = Array.isArray(c.lojas) ? c.lojas[0] : c.lojas;
  const { data: ult } = await supabase.from("mensagens").select("texto").eq("conversa_id", c.id).eq("de", "cliente")
    .not("texto", "is", null).order("enviada_em", { ascending: false }).limit(1).maybeSingle();
  const titulo = acolheu ? "💬 <b>A Sandy acolheu o cliente — falta dar andamento</b>"
    : r.decisao === "erro" ? "⚠️ <b>A Sandy teve um problema — responda você</b>" : "🙋 <b>Precisa de uma pessoa</b>";
  const motivo = String(r.motivo ?? "").replace(/^\[acolhimento\]\s*/, "");
  const linhas = [
    titulo,
    `<b>Cliente:</b> ${esc(c.cliente_nome || "Cliente")}`,
    `<b>Loja:</b> ${esc(loja?.nome ?? "")} (${esc(MK[loja?.marketplace] ?? loja?.marketplace ?? "")})`,
    motivo ? `<b>Motivo:</b> ${esc(motivo)}` : null,
    ult?.texto ? `<b>Cliente disse:</b> “${esc(String(ult.texto).slice(0, 300))}”` : null,
    `<a href="${SITE}/chat/?c=${c.id}">Abrir a conversa</a>`,
  ].filter(Boolean).join("\n");
  await telegram("sendMessage", { chat_id: chat, text: linhas, parse_mode: "HTML", disable_web_page_preview: true });
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  const tarefa = async () => {
    try {
      if (corpo.descobrir) await descobrir();
      else if (corpo.foto_url) await trocarFoto(String(corpo.foto_url));
      else if (corpo.teste) {
        const chat = await grupo();
        if (!chat) await diag("grupo ainda não conectado");
        else { await telegram("sendMessage", { chat_id: chat, text: "🔔 Teste: avisos da Sandy funcionando." }); await diag("teste enviado"); }
      } else if (corpo.registro_id) await avisar(Number(corpo.registro_id));
    } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : e}`); }
  };
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(tarefa());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
