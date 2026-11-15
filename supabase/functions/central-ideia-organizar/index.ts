// Caixa de ideias da Central: lê uma ideia anotada pela equipe e PROPÕE meta, tarefas e prioridade do trimestre.
// SÓ propõe: nada é criado aqui. A pessoa aprova cada item na tela (o app cria com as permissões dela).
// Mesma chave (OPENAI_API_KEY) e mesmo padrão das funções da Sandy.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGEM = "central-ideia-organizar";
const OPENAI = Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("IDEIAS_MODELO") ?? "gpt-4.1";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ESQUEMA = {
  name: "proposta_ideia",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["resumo", "itens"],
    properties: {
      resumo: { type: "string", description: "2 a 4 frases curtas, em português simples, dizendo como você entendeu a ideia e o que propõe fazer. Fale direto com a pessoa." },
      itens: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tipo", "titulo", "detalhe", "responsavel_id", "prazo", "importancia", "unidade", "alvo"],
          properties: {
            tipo: { type: "string", enum: ["tarefa", "meta", "prioridade"] },
            titulo: { type: "string", description: "Tarefa: começa com verbo no infinitivo, até 90 caracteres. Meta: até 60 caracteres. Prioridade: até 100 caracteres." },
            detalhe: { type: "string", description: "Uma frase dizendo por que esse item ajuda a ideia." },
            responsavel_id: { type: ["string", "null"], description: "id de uma pessoa da lista da equipe (dono da tarefa, da meta ou da prioridade)." },
            prazo: { type: ["string", "null"], description: "AAAA-MM-DD. Tarefa e prioridade. Null se não houver prazo natural." },
            importancia: { type: ["string", "null"], enum: ["baixa", "normal", "alta", null], description: "Só para tarefa." },
            unidade: { type: ["string", "null"], enum: ["un", "reais", "pct", null], description: "Só para meta." },
            alvo: { type: ["number", "null"], description: "Só para meta: valor alvo do mês, maior que zero. Só preencha se a ideia trouxer o número; senão não proponha meta." },
          },
        },
      },
    },
  },
};

const REGRAS = `Você é a assistente de organização da Sandstride, uma loja de calçados e meias que vende em marketplaces (Shopee, Mercado Livre, TikTok Shop). Uma pessoa da equipe anotou uma ideia solta. Transforme em um plano pequeno e concreto.
REGRAS:
- Linguagem simples, direta, sem jargão. Nada de inglês.
- Proponha só o que a ideia pede. Entre 1 e 5 itens. Prefira poucas tarefas boas a muitas vagas.
- Tarefa: uma ação concreta que uma pessoa faz em até alguns dias. Comece com verbo no infinitivo (Gravar, Revisar, Cadastrar).
- Meta: só quando a ideia trouxer um número a atingir NO MÊS (ou der para deduzir sem inventar). No máximo 1. É do mês atual.
- Prioridade do trimestre: só para ideia grande, que muda a empresa e leva meses. No máximo 1. Não repita prioridade ou meta que já existe (lista abaixo): se já existe, faça tarefas ligadas a ela.
- Escolha responsável pela função de cada pessoa; se não der para saber, use quem anotou a ideia.
- Prazos a partir de amanhã, realistas. Se a ideia não pede prazo, deixe null.
- Nunca invente números, preços ou nomes que a ideia não trouxe.
- Se a pessoa NÃO é administradora, proponha SOMENTE tarefas.
- Se a anotação for só um lembrete simples, proponha uma única tarefa.`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const data = (s: any) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await supabase.auth.getUser(jwt);
    if (!u?.user) return resp({ ok: false, erro: "Sessão expirada. Entre de novo." }, 401);
    const { data: eu } = await supabase.from("equipe").select("usuario_id, nome, papel").eq("usuario_id", u.user.id).maybeSingle();
    if (!eu) return resp({ ok: false, erro: "Seu acesso ainda não foi liberado." }, 403);
    const admin = eu.papel === "admin";
    if (!OPENAI) return resp({ ok: false, erro: "A IA ainda não está configurada." }, 500);

    const corpo: any = await req.json().catch(() => ({}));
    const id = String(corpo.ideia_id ?? "");
    if (!uuid.test(id)) return resp({ ok: false, erro: "Ideia inválida." }, 400);
    const { data: ideia } = await supabase.from("central_ideias").select("id, texto, autor_id").eq("id", id).maybeSingle();
    if (!ideia) return resp({ ok: false, erro: "Não achei essa ideia." }, 404);
    if (ideia.autor_id !== eu.usuario_id && !admin) return resp({ ok: false, erro: "Só quem anotou ou um administrador organiza a ideia." }, 403);

    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const mes = hoje.slice(0, 7) + "-01";
    const mTri = Math.floor((+hoje.slice(5, 7) - 1) / 3) * 3 + 1;
    const tri = `${hoje.slice(0, 4)}-${String(mTri).padStart(2, "0")}-01`;
    const [{ data: equipe }, { data: metas }, { data: prios }] = await Promise.all([
      supabase.from("equipe").select("usuario_id, nome, papel").order("nome"),
      supabase.from("central_metas").select("titulo").eq("mes", mes),
      supabase.from("central_prioridades").select("titulo, status").eq("trimestre", tri),
    ]);
    const autor = (equipe ?? []).find((p: any) => p.usuario_id === ideia.autor_id);
    const ids = new Set((equipe ?? []).map((p: any) => p.usuario_id));
    const contexto = [
      `Hoje: ${hoje}. Mês atual começa em ${mes}.`,
      `Quem anotou a ideia: ${autor?.nome ?? "?"} (id ${ideia.autor_id}). Quem está pedindo: ${eu.nome} (${admin ? "administrador" : "atendente, só tarefas"}).`,
      `Equipe:\n${(equipe ?? []).map((p: any) => `- ${p.nome} (${p.papel === "admin" ? "sócio/administrador" : "atendente"}) id ${p.usuario_id}`).join("\n")}`,
      `Metas do mês que já existem: ${(metas ?? []).map((m: any) => m.titulo).join("; ") || "nenhuma"}.`,
      `Prioridades do trimestre que já existem: ${(prios ?? []).map((p: any) => `${p.titulo} (${p.status})`).join("; ") || "nenhuma"}.`,
    ].join("\n");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: MODELO, temperature: 0.3, max_tokens: 1200,
        response_format: { type: "json_schema", json_schema: ESQUEMA },
        messages: [{ role: "system", content: `${REGRAS}\n\nCONTEXTO:\n${contexto}` }, { role: "user", content: `IDEIA ANOTADA:\n"""${String(ideia.texto).slice(0, 2000)}"""` }],
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
    if (j?.usage) {
      try { await supabase.rpc("sandy_registrar_uso", { p_origem: ORIGEM, p_conversa: null, p_modelo: MODELO, p_entrada: j.usage.prompt_tokens ?? 0, p_cache: j.usage.prompt_tokens_details?.cached_tokens ?? 0, p_saida: j.usage.completion_tokens ?? 0 }); } catch (_) { /* não atrapalha */ }
    }
    const bruto = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");

    // limpa o que a IA devolveu: o app só cria o que passar por aqui
    let metaFeita = false, prioFeita = false;
    const itens: any[] = [];
    for (const it of Array.isArray(bruto.itens) ? bruto.itens : []) {
      const tipo = it?.tipo;
      if (!["tarefa", "meta", "prioridade"].includes(tipo)) continue;
      if (tipo !== "tarefa" && !admin) continue;
      if (tipo === "meta" && (metaFeita || !(Number(it.alvo) > 0))) continue;
      if (tipo === "prioridade" && prioFeita) continue;
      const titulo = String(it.titulo ?? "").trim().slice(0, tipo === "meta" ? 80 : tipo === "prioridade" ? 120 : 160);
      if (!titulo) continue;
      const resp_id = ids.has(it.responsavel_id) ? it.responsavel_id : ideia.autor_id;
      const item: any = { id: crypto.randomUUID(), tipo, titulo, detalhe: String(it.detalhe ?? "").trim().slice(0, 240), responsavel_id: resp_id, estado: "pendente" };
      if (tipo === "tarefa") { item.prazo = data(it.prazo); item.importancia = ["baixa", "normal", "alta"].includes(it.importancia) ? it.importancia : "normal"; }
      if (tipo === "prioridade") { item.prazo = data(it.prazo); item.trimestre = tri; prioFeita = true; }
      if (tipo === "meta") { item.mes = mes; item.unidade = ["un", "reais", "pct"].includes(it.unidade) ? it.unidade : "un"; item.alvo = Number(it.alvo); metaFeita = true; }
      itens.push(item);
      if (itens.length >= 5) break;
    }
    const proposta = { resumo: String(bruto.resumo ?? "").trim().slice(0, 600), itens, modelo: MODELO, criado_em: new Date().toISOString() };
    if (!proposta.resumo) throw new Error("A IA não devolveu resumo.");

    const { error } = await supabase.from("central_ideias").update({ proposta, estado: "organizada", atualizado_em: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(`Gravar proposta: ${error.message}`);
    return resp({ ok: true, proposta });
  } catch (e) {
    console.error(ORIGEM, (e as Error).message);
    try { await supabase.from("diagnosticos").insert({ origem: ORIGEM, mensagem: String((e as Error).message).slice(0, 1500) }); } catch (_) { /* */ }
    return resp({ ok: false, erro: "Não consegui organizar essa ideia agora. Tente de novo." }, 500);
  }
});
