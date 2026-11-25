// Autorização da TikTok Marketing API. Não usa os tokens do TikTok Shop.
import { createClient } from "jsr:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const appId = Deno.env.get("TIKTOK_ADS_APP_ID") ?? "";
const appSecret = Deno.env.get("TIKTOK_ADS_APP_SECRET") ?? "";
const callback = `${url}/functions/v1/tiktok-ads-autorizar`;
const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const reply = (message: string, status = 200) => new Response(message, {
  status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
});

Deno.serve(async (request) => {
  if (!appId || !appSecret) return reply("A integração de anúncios ainda não foi configurada.", 503);
  const current = new URL(request.url);

  // O início exige sessão válida e permissão financeira, como ads-sincronizar.
  if (request.method === "POST") {
    const auth = request.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return reply("Sem acesso.", 403);
    const userDb = createClient(url, anonKey, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: allowed, error: permissionError } = await userDb.rpc("fin_geral_ok");
    if (permissionError || allowed !== true) return reply("Sem acesso.", 403);
    const state = crypto.randomUUID();
    const { error } = await db.from("tiktok_ads_autorizacoes").insert({ state });
    if (error) return reply("Não foi possível iniciar a autorização.", 500);
    const authorizeUrl = new URL("https://business-api.tiktok.com/portal/auth");
    authorizeUrl.searchParams.set("app_id", appId);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("redirect_uri", callback);
    return new Response(JSON.stringify({ url: authorizeUrl.toString() }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  if (request.method !== "GET") return reply("Método não permitido.", 405);
  const state = current.searchParams.get("state") ?? "";
  const code = current.searchParams.get("auth_code") ?? current.searchParams.get("code") ?? "";
  if (!state || !code) return reply("Autorização incompleta.", 400);

  // O state é único, expira em 30 minutos e é consumido antes de trocar o código.
  const { data: pending, error: stateError } = await db
    .from("tiktok_ads_autorizacoes").update({ usado_em: new Date().toISOString() })
    .eq("state", state).is("usado_em", null)
    .gte("criado_em", new Date(Date.now() - 30 * 60_000).toISOString())
    .select("state").maybeSingle();
  if (stateError || !pending) return reply("Autorização inválida ou expirada. Inicie novamente.", 400);

  const tokenResponse = await fetch("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: code }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || token.code !== 0 || !token.data?.access_token) {
    console.error("TikTok Ads OAuth", tokenResponse.status, token.code, token.message);
    return reply("TikTok não concluiu a autorização. Inicie novamente.", 502);
  }
  const advertiserIds = Array.isArray(token.data.advertiser_ids)
    ? token.data.advertiser_ids.map(String) : [];
  const { error: saveError } = await db
    .from("tiktok_ads_autorizacoes")
    .update({ token_acesso: token.data.access_token, advertiser_ids: advertiserIds })
    .eq("state", state);
  if (saveError) return reply("Autorização recebida, mas não foi possível salvar o acesso. Contate o administrador.", 500);
  return reply("Conta de anúncios autorizada. Pode fechar esta aba.");
});
