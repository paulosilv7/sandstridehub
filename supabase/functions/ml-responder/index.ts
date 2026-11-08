// Envia a resposta da equipe para o Mercado Livre (pergunta de anúncio ou mensagem pós-venda),
// grava a mensagem enviada e marca a conversa como respondida.
// Só quem está na tabela equipe pode usar. A tela chama esta função com o login da pessoa.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function resp(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

class ErroNegocio extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

// Situações em que o Mercado Livre não aceita mensagens do vendedor.
const SEM_ENVIO = ["cancelado", "devolucao", "devolvido", "analise_ml"];

// Token válido da loja, renovando quando perto de vencer.
async function tokenDaLoja(lojaId: string): Promise<string | null> {
  const ler = () =>
    supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em")
      .eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;

  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: cred.token_renovacao,
    }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { data: outra } = await ler();
    if (valido(outra)) return outra!.token_acesso;
    console.error("ml-responder: falha ao renovar o token", r.status, t?.error);
    return null;
  }
  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token,
    token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

async function mlJson(caminho: string, token: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${API}${caminho}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) },
  });
  const corpo: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("ml-responder: erro do Mercado Livre", r.status, caminho, JSON.stringify(corpo).slice(0, 400));
    const detalhe = corpo?.message ?? corpo?.error ?? "";
    throw new ErroNegocio(
      `O Mercado Livre recusou o envio (${r.status})${detalhe ? `: ${detalhe}` : ""}.`,
      502,
    );
  }
  return corpo;
}

// Envia os anexos para o Mercado Livre e devolve os ids deles.
async function enviarAnexos(token: string, anexos: any[]): Promise<string[]> {
  const ids: string[] = [];
  for (const a of anexos) {
    const { data: arquivo, error } = await supabase.storage.from("anexos").download(String(a.path));
    if (error || !arquivo) throw new ErroNegocio(`Não consegui ler o anexo ${a.nome ?? ""}.`, 400);
    const form = new FormData();
    form.append("file", arquivo, String(a.nome ?? "anexo"));
    const r = await mlJson(`/messages/attachments?tag=post_sale&site_id=MLB`, token, { method: "POST", body: form });
    if (!r?.id) throw new ErroNegocio("O Mercado Livre não aceitou o anexo.", 502);
    ids.push(String(r.id));
  }
  return ids;
}

async function tratar(req: Request): Promise<Response> {
  // 1. Quem está pedindo
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new ErroNegocio("Faça login para responder.", 401);
  const { data: u, error: eu } = await supabase.auth.getUser(jwt);
  if (eu || !u?.user) throw new ErroNegocio("Sessão expirada. Entre de novo.", 401);
  const { data: membro } = await supabase.from("equipe").select("usuario_id, nome")
    .eq("usuario_id", u.user.id).maybeSingle();
  if (!membro) throw new ErroNegocio("Você não faz parte da equipe.", 403);

  // 2. O pedido de envio
  const corpo: any = await req.json().catch(() => ({}));
  const conversaId = String(corpo.conversa_id ?? "");
  const texto = String(corpo.texto ?? "").trim();
  const anexos: any[] = Array.isArray(corpo.anexos) ? corpo.anexos.slice(0, 4) : [];
  if (!conversaId) throw new ErroNegocio("Conversa não informada.");
  if (!texto && !anexos.length) throw new ErroNegocio("Escreva uma mensagem ou anexe um arquivo.");
  if (texto.length > 2000) throw new ErroNegocio("A mensagem está grande demais.");

  const { data: conv } = await supabase.from("conversas")
    .select("id, loja_id, tipo, id_externo, cliente_id_externo, bloqueada, motivo_bloqueio, atendente_id, atendida_por_ia, situacao, situacao_detalhe, lojas(id_externo, marketplace)")
    .eq("id", conversaId).maybeSingle();
  if (!conv) throw new ErroNegocio("Conversa não encontrada.", 404);
  const loja: any = Array.isArray(conv.lojas) ? conv.lojas[0] : conv.lojas;
  if (loja?.marketplace !== "mercado_livre") throw new ErroNegocio("O envio por esta loja ainda não está disponível.", 400);
  if (conv.bloqueada) throw new ErroNegocio(conv.motivo_bloqueio ?? "O marketplace bloqueou as respostas desta conversa.", 409);
  if (conv.situacao && SEM_ENVIO.includes(conv.situacao)) {
    throw new ErroNegocio(conv.situacao_detalhe ?? "O Mercado Livre não aceita mensagens neste pedido (cancelado ou em devolução).", 409);
  }
  if (conv.atendida_por_ia) throw new ErroNegocio("A Sandy está atendendo esta conversa. Assuma a conversa antes de responder.", 409);
  if (conv.atendente_id && conv.atendente_id !== membro.usuario_id) {
    throw new ErroNegocio("Outra pessoa está atendendo esta conversa. Assuma a conversa antes de responder.", 409);
  }

  const token = await tokenDaLoja(conv.loja_id);
  if (!token) throw new ErroNegocio("A conexão com o Mercado Livre precisa ser refeita.", 502);

  // 3. Envio
  let idExterno: string;
  const anexosSalvos: any[] = anexos.map((a) => ({ tipo: String(a.tipo ?? "arq"), nome: String(a.nome ?? "anexo"), path: String(a.path ?? "") }));

  if (conv.tipo === "pergunta") {
    if (anexos.length) throw new ErroNegocio("Perguntas de anúncio aceitam só texto.");
    if (!texto) throw new ErroNegocio("Escreva a resposta.");
    const r = await mlJson(`/answers`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: Number(conv.id_externo), text: texto }),
    });
    idExterno = `r-${conv.id_externo}`;
    void r;
  } else if (conv.tipo === "pos_venda") {
    let compradorId = conv.cliente_id_externo;
    if (!compradorId) {
      const pedido = await mlJson(`/orders/${conv.id_externo}`, token);
      compradorId = pedido?.buyer?.id != null ? String(pedido.buyer.id) : null;
      if (compradorId) await supabase.from("conversas").update({ cliente_id_externo: compradorId }).eq("id", conv.id);
    }
    if (!compradorId) throw new ErroNegocio("Não consegui identificar o comprador deste pedido.", 502);
    const ids = anexos.length ? await enviarAnexos(token, anexos) : [];
    const body: any = {
      from: { user_id: String(loja.id_externo) },
      to: { user_id: String(compradorId) },
      text: texto || " ",
    };
    if (ids.length) body.attachments = ids;
    let r: any;
    try {
      r = await mlJson(`/messages/packs/${conv.id_externo}/sellers/${loja.id_externo}?tag=post_sale`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // O Mercado Livre travou a conversa (pedido cancelado, devolução ou mediação): marca na conversa.
      if (e instanceof ErroNegocio && /blocked_by/.test(e.message)) {
        const cancelado = /cancel/.test(e.message);
        const detalhe = cancelado
          ? "Pedido cancelado no Mercado Livre. Não é possível enviar mensagens."
          : "O Mercado Livre bloqueou as mensagens deste pedido (em análise ou encerrado).";
        await supabase.from("conversas").update({
          situacao: cancelado ? "cancelado" : "analise_ml",
          situacao_detalhe: detalhe,
          situacao_em: new Date().toISOString(),
        }).eq("id", conv.id);
        throw new ErroNegocio(`${detalhe} A conversa saiu das não respondidas; acompanhe pelo painel do Mercado Livre.`, 409);
      }
      throw e;
    }
    const idReal = r?.message_id ?? r?.id ?? r?.messages?.[0]?.message_id ?? null;
    // Sem id na resposta, usamos um id local; o aviso do Mercado Livre troca pelo real depois.
    idExterno = idReal ? String(idReal) : `local-${crypto.randomUUID()}`;
  } else {
    throw new ErroNegocio("Este tipo de conversa ainda não aceita resposta por aqui.");
  }

  // 4. Registro
  const agora = new Date().toISOString();
  const { data: msg, error: em } = await supabase.from("mensagens").upsert({
    conversa_id: conv.id,
    id_externo: idExterno,
    de: "loja",
    texto: texto || null,
    anexos: anexosSalvos,
    enviada_em: agora,
    enviada_por: membro.usuario_id,
    enviada_por_ia: false,
    estado: "enviada",
  }, { onConflict: "conversa_id,id_externo" }).select("id").single();
  if (em) console.error("ml-responder: enviou, mas falhou ao gravar", em.message);

  await supabase.from("conversas").update({ atendente_id: membro.usuario_id, atendida_por_ia: false, escalada_motivo: null })
    .eq("id", conv.id);

  return resp({ ok: true, mensagem_id: msg?.id ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try {
    return await tratar(req);
  } catch (e) {
    if (e instanceof ErroNegocio) return resp({ ok: false, erro: e.message }, e.status);
    console.error("ml-responder: erro inesperado", e instanceof Error ? e.message : String(e));
    return resp({ ok: false, erro: "Algo deu errado ao enviar. Tente de novo." }, 500);
  }
});
