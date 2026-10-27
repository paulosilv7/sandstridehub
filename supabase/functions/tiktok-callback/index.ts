// Conecta uma loja do TikTok Shop: recebe o código de autorização, troca por tokens,
// descobre as lojas autorizadas e salva loja + credenciais no banco.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const APP_KEY = Deno.env.get("TIKTOK_APP_KEY") ?? "6lo1ttda2b1bf";
const APP_SECRET = Deno.env.get("TIKTOK_APP_SECRET") ?? "";
const API = "https://open-api.tiktokglobalshop.com";
const AUTH = "https://auth.tiktok-shops.com";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const texto = (msg: string, status = 200) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Chamada assinada à API do TikTok Shop.
async function tts(caminho: string, token: string, extra: Record<string, string> = {}) {
  const q: Record<string, string> = { ...extra, app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)) };
  const base = caminho + Object.keys(q).sort().map((k) => k + q[k]).join("");
  q.sign = await hmac(APP_SECRET, APP_SECRET + base + APP_SECRET);
  const r = await fetch(`${API}${caminho}?${new URLSearchParams(q)}`, {
    headers: { "x-tts-access-token": token, "Content-Type": "application/json" },
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || (j.code ?? 0) !== 0) throw new Error(`TikTok respondeu ${r.status}/${j.code} em ${caminho}: ${String(j.message ?? "").slice(0, 200)}`);
  return j.data;
}

async function diag(origem: string, mensagem: string) {
  console.error(origem, mensagem);
  try { await supabase.from("diagnosticos").insert({ origem, mensagem: mensagem.slice(0, 1500) }); } catch (_) { /* ignora */ }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const erro = url.searchParams.get("error");
  if (erro) return texto(`O TikTok Shop recusou a conexão: ${erro}`, 400);
  if (!code || !state) return texto("Faltam informações na conexão. Gere um novo link de conexão e tente de novo.", 400);
  if (!APP_SECRET) return texto("A chave secreta do app ainda não foi configurada no Supabase.", 500);

  // O código de segurança vale uma vez só e expira em 30 minutos.
  const limite = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: estado } = await supabase.from("autorizacoes_pendentes").delete()
    .eq("state", state).eq("marketplace", "tiktok_shop").gte("criado_em", limite).select("state");
  if (!estado || estado.length === 0) return texto("Link de conexão inválido ou expirado. Gere um novo link e tente de novo.", 400);

  try {
    // Troca o código por tokens.
    const r = await fetch(`${AUTH}/api/v2/token/get?` + new URLSearchParams({
      app_key: APP_KEY, app_secret: APP_SECRET, auth_code: code, grant_type: "authorized_code",
    }));
    const t: any = await r.json().catch(() => ({}));
    if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) {
      await diag("tiktok-callback", `falha ao trocar o código: ${r.status}/${t.code} ${String(t.message ?? "").slice(0, 200)}`);
      return texto("Não foi possível concluir a conexão com o TikTok Shop. Gere um novo link e tente de novo.", 502);
    }
    const d = t.data;

    // Descobre as lojas autorizadas.
    const lojas = (await tts("/authorization/202309/shops", d.access_token)).shops ?? [];
    if (!lojas.length) return texto("Conectou, mas nenhuma loja veio na autorização. Tente de novo.", 502);

    const nomes: string[] = [];
    for (const s of lojas) {
      const { data: loja, error: eL } = await supabase.from("lojas").upsert(
        { marketplace: "tiktok_shop", id_externo: String(s.id), nome: s.name ?? `Loja ${s.id}`, ativa: true },
        { onConflict: "marketplace,id_externo" },
      ).select("id").single();
      if (eL || !loja) { await diag("tiktok-callback", `erro ao salvar a loja: ${eL?.message}`); return texto("Não foi possível salvar a loja. Tente de novo.", 500); }
      const { error: eC } = await supabase.from("credenciais_lojas").upsert({
        loja_id: loja.id,
        token_acesso: d.access_token,
        token_renovacao: d.refresh_token ?? null,
        expira_em: new Date(Number(d.access_token_expire_in) * 1000).toISOString(),
        dados_extras: { shop_cipher: s.cipher, open_id: d.open_id ?? null, vendedor: d.seller_name ?? null, refresh_expira_em: d.refresh_token_expire_in ?? null },
        atualizado_em: new Date().toISOString(),
      }, { onConflict: "loja_id" });
      if (eC) { await diag("tiktok-callback", `erro ao salvar credenciais: ${eC.message}`); return texto("Não foi possível salvar o acesso da loja. Tente de novo.", 500); }
      nomes.push(s.name ?? String(s.id));
    }
    return texto(`Loja "${nomes.join(", ")}" conectada com sucesso! Pode fechar esta aba.`);
  } catch (e) {
    await diag("tiktok-callback", `erro: ${e instanceof Error ? e.message : String(e)}`);
    return texto("Algo deu errado ao conectar. Gere um novo link e tente de novo.", 500);
  }
});
