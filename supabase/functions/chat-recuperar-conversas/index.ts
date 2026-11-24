// Recupera conversas do TikTok Shop e da Shopee cujos avisos (webhooks) se perderam numa pane.
// Lista as conversas mais recentes de cada loja e reenvia as que tiveram movimento desde "desde" para o mesmo caminho
// dos avisos (tiktok-notificacoes assinado; shopee-notificacoes pelo modo interno), que gravam de forma idempotente.
// Corpo: { desde: ISO, simular?: true, pular?: n, limite?: n (TikTok, em lotes), shopee?: false }. Cabeçalho x-lucro-token. Só leitura nos marketplaces.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASE_FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;

async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const dorme = (n: number) => new Promise((ok) => setTimeout(ok, n));
const ms = (t: any) => { const n = Number(t); if (!n) return 0; return n > 1e17 ? n / 1e6 : n > 1e12 ? n : n * 1000; };

// ---------------- TikTok ----------------
const TT_API = "https://open-api.tiktokglobalshop.com";
const TT_PADRAO = "6lo1ttda2b1bf";
async function tiktok(desde: number, simular: boolean, r: any, pular: number, limite: number) {
  let visto = 0, enviados = 0; r.total_tiktok = 0;
  const { data: lojas } = await supabase.from("lojas").select("id, id_externo, apelido").eq("marketplace", "tiktok_shop").eq("ativa", true);
  for (const l of lojas ?? []) {
    const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em, dados_extras").eq("loja_id", l.id).maybeSingle();
    const cipher = (c?.dados_extras as any)?.shop_cipher, appKey = (c?.dados_extras as any)?.app_key ?? TT_PADRAO;
    const segredo = Deno.env.get(`TIKTOK_SECRET_${appKey}`) ?? (appKey === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "");
    if (!c || !cipher || !segredo) { r.erros.push(`tiktok ${l.apelido}: sem credenciais`); continue; }
    if (!c.expira_em || new Date(c.expira_em).getTime() < Date.now() + 30_000) { r.erros.push(`tiktok ${l.apelido}: token vencido (rode chat-sincronizar e repita)`); continue; }
    let pagina = "", paginas = 0, achadas = 0;
    while (paginas < 6) {
      const q: Record<string, string> = { page_size: "20", app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: cipher };
      if (pagina) q.page_token = pagina;
      const caminho = "/customer_service/202309/conversations";
      q.sign = await hmac(segredo, segredo + caminho + Object.keys(q).sort().map((k) => k + q[k]).join("") + segredo);
      const resp = await fetch(`${TT_API}${caminho}?${new URLSearchParams(q)}`, { headers: { "x-tts-access-token": c.token_acesso, "Content-Type": "application/json" } });
      const j: any = await resp.json().catch(() => ({}));
      if (!resp.ok || (j.code ?? 0) !== 0) { r.erros.push(`tiktok ${l.apelido}: ${resp.status}/${j.code} ${String(j.message ?? "").slice(0, 120)}`); break; }
      const lista: any[] = j.data?.conversations ?? [];
      if (paginas === 0 && lista[0]) r.amostra.tiktok = Object.keys(lista[0]);
      let algumaNova = false;
      for (const cv of lista) {
        const t = ms(cv.latest_message?.create_time ?? cv.latest_message_time ?? cv.update_time ?? cv.create_time);
        if (t && t < desde) continue;
        algumaNova = true; achadas++; r.total_tiktok++;
        if (simular || visto++ < pular || enviados >= limite) continue;
        enviados++;
        const corpo = JSON.stringify({ type: 14, shop_id: String(l.id_externo), data: { conversation_id: String(cv.id ?? cv.conversation_id) } });
        const rr = await fetch(`${BASE_FN}/tiktok-notificacoes`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: await hmac(segredo, appKey + corpo) }, body: corpo });
        if (!rr.ok) r.erros.push(`tiktok reenvio ${cv.id}: ${rr.status}`);
        await dorme(300);
      }
      pagina = j.data?.next_page_token ?? "";
      if (!pagina || !algumaNova) break;
      paginas++;
    }
    r.tiktok[l.apelido] = achadas;
  }
}

// ---------------- Shopee ----------------
const SP_PARTNER = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970";
const SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "";
const SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
async function shopee(desde: number, simular: boolean, r: any, token: string) {
  const { data: lojas } = await supabase.from("lojas").select("id, id_externo, apelido").eq("marketplace", "shopee").eq("ativa", true);
  for (const l of lojas ?? []) {
    const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em, dados_extras").eq("loja_id", l.id).maybeSingle();
    const shopId = String((c?.dados_extras as any)?.shop_id ?? "");
    if (!c || !shopId) { r.erros.push(`shopee ${l.apelido}: sem credenciais`); continue; }
    if (!c.expira_em || new Date(c.expira_em).getTime() < Date.now() + 30_000) { r.erros.push(`shopee ${l.apelido}: token vencido`); continue; }
    const caminho = "/api/v2/sellerchat/get_conversation_list";
    let cursor = "", paginas = 0; const ids: any[] = [];
    while (paginas < 6) {
      const ts = Math.floor(Date.now() / 1000);
      const sign = await hmac(SP_KEY, `${SP_PARTNER}${caminho}${ts}${c.token_acesso}${shopId}`);
      const q = new URLSearchParams({ direction: "older", type: "all", page_size: "20", partner_id: SP_PARTNER, timestamp: String(ts), access_token: c.token_acesso, shop_id: shopId, sign });
      if (cursor) q.set("next_timestamp_nano", cursor);
      const resp = await fetch(`${SP_HOST}${caminho}?${q}`);
      const j: any = await resp.json().catch(() => ({}));
      if (!resp.ok || j.error) { r.erros.push(`shopee ${l.apelido}: ${resp.status} ${j.error ?? ""} ${String(j.message ?? "").slice(0, 120)}`); break; }
      const resposta = j.response ?? j, lista: any[] = resposta.conversations ?? [];
      if (paginas === 0 && lista[0]) { r.amostra.shopee = Object.keys(lista[0]); r.amostra.shopeeTs = [lista[0].last_message_timestamp, lista[lista.length - 1].last_message_timestamp, ms(lista[0].last_message_timestamp)]; }
      let algumaNova = false;
      for (const cv of lista) {
        const t = ms(cv.last_message_timestamp ?? cv.latest_message_time);
        if (t && t < desde) continue;
        algumaNova = true; ids.push({ shop_id: shopId, conversation_id: String(cv.conversation_id) });
      }
      const prox = resposta.page_result?.next_cursor?.next_message_time_nano ?? resposta.page_result?.next_cursor?.next_timestamp_nano;
      if (!resposta.page_result?.more || !prox || !algumaNova) break;
      cursor = String(prox); paginas++;
    }
    r.shopee[l.apelido] = ids.length;
    if (!simular && ids.length) {
      for (let i = 0; i < ids.length; i += 50) {
        const rr = await fetch(`${BASE_FN}/shopee-notificacoes`, { method: "POST", headers: { "Content-Type": "application/json", "x-lucro-token": token }, body: JSON.stringify({ reprocessar: ids.slice(i, i + 50) }) });
        if (!rr.ok) r.erros.push(`shopee reenvio: ${rr.status}`);
      }
    }
  }
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  const desde = new Date(corpo.desde ?? Date.now() - 48 * 3600_000).getTime();
  const simular = !!corpo.simular;
  const r: any = { tiktok: {}, shopee: {}, erros: [], amostra: {} };
  try { await tiktok(desde, simular, r, Number(corpo.pular ?? 0), Number(corpo.limite ?? 12)); } catch (e) { r.erros.push(`tiktok: ${e instanceof Error ? e.message : e}`); }
  try { if (corpo.shopee !== false) await shopee(desde, simular, r, seg.valor); } catch (e) { r.erros.push(`shopee: ${e instanceof Error ? e.message : e}`); }
  return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
});
