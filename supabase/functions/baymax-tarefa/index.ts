// Baymax (assistente do Paulo no Telegram) cria tarefas na Central (public.central_tarefas).
// Só INSERE. Autenticação: cabeçalho x-baymax-token cujo SHA-256 confere com o hash abaixo
// (o token fica só no Mac do Paulo, em ~/.openclaw/secrets/sandstride-tarefa.token).
import { createClient } from "jsr:@supabase/supabase-js@2";

const HASH_TOKEN = "e457b690f7dc688c4c4ca5c71eaa102ab7a0fe03135b6f1b503c328e0963b6a1";
const PAULO_ID = "0cd665bf-e4fb-4087-91a7-e5312cbafe6a";
const IMPORTANCIAS = ["baixa", "normal", "alta"];

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function sha256(txt: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const token = req.headers.get("x-baymax-token") ?? "";
  if (!token || !igual(await sha256(token), HASH_TOKEN)) return json({ erro: "não autorizado" }, 401);

  let corpo: Record<string, unknown>;
  try { corpo = await req.json(); } catch { return json({ erro: "JSON inválido" }, 400); }

  const titulo = String(corpo.titulo ?? "").trim();
  if (titulo.length < 1 || titulo.length > 160) return json({ erro: "título deve ter de 1 a 160 caracteres" }, 400);

  const importancia = String(corpo.importancia ?? "normal").toLowerCase();
  if (!IMPORTANCIAS.includes(importancia)) return json({ erro: "importância deve ser baixa, normal ou alta" }, 400);

  let prazo: string | null = null;
  if (corpo.prazo) {
    prazo = String(corpo.prazo).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo) || isNaN(Date.parse(prazo))) return json({ erro: "prazo deve ser AAAA-MM-DD" }, 400);
  }

  const descricao = corpo.descricao ? String(corpo.descricao).trim().slice(0, 4000) : null;

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Responsável: nome da equipe (padrão: Paulo). Ignora a Sandy (é robô).
  let responsavel_id = PAULO_ID;
  let responsavel_nome = "Paulo";
  const pedido = corpo.responsavel ? String(corpo.responsavel).trim() : "";
  if (pedido && semAcento(pedido) !== "paulo") {
    const { data: equipe, error } = await db.from("equipe").select("usuario_id,nome");
    if (error) return json({ erro: "falha ao ler a equipe" }, 500);
    const achados = (equipe ?? []).filter((p) => semAcento(p.nome) === semAcento(pedido) && semAcento(p.nome) !== "sandy");
    if (achados.length !== 1) {
      return json({ erro: `responsável "${pedido}" não encontrado`, equipe: (equipe ?? []).map((p) => p.nome).filter((n) => semAcento(n) !== "sandy") }, 404);
    }
    responsavel_id = achados[0].usuario_id;
    responsavel_nome = achados[0].nome;
  }

  const { data, error } = await db.from("central_tarefas")
    .insert({ titulo, responsavel_id, criado_por: PAULO_ID, prazo, importancia, descricao })
    .select("id,titulo,prazo,importancia")
    .single();
  if (error) return json({ erro: "não consegui criar a tarefa", detalhe: error.message }, 500);

  return json({ ok: true, tarefa: data, responsavel: responsavel_nome });
});
