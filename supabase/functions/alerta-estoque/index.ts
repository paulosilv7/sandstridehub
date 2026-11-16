// Alerta diário de estoque (09h, horário de Brasília) no grupo do Telegram, só para os modelos escolhidos.
// Regra: cada entrada da grade é analisada como o estoque a divide (Running em pares "34/35"; Marts/Ross em tamanhos soltos).
//   🟡 CRÍTICO: menos que o mínimo (padrão 3). 🟠 ESGOTADO: zerou, mas o tamanho vizinho (34/35, 36/37...) ainda cobre -> pedir ao fornecedor.
//   🔴 SEM SAÍDA: zerou e não há vizinho para cobrir. ⚠️ gravidade extra quando o vizinho também está baixo.
// Configuração (tabela configuracoes): estoque_alerta_modelos (ex.: RUNNING,MARTS,ROSS) e estoque_alerta_minimo (ex.: 3).
// Chamada pelo banco (cron) com x-lucro-token. {simular:true} grava o texto em diagnosticos sem enviar.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const FUSO = "America/Sao_Paulo";

async function diag(mensagem: string) {
  console.error("alerta-estoque", mensagem);
  try { await supabase.from("diagnosticos").insert({ origem: "alerta-estoque", mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
async function config(chave: string): Promise<string | null> {
  const { data } = await supabase.from("configuracoes").select("valor").eq("chave", chave).maybeSingle();
  return data?.valor || null;
}
const bonito = (t: string) => t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

type Item = { modelo: string; cor: string; tam: string; qtd: number; viz: { tam: string; qtd: number } | null };

async function montar(): Promise<{ texto: string | null }> {
  const modelos = (await config("estoque_alerta_modelos") ?? "RUNNING,MARTS,ROSS").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const minimo = Number(await config("estoque_alerta_minimo")) || 3;
  const { data: prods } = await supabase.from("est_produtos").select("codigo, produto, cor").eq("ativo", true).in("produto", modelos);
  const codigos = (prods ?? []).map((p: any) => p.codigo);
  const { data: grade } = codigos.length ? await supabase.from("est_grade").select("codigo, tamanho, quantidade").in("codigo", codigos) : { data: [] as any[] };
  const info = new Map((prods ?? []).map((p: any) => [p.codigo, p]));
  const qtdDe = new Map<string, number>();
  for (const g of grade ?? []) qtdDe.set(`${g.codigo}|${String(g.tamanho).trim()}`, Number(g.quantidade) || 0);

  // Cada entrada da grade é analisada como o estoque a divide (ex.: "36/37" no Running, "36" e "37" soltos no Marts/Ross).
  // O tamanho vizinho (34/35, 36/37, ...) só existe quando a grade tem tamanhos soltos e serve de gravidade extra.
  const itens: Item[] = [];
  for (const g of grade ?? []) {
    const p: any = info.get(g.codigo); if (!p) continue;
    const tam = String(g.tamanho).trim(), n = /^\d+$/.test(tam) ? Number(tam) : NaN;
    let viz: Item["viz"] = null;
    if (!Number.isNaN(n)) {
      const t = String(n % 2 === 0 ? n + 1 : n - 1), q = qtdDe.get(`${g.codigo}|${t}`);
      if (q !== undefined) viz = { tam: t, qtd: q };
    }
    itens.push({ modelo: bonito(p.produto), cor: bonito(p.cor ?? ""), tam, qtd: Number(g.quantidade) || 0, viz });
  }
  const semSaida: Item[] = [], esgotados: Item[] = [], criticos: Item[] = [];
  for (const i of itens) {
    if (i.qtd >= minimo) continue;
    if (i.qtd <= 0 && (!i.viz || i.viz.qtd <= 0)) semSaida.push(i);   // acabou e não há vizinho para cobrir
    else if (i.qtd <= 0) esgotados.push(i);
    else criticos.push(i);
  }
  // Gravidade extra: o vizinho também está baixo (par acabando).
  const parBaixo = (i: Item) => !!i.viz && i.qtd + i.viz.qtd < minimo;
  const ordem = (a: Item, b: Item) => Number(parBaixo(b)) - Number(parBaixo(a)) || a.modelo.localeCompare(b.modelo) || a.cor.localeCompare(b.cor) || a.tam.localeCompare(b.tam, "pt-BR", { numeric: true });
  [semSaida, esgotados, criticos].forEach((l) => l.sort(ordem));
  // Em "sem saída" dos tamanhos soltos, os dois vizinhos aparecem; junta numa linha só.
  const vistos = new Set<string>();
  const semSaidaUnica = semSaida.filter((i) => { const k = `${i.modelo}|${i.cor}|${i.viz ? [i.tam, i.viz.tam].sort().join("/") : i.tam}`; if (vistos.has(k)) return false; vistos.add(k); return true; });
  if (!semSaidaUnica.length && !esgotados.length && !criticos.length) return { texto: null };

  const rot = (i: Item) => `${i.modelo} ${i.cor} ${i.viz && i.qtd <= 0 && i.viz.qtd <= 0 ? [i.tam, i.viz.tam].sort().join("/") : i.tam}`.replace(/\s+/g, " ");
  const viz = (i: Item) => (!i.viz ? "" : i.qtd <= 0 && i.viz.qtd > 0 ? ` (o ${i.viz.tam} ainda cobre: ${i.viz.qtd})` : parBaixo(i) ? ` ⚠️ o ${i.viz.tam} também está baixo (${i.viz.qtd})` : ` (o ${i.viz.tam} tem ${i.viz.qtd})`);
  const linhas = [`📦 ESTOQUE · ${new Date().toLocaleDateString("pt-BR", { timeZone: FUSO })} (${modelos.map(bonito).join(", ")})`, ""];
  if (semSaidaUnica.length) {
    linhas.push("🔴 URGENTE, SEM SAÍDA: acabou e não tem tamanho vizinho para cobrir. Mandar mensagem ao fornecedor para comprar mais, hoje:");
    semSaidaUnica.forEach((i) => linhas.push(`• ${rot(i)}`));
    linhas.push("");
  }
  if (esgotados.length) {
    linhas.push("🟠 ESGOTADO: pedir ao fornecedor (por enquanto o vizinho segura):");
    esgotados.forEach((i) => linhas.push(`• ${rot(i)}${viz(i)}`));
    linhas.push("");
  }
  const pedir = [...semSaidaUnica, ...esgotados];
  if (pedir.length) {
    linhas.push("Mensagem pronta para o fornecedor:", `"Bom dia! Preciso repor estoque: ${pedir.map(rot).join("; ")}. Quantos pares consegue enviar e em quanto tempo?"`, "");
  }
  if (criticos.length) {
    linhas.push(`🟡 CRÍTICO: entrando em ponto crítico (menos de ${minimo} pares):`);
    criticos.forEach((i) => linhas.push(`• ${rot(i)}: ${i.qtd}${viz(i)}`));
  }
  return { texto: linhas.join("\n").trim().slice(0, 3900) };
}

async function rodar(enviar: boolean) {
  try {
    const { texto } = await montar();
    if (!texto) { await diag("sem alertas hoje (estoque dos modelos acima do mínimo)"); return; }
    if (!enviar) { await diag(`SIMULAÇÃO:\n${texto}`); return; }
    const chat = await config("telegram_chat_id");
    if (!chat || !TOKEN) throw new Error("grupo ou token do Telegram não configurados");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description ?? r.status}`);
    await diag("alerta enviado");
  } catch (e) { await diag(`erro: ${e instanceof Error ? e.message : e}`); }
}

Deno.serve(async (req) => {
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || (req.headers.get("x-lucro-token") ?? "") !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  if (corpo.titulo_do_grupo && TOKEN) {
    const chat = await config("telegram_chat_id");
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getChat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat }) });
    const j: any = await r.json().catch(() => ({}));
    await diag(`grupo configurado: ${j?.result?.title ?? j?.description}`);
  }
  EdgeRuntime.waitUntil(rodar(!corpo.simular));
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
