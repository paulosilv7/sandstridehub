// Devoluções: rotina diária que apaga as fotos/vídeos (e miniaturas) dos casos já conciliados ou encerrados (depois do prazo de retenção)
// e avisa no Telegram quando o armazenamento passa do percentual combinado.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const ORIGEM = "devol-limpar-fotos";
const BUCKET = "devol-provas";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function diag(mensagem: string) {
  console.error(ORIGEM, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

async function config(chave: string): Promise<string | null> {
  const { data } = await supabase.from("devol_config").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor ?? null;
}

async function telegram(texto: string) {
  const tok = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const { data: cfg } = await supabase.from("configuracoes").select("valor").eq("chave", "telegram_chat_id").maybeSingle();
  if (!tok || !cfg?.valor) return;
  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: cfg.valor, text: texto }) }).catch(() => null);
}

async function apagar(): Promise<{ casos: number; arquivos: number }> {
  const { data: lista, error } = await supabase.from("devol_fotos_a_excluir").select("anexo_id, caso_id, caminho").limit(500);
  if (error) throw new Error(`erro ao listar fotos a excluir: ${error.message}`);
  const porCaso = new Map<string, { id: string; caminho: string }[]>();
  for (const r of lista ?? []) {
    const l = porCaso.get(r.caso_id) ?? [];
    l.push({ id: r.anexo_id, caminho: r.caminho });
    porCaso.set(r.caso_id, l);
  }
  let arquivos = 0, casos = 0;
  for (const [casoId, anexos] of porCaso) {
    const { data: caso } = await supabase.from("devol_casos").select("status, fotos_excluir_em, fotos_excluidas_em").eq("id", casoId).maybeSingle();
    if (!caso || caso.fotos_excluidas_em || !caso.fotos_excluir_em || new Date(caso.fotos_excluir_em).getTime() > Date.now() || !["CONCILIADO", "ENCERRADO"].includes(caso.status)) continue;
    const { error: ee } = await supabase.storage.from(BUCKET).remove(anexos.flatMap((a) => [a.caminho, `${a.caminho}.t.jpg`]));
    if (ee) { await diag(`erro ao apagar arquivos do caso ${casoId}: ${ee.message}`); continue; }
    const agora = new Date().toISOString();
    await supabase.from("devol_anexos").update({ estado: "excluido", excluido_em: agora }).in("id", anexos.map((a) => a.id));
    const { count } = await supabase.from("devol_anexos").select("id", { count: "exact", head: true }).eq("caso_id", casoId).neq("estado", "excluido");
    if (!count) await supabase.from("devol_casos").update({ fotos_excluidas_em: agora }).eq("id", casoId);
    await supabase.from("devol_eventos").upsert({
      caso_id: casoId, tipo: "fotos_excluidas", evento_chave: `fotos-excluidas:${casoId}:${agora.slice(0, 10)}`,
      dados: { arquivos: anexos.length, motivo: "caso conciliado/encerrado e prazo de retenção cumprido" },
    }, { onConflict: "evento_chave", ignoreDuplicates: true });
    arquivos += anexos.length; casos++;
  }
  return { casos, arquivos };
}

async function alertaArmazenamento() {
  const limite = Number(await config("limite_armazenamento_bytes")) || 1_073_741_824;
  const pct = Number(await config("aviso_armazenamento_pct")) || 70;
  const { data: usado } = await supabase.rpc("devol_uso_armazenamento");
  const bytes = Number(usado) || 0;
  const atual = Math.round((bytes / limite) * 100);
  await supabase.from("devol_config").upsert({ chave: "armazenamento_uso_pct", valor: String(atual), descricao: "Percentual do limite de arquivos em uso (atualizado pela rotina diária)", atualizado_em: new Date().toISOString() });
  if (atual >= pct) {
    await diag(`ATENÇÃO: armazenamento de arquivos em ${atual}% do limite (${Math.round(bytes / 1048576)} MB). Avalie o plano Pro.`);
    await telegram(`⚠️ DEVOLUÇÕES · Armazenamento de fotos em ${atual}% do limite (${Math.round(bytes / 1048576)} MB de ${Math.round(limite / 1048576)} MB). Vale conferir o consumo no painel do Supabase (Usage) e avaliar o plano Pro.`);
  }
  return atual;
}

async function executar() {
  try {
    if ((await config("kill_switch")) === "true") { await diag("kill_switch ligado: limpeza não executada"); return; }
    const r = await apagar();
    const uso = await alertaArmazenamento();
    await supabase.from("devol_config").upsert({ chave: "ultima_limpeza_fotos", valor: JSON.stringify({ em: new Date().toISOString(), ...r, armazenamento_pct: uso }), descricao: "Resultado da última rotina de exclusão de fotos", atualizado_em: new Date().toISOString() });
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : String(e)}`); }
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  EdgeRuntime.waitUntil(executar());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
