// Alerta diário de estoque (09h, horário de Brasília) no grupo do Telegram, só para os modelos escolhidos.
// Regra: tamanhos vizinhos formam um par intercambiável (34/35, 36/37, 38/39, 40/41, 42/43). Grades que já vêm como "34/35" valem como um par.
//   🔴 URGENTE: o par inteiro zerou (sem como atender) -> pedir ao fornecedor já.
//   🟠 CRÍTICO: o par tem menos que o mínimo (padrão 3) no total.
//   🟡 ATENÇÃO: um tamanho abaixo do mínimo, mas o par ainda cobre.
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

type Par = { modelo: string; cor: string; rotulo: string; tams: { tam: string; qtd: number }[]; total: number };

async function montar(): Promise<{ texto: string | null; urgentes: Par[] }> {
  const modelos = (await config("estoque_alerta_modelos") ?? "RUNNING,MARTS,ROSS").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const minimo = Number(await config("estoque_alerta_minimo")) || 3;
  const { data: prods } = await supabase.from("est_produtos").select("codigo, produto, cor").eq("ativo", true).in("produto", modelos);
  const codigos = (prods ?? []).map((p: any) => p.codigo);
  const { data: grade } = codigos.length ? await supabase.from("est_grade").select("codigo, tamanho, quantidade").in("codigo", codigos) : { data: [] as any[] };
  const info = new Map((prods ?? []).map((p: any) => [p.codigo, p]));

  const grupos = new Map<string, Par>();
  for (const g of grade ?? []) {
    const p: any = info.get(g.codigo); if (!p) continue;
    const tam = String(g.tamanho).trim(), n = /^\d+$/.test(tam) ? Number(tam) : NaN;
    const rotulo = tam.includes("/") || Number.isNaN(n) ? tam : `${n - (n % 2)}/${n - (n % 2) + 1}`;
    const chave = `${g.codigo}|${rotulo}`;
    const par = grupos.get(chave) ?? { modelo: bonito(p.produto), cor: bonito(p.cor ?? ""), rotulo, tams: [], total: 0 };
    par.tams.push({ tam, qtd: Number(g.quantidade) || 0 }); par.total += Number(g.quantidade) || 0;
    grupos.set(chave, par);
  }
  const urgentes: Par[] = [], criticos: Par[] = [], atencao: Par[] = [];
  for (const par of grupos.values()) {
    if (par.total <= 0) urgentes.push(par);
    else if (par.total < minimo) criticos.push(par);
    else if (par.tams.some((t) => t.qtd < minimo)) atencao.push(par);
  }
  const ordem = (a: Par, b: Par) => a.modelo.localeCompare(b.modelo) || a.cor.localeCompare(b.cor) || a.rotulo.localeCompare(b.rotulo, "pt-BR", { numeric: true });
  [urgentes, criticos, atencao].forEach((l) => l.sort(ordem));
  if (!urgentes.length && !criticos.length && !atencao.length) return { texto: null, urgentes };

  const nome = (p: Par) => `${p.modelo} ${p.cor} ${p.rotulo}`.replace(/\s+/g, " ");
  const detalhe = (p: Par) => p.tams.sort((a, b) => a.tam.localeCompare(b.tam, "pt-BR", { numeric: true })).map((t) => `${t.tam}: ${t.qtd}`).join(" · ");
  const linhas = [`📦 ESTOQUE · ${new Date().toLocaleDateString("pt-BR", { timeZone: FUSO })} (${modelos.map(bonito).join(", ")})`, ""];
  if (urgentes.length) {
    linhas.push("🔴 URGENTE: o par ACABOU, não tem como atender. Mandar mensagem ao fornecedor para comprar mais, hoje:");
    urgentes.forEach((p) => linhas.push(`• ${nome(p)}`));
    linhas.push("", "Mensagem pronta para o fornecedor:", `"Bom dia! Preciso repor estoque, com urgência: ${urgentes.map((p) => nome(p)).join("; ")}. Quantos pares consegue enviar e em quanto tempo?"`, "");
  }
  if (criticos.length) {
    linhas.push(`🟠 CRÍTICO: o par está acabando (menos de ${minimo} pares no total):`);
    criticos.forEach((p) => linhas.push(`• ${nome(p)} → ${detalhe(p)}`));
    linhas.push("");
  }
  if (atencao.length) {
    linhas.push(`🟡 ATENÇÃO: um tamanho baixo (menos de ${minimo}), mas o par vizinho ainda cobre sem o cliente perceber:`);
    atencao.forEach((p) => linhas.push(`• ${nome(p)} → ${detalhe(p)}`));
  }
  return { texto: linhas.join("\n").trim().slice(0, 3900), urgentes };
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
