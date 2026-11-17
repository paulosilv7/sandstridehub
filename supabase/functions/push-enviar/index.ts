// Envia avisos no aparelho (Web Push) para a equipe. Código-fonte completo em supabase/functions/push-enviar/index.ts
// Os textos vêm da tabela push_textos (editável em Configurações); aqui ficam só os valores que entram neles.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SITE = "https://sandstridehub.vercel.app";
const TZ = "America/Sao_Paulo";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function diag(m: string) {
  console.error("push-enviar", m);
  try { await supabase.from("diagnosticos").insert({ origem: "push-enviar", mensagem: m.slice(0, 1500) }); } catch (_) { /* ignora */ }
}
const hojeBR = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const dm = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
const prim = (n: string) => String(n ?? "").split(" ")[0];
const dinheiro = (n: number) => "R$ " + Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const reais = (n: number) => "R$ " + Math.round(Number(n)).toLocaleString("pt-BR");
const plural = (n: number, s: string, p: string) => `${n} ${n === 1 ? s : p}`;

let pronto = false;
async function chaves() {
  if (pronto) return;
  let { data: k } = await supabase.from("push_chaves").select("publica, privada").eq("id", 1).maybeSingle();
  if (!k) {
    const g = webpush.generateVAPIDKeys();
    await supabase.from("push_chaves").upsert({ id: 1, publica: g.publicKey, privada: g.privateKey }, { onConflict: "id" });
    ({ data: k } = await supabase.from("push_chaves").select("publica, privada").eq("id", 1).maybeSingle());
  }
  webpush.setVapidDetails(SITE, k!.publica, k!.privada);
  pronto = true;
}

// textos editáveis: {variavel} é trocada pelo valor; separadores " · " soltos são removidos e cada trecho começa com maiúscula
async function texto(tipo: string, v: Record<string, string>): Promise<{ titulo: string; corpo: string }> {
  const { data } = await supabase.from("push_textos").select("titulo, corpo").eq("tipo", tipo).maybeSingle();
  const r = (t: string) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "").replace(/(\s*·\s*){2,}/g, " · ").replace(/^\s*·\s*|\s*·\s*$/g, "").replace(/\s+/g, " ").trim()
    .replace(/(^|·\s*)([^\p{L}\p{N}]*?)(\p{Ll})/gu, (_m, a, b, c) => a + b + c.toUpperCase()); // cada trecho começa com maiúscula
  return { titulo: r(data?.titulo ?? "") || "Sandstride", corpo: r(data?.corpo ?? "") };
}
const amanhaBR = () => new Date(new Date(hojeBR() + "T12:00:00Z").getTime() + 86400_000).toISOString().slice(0, 10);
const quando = (iso: string | null) => !iso ? "" : iso === hojeBR() ? "vence hoje" : iso === amanhaBR() ? "vence amanhã" : `vence dia ${dm(iso)}`;

type Aviso = { titulo: string; corpo: string; url?: string; tag?: string };
const CAMPO: Record<string, string> = { tarefa: "tarefas", meta: "metas", meta_lucro: "metas", resumo: "resumo" };

async function enviar(usuarios: string[], aviso: Aviso, tipo: string | null): Promise<number> {
  if (!usuarios.length) return 0;
  await chaves();
  const { data: prefs } = await supabase.from("push_preferencias").select("*").in("usuario_id", usuarios);
  const mapa = new Map((prefs ?? []).map((p: any) => [p.usuario_id, p]));
  const quem = usuarios.filter((u) => !tipo || (mapa.get(u)?.[CAMPO[tipo]] ?? true));
  if (!quem.length) return 0;
  const { data: subs } = await supabase.from("push_inscricoes").select("id, endpoint, p256dh, auth").in("usuario_id", quem);
  let ok = 0;
  await Promise.all((subs ?? []).map(async (s: any) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ titulo: aviso.titulo, corpo: aviso.corpo, url: aviso.url ?? SITE + "/", tag: aviso.tag }), { TTL: 6 * 3600, urgency: "high" });
      ok++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await supabase.from("push_inscricoes").delete().eq("id", s.id);
      else await diag(`falha ao enviar (${e?.statusCode ?? "?"}): ${String(e?.body ?? e?.message ?? e).slice(0, 200)}`);
    }
  }));
  await diag(`aviso ${tipo ?? "teste"}: aceito por ${ok} de ${(subs ?? []).length} aparelho(s)`);
  return ok;
}
const equipe = async () => ((await supabase.from("equipe").select("usuario_id, nome")).data ?? []) as any[];

async function tarefa(c: any) {
  const { data: t } = await supabase.from("central_tarefas").select("id, titulo, prazo, responsavel_id, importancia").eq("id", c.tarefa_id).maybeSingle();
  if (!t || t.responsavel_id === c.ator) return;
  const eq = await equipe(), ator = eq.find((p) => p.usuario_id === c.ator);
  const alterada = c.acao === "alterada", q = quando(t.prazo);
  const tx = await texto(alterada ? "tarefa_alterada" : "tarefa_nova", {
    quem: ator ? prim(ator.nome) : "Alguém", tarefa: t.titulo, prazo: q, prazo_novo: q ? "agora " + q : "",
    importancia: t.importancia === "alta" ? "⚡ alta prioridade" : "" });
  await enviar([t.responsavel_id], { ...tx, tag: "tarefa-" + t.id }, "tarefa");
}

async function meta(c: any) {
  const { data: m } = await supabase.from("central_metas").select("id, titulo, unidade, alvo, atual, mes, sentido").eq("id", c.meta_id).maybeSingle();
  if (!m) return;
  const bateu = m.sentido === "descer" ? Number(m.atual) > 0 && Number(m.atual) <= Number(m.alvo) : Number(m.atual) >= Number(m.alvo);
  if (!bateu) return;
  const chave = `meta:${m.id}:${m.alvo}`;
  if ((await supabase.from("push_enviados").insert({ chave })).error) return; // já avisada
  const f = (n: number) => m.unidade === "reais" ? dinheiro(n) : m.unidade === "pct" ? `${Number(n).toLocaleString("pt-BR")}%` : Number(n).toLocaleString("pt-BR");
  const tx = await texto("meta_mes", { meta: m.titulo, atual: f(m.atual), alvo: f(m.alvo) });
  await enviar((await equipe()).map((p) => p.usuario_id), { ...tx, tag: "meta-" + m.id }, "meta");
}

async function metaLucro() {
  const dia = hojeBR();
  if ((await supabase.from("push_enviados").select("chave").eq("chave", "meta_lucro:" + dia).maybeSingle()).data) return;
  const [{ data: cfg }, { data: exc }, { data: res }] = await Promise.all([
    supabase.from("lucro_metas").select("modo, fixa, semana").eq("id", 1).maybeSingle(),
    supabase.from("lucro_metas_excecoes").select("valor").eq("dia", dia).maybeSingle(),
    supabase.from("lucro_resumo_dia").select("lucro").eq("dia", dia)]);
  const dow = new Date(dia + "T12:00:00Z").getUTCDay();
  const alvo = Number(exc?.valor ?? (cfg?.modo === "semana" ? cfg?.semana?.[dow] : cfg?.fixa) ?? 0);
  const lucro = (res ?? []).reduce((s: number, r: any) => s + Number(r.lucro ?? 0), 0);
  if (!(alvo > 0) || lucro < alvo) return;
  if ((await supabase.from("push_enviados").insert({ chave: "meta_lucro:" + dia })).error) return;
  const tx = await texto("meta_lucro", { lucro: reais(lucro), meta: reais(alvo) });
  await enviar((await equipe()).map((p) => p.usuario_id), { ...tx, url: SITE + "/lucro/", tag: "meta-lucro" }, "meta_lucro");
}

async function resumo() {
  const dia = hojeBR();
  const [eq, { data: ab }] = await Promise.all([equipe(),
    supabase.from("central_tarefas").select("responsavel_id, prazo").is("feita_em", null).not("prazo", "is", null).lte("prazo", dia)]);
  for (const p of eq) {
    if ((await supabase.from("push_enviados").insert({ chave: `resumo:${dia}:${p.usuario_id}` })).error) continue;
    const minhas = (ab ?? []).filter((t: any) => t.responsavel_id === p.usuario_id);
    const hoje = minhas.filter((t: any) => t.prazo === dia).length, atr = minhas.filter((t: any) => t.prazo < dia).length;
    const partes = [hoje ? `${plural(hoje, "tarefa", "tarefas")} para fechar` : "", atr ? plural(atr, "atrasada", "atrasadas") : ""].filter(Boolean);
    if (!partes.length) continue;
    const tx = await texto("resumo", { nome: prim(p.nome), itens: partes.join(" e ") });
    await enviar([p.usuario_id], { ...tx, tag: "resumo-" + dia }, "resumo");
  }
}

Deno.serve(async (req) => {
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || (req.headers.get("x-lucro-token") ?? "") !== seg.valor) return new Response("não autorizado", { status: 401 });
  const c: any = await req.json().catch(() => ({}));
  if (c.init) { await chaves(); return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }); }
  const trabalho = async () => {
    try {
      if (c.tipo === "tarefa") await tarefa(c);
      else if (c.tipo === "meta") await meta(c);
      else if (c.tipo === "meta_lucro") await metaLucro();
      else if (c.tipo === "resumo") await resumo();
      else if (c.tipo === "teste") {
        const n = await enviar([String(c.usuario_id)], { titulo: "Avisos funcionando ✅", corpo: "Este aparelho vai receber os avisos do Sandstride.", tag: "teste" }, null);
        if (!n) await diag("teste: nenhum aparelho inscrito para este usuário");
      }
    } catch (e) { await diag(`erro (${c.tipo}): ${e instanceof Error ? e.message : e}`); }
  };
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(trabalho());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
