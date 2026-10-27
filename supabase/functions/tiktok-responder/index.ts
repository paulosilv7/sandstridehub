// Envia a resposta da equipe para o chat do TikTok Shop e grava a mensagem.
// Só quem está na tabela equipe pode usar. A tela chama esta função com o login da pessoa.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cada loja pode ter o próprio app do TikTok. O segredo de cada app fica em TIKTOK_SECRET_<chave do app>.
const PADRAO = "6lo1ttda2b1bf";
type App = { k: string; s: string };
const appDe = (k: string): App => ({ k, s: Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "") });
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class ErroNegocio extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Token válido da loja, renovando quando perto de vencer.
async function credenciais(lojaId: string): Promise<{ token: string; cipher: string; app: App } | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const cipher = (cred.dados_extras as any)?.shop_cipher;
  const app = appDe((cred.dados_extras as any)?.app_key ?? PADRAO);
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return { token: cred.token_acesso, cipher, app };
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${AUTH}/api/v2/token/refresh?` + new URLSearchParams({
    app_key: app.k, app_secret: app.s, refresh_token: cred.token_renovacao, grant_type: "refresh_token",
  }));
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) {
    const { data: outra } = await ler();
    if (valido(outra)) return { token: outra!.token_acesso, cipher, app };
    console.error("tiktok-responder: falha ao renovar o token", r.status, t.code, t.message);
    return null;
  }
  const d = t.data;
  await supabase.from("credenciais_lojas").update({
    token_acesso: d.access_token,
    token_renovacao: d.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return { token: d.access_token, cipher, app };
}

async function ttsPost(caminho: string, token: string, cipher: string, app: App, corpo: unknown) {
  const body = JSON.stringify(corpo);
  const q: Record<string, string> = { app_key: app.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: cipher };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + body;
  q.sign = await hmac(app.s, app.s + base + app.s);
  const r = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
    method: "POST", headers: { "x-tts-access-token": token, "Content-Type": "application/json" }, body,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) {
    console.error("tiktok-responder: erro do TikTok", r.status, j.code, j.message);
    throw new ErroNegocio(`O TikTok Shop recusou o envio${j.message ? `: ${String(j.message).slice(0, 160)}` : ""}.`, 502);
  }
  return j.data;
}

async function tratar(req: Request): Promise<Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new ErroNegocio("Faça login para responder.", 401);
  const { data: u, error: eu } = await supabase.auth.getUser(jwt);
  if (eu || !u?.user) throw new ErroNegocio("Sessão expirada. Entre de novo.", 401);
  const { data: membro } = await supabase.from("equipe").select("usuario_id, nome").eq("usuario_id", u.user.id).maybeSingle();
  if (!membro) throw new ErroNegocio("Você não faz parte da equipe.", 403);

  const corpo: any = await req.json().catch(() => ({}));
  const conversaId = String(corpo.conversa_id ?? "");
  const texto = String(corpo.texto ?? "").trim();
  if (!conversaId) throw new ErroNegocio("Conversa não informada.");
  if (!texto) throw new ErroNegocio("Escreva uma mensagem. Por enquanto o TikTok Shop aceita só texto por aqui.");
  if (texto.length > 2000) throw new ErroNegocio("A mensagem está grande demais (máximo 2000 caracteres).");

  const { data: conv } = await supabase.from("conversas")
    .select("id, loja_id, id_externo, bloqueada, motivo_bloqueio, atendente_id, atendida_por_ia, lojas(marketplace)")
    .eq("id", conversaId).maybeSingle();
  if (!conv) throw new ErroNegocio("Conversa não encontrada.", 404);
  const loja: any = Array.isArray(conv.lojas) ? conv.lojas[0] : conv.lojas;
  if (loja?.marketplace !== "tiktok_shop") throw new ErroNegocio("Esta conversa não é do TikTok Shop.", 400);
  if (conv.bloqueada) throw new ErroNegocio(conv.motivo_bloqueio ?? "O marketplace bloqueou as respostas desta conversa.", 409);
  if (conv.atendida_por_ia) throw new ErroNegocio("A Sandy está atendendo esta conversa. Assuma a conversa antes de responder.", 409);
  if (conv.atendente_id && conv.atendente_id !== membro.usuario_id) {
    throw new ErroNegocio("Outra pessoa está atendendo esta conversa. Assuma a conversa antes de responder.", 409);
  }

  const cred = await credenciais(conv.loja_id);
  if (!cred || !cred.cipher) throw new ErroNegocio("A conexão com o TikTok Shop precisa ser refeita.", 502);

  const r = await ttsPost(`/customer_service/202606/conversations/${conv.id_externo}/messages`, cred.token, cred.cipher, cred.app, {
    type: "TEXT",
    content: JSON.stringify({ content: texto }),
    sender_role: "CUSTOMER_SERVICE",
  });
  const idReal = r?.message_id ?? r?.id ?? null;
  const idExterno = idReal ? String(idReal) : `local-${crypto.randomUUID()}`;

  const { data: msg, error: em } = await supabase.from("mensagens").upsert({
    conversa_id: conv.id, id_externo: idExterno, de: "loja", texto, anexos: [],
    enviada_em: new Date().toISOString(), enviada_por: membro.usuario_id, enviada_por_ia: false, estado: "enviada",
  }, { onConflict: "conversa_id,id_externo" }).select("id").single();
  if (em) console.error("tiktok-responder: enviou, mas falhou ao gravar", em.message);

  await supabase.from("conversas").update({ atendente_id: membro.usuario_id, atendida_por_ia: false, escalada_motivo: null }).eq("id", conv.id);
  return resp({ ok: true, mensagem_id: msg?.id ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try {
    return await tratar(req);
  } catch (e) {
    if (e instanceof ErroNegocio) return resp({ ok: false, erro: e.message }, e.status);
    console.error("tiktok-responder: erro inesperado", e instanceof Error ? e.message : String(e));
    return resp({ ok: false, erro: "Algo deu errado ao enviar. Tente de novo." }, 500);
  }
});
