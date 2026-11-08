// Devoluções: ações REAIS no marketplace, só quando uma pessoa da equipe aprova na tela.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
async function hmac(chave: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
type Res = { ok: boolean; status: number; j: any; erro: string };

// ================= Shopee =================
const SP_ID = Deno.env.get("SHOPEE_PARTNER_ID") ?? "2050970", SP_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") ?? "", SP_HOST = Deno.env.get("SHOPEE_HOST") ?? "https://partner.shopeemobile.com";
async function sp(metodo: "GET" | "POST", path: string, c: any, o: { params?: Record<string, string>; json?: any; form?: FormData } = {}): Promise<Res> {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(SP_KEY, `${SP_ID}${path}${ts}${c.token}${c.shopId}`);
  const url = `${SP_HOST}${path}?${new URLSearchParams({ ...(o.params ?? {}), partner_id: SP_ID, timestamp: String(ts), access_token: c.token, shop_id: c.shopId, sign })}`;
  const r = await fetch(url, { method: metodo, headers: o.json ? { "Content-Type": "application/json" } : undefined, body: o.json ? JSON.stringify(o.json) : o.form, signal: AbortSignal.timeout(30_000) });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok && !j.error, status: r.status, j, erro: j.error ? `${j.error}: ${String(j.message ?? "").slice(0, 200)}` : (r.ok ? "" : `HTTP ${r.status}`) };
}
async function credSp(lojaId: string) {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const shopId = String((cred?.dados_extras as any)?.shop_id ?? "");
  if (!cred || !shopId) return null;
  const valido = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 300_000;
  if (valido(cred)) return { token: cred.token_acesso, shopId };
  if (!cred.token_renovacao) return null;
  const ts = Math.floor(Date.now() / 1000), path = "/api/v2/auth/access_token/get";
  const sign = await hmac(SP_KEY, `${SP_ID}${path}${ts}`);
  const r = await fetch(`${SP_HOST}${path}?` + new URLSearchParams({ partner_id: SP_ID, timestamp: String(ts), sign }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: cred.token_renovacao, shop_id: Number(shopId), partner_id: Number(SP_ID) }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok && !t.error && t.access_token) {
    await admin.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao, expira_em: new Date(Date.now() + Number(t.expire_in ?? 14400) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
    return { token: t.access_token, shopId };
  }
  const { data: o } = await ler(); return valido(o) ? { token: o!.token_acesso, shopId } : null;
}
const MOTIVO_SP: Record<string, string> = { "46": "Não recebi a devolução", "47": "Produto voltou danificado ou com problema", "48": "Pacote vazio ou faltando itens", "49": "Produto devolvido é diferente do enviado", "50": "Outro motivo", "56": "Produto voltou com sinais de uso" };
async function opcoesSp(caso: any, c: any) {
  const [d, m] = await Promise.all([
    sp("GET", "/api/v2/returns/get_return_detail", c, { params: { return_sn: caso.solicitacao_id } }),
    sp("GET", "/api/v2/returns/get_return_dispute_reason", c, { params: { return_sn: caso.solicitacao_id } }),
  ]);
  const st = String(d.j?.response?.status ?? "");
  const lista: any[] = Array.isArray(m.j?.response?.dispute_reason_list) ? m.j.response.dispute_reason_list : [];
  const aberto = ["REQUESTED", "PROCESSING", "ACCEPTED"].includes(st) && lista.length > 0;
  return {
    aberto, situacao: st, pode_aceitar: ["REQUESTED", "PROCESSING", "ACCEPTED"].includes(st),
    motivos: lista.map((x: any) => ({ id: String(x.dispute_reason), rotulo: MOTIVO_SP[String(x.dispute_reason)] ?? `Motivo ${x.dispute_reason}`, exige_fotos: (x.evidence_module_list ?? []).some((e: any) => e.is_required), pede: (x.evidence_module_list ?? []).map((e: any) => e.requirement).filter(Boolean).join(" ") || "Não exige fotos.", _bruto: x })),
  };
}
async function contestarSp(caso: any, c: any, motivo: any, texto: string, fotos: { blob: Blob; nome: string; mime: string }[], email: string): Promise<Res & { fotos: number }> {
  const urls: string[] = [];
  for (const f of fotos) {
    const fd = new FormData(); fd.append("return_sn", caso.solicitacao_id); fd.append("upload_image", new File([f.blob], f.nome, { type: f.mime }));
    const up = await sp("POST", "/api/v2/returns/convert_image", c, { form: fd });
    const u = up.j?.response?.url; if (up.ok && u) urls.push(String(u));
  }
  const mods: any[] = motivo._bruto.evidence_module_list ?? [];
  const exig = mods.filter((m: any) => m.is_required);
  if (exig.length && !urls.length) return { ok: false, status: 0, j: null, erro: "Não consegui enviar as fotos para a Shopee.", fotos: 0 };
  const alvo = exig.length ? exig : mods.slice(0, 1);
  const image_list = urls.length ? alvo.map((m: any) => ({ module_index: Number(m.module_index), requirement: String(m.requirement ?? ""), image_url: urls })) : undefined;
  const r = await sp("POST", "/api/v2/returns/dispute", c, { json: { return_sn: caso.solicitacao_id, email, dispute_reason_id: Number(motivo.id), dispute_text_reason: texto.slice(0, 1000), ...(image_list ? { image_list } : {}) } });
  return { ...r, fotos: urls.length };
}
async function aceitarSp(caso: any, c: any): Promise<Res> { return await sp("POST", "/api/v2/returns/confirm", c, { json: { return_sn: caso.solicitacao_id } }); }
async function lojaSp(c: any) {
  const [a, b] = await Promise.all([sp("GET", "/api/v2/shop/get_shop_info", c), sp("GET", "/api/v2/shop/get_profile", c)]);
  return { info: a.j?.response ?? a.j, perfil: b.j?.response ?? b.j };
}

// ================= Mercado Livre =================
const ML = "https://api.mercadolibre.com", ML_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040", ML_SEC = Deno.env.get("ML_CLIENT_SECRET") ?? "";
async function tokenML(lojaId: string): Promise<string | null> {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  const ok = (x: any) => x?.expira_em && new Date(x.expira_em).getTime() - Date.now() > 60_000;
  if (c && ok(c)) return c.token_acesso;
  if (!c?.token_renovacao) return null;
  const r = await fetch(`${ML}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_ID, client_secret: ML_SEC, refresh_token: c.token_renovacao }) });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) { await admin.from("credenciais_lojas").update({ token_acesso: t.access_token, token_renovacao: t.refresh_token ?? c.token_renovacao, expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId); return t.access_token; }
  const { data: o } = await ler(); return ok(o) ? o!.token_acesso : null;
}
async function ml(metodo: string, p: string, tk: string, o: { json?: any; form?: FormData } = {}): Promise<Res> {
  const r = await fetch(`${ML}${p}`, { method: metodo, headers: { Authorization: `Bearer ${tk}`, Accept: "application/json", ...(o.json ? { "Content-Type": "application/json" } : {}) }, body: o.json ? JSON.stringify(o.json) : o.form, signal: AbortSignal.timeout(30_000) });
  const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch (_) { /* */ }
  return { ok: r.ok, status: r.status, j, erro: r.ok ? "" : `${r.status} ${String(j?.message ?? j?.error ?? txt).slice(0, 200)}` };
}
const ROT_ML: Record<string, string> = { SRF2: "Produto voltou danificado", SRF3: "Devolução incompleta (faltando itens)", SRF4: "Voltou um produto diferente do enviado", SRF5: "O produto não estava no pacote", SRF6: "Outro problema com o produto", SRF7: "A devolução ainda não chegou" };
function acoesML(claim: any): string[] {
  const l: string[] = [];
  for (const p of claim?.players ?? []) if (p?.role === "respondent" || p?.type === "seller") for (const a of p?.available_actions ?? []) l.push(String(a?.action));
  return l;
}
async function opcoesML(caso: any, tk: string) {
  const c = await ml("GET", `/post-purchase/v1/claims/${caso.solicitacao_id}`, tk);
  const ac = acoesML(c.j);
  const pode = ac.includes("return_review_fail");
  let motivos: any[] = [];
  if (pode) {
    const r = await ml("GET", `/post-purchase/v1/returns/reasons?flow=seller_return_failed&claim_id=${caso.solicitacao_id}`, tk);
    motivos = (Array.isArray(r.j) ? r.j : []).filter((x: any) => (x.apply ?? ["order"]).includes("order") && x.id !== "SRF7").map((x: any) => ({ id: String(x.id), rotulo: ROT_ML[x.id] ?? String(x.detail ?? x.name), exige_fotos: ["SRF2", "SRF4"].includes(String(x.id)), pede: ["SRF2", "SRF4"].includes(String(x.id)) ? "Exige fotos do produto recebido." : "Fotos ajudam, mas não são obrigatórias." }));
  }
  return { aberto: pode && motivos.length > 0, situacao: String(c.j?.status ?? ""), pode_aceitar: ac.includes("return_review_ok"), motivos, acoes: ac };
}
async function contestarML(caso: any, tk: string, motivo: any, texto: string, fotos: { blob: Blob; nome: string; mime: string }[]): Promise<Res & { fotos: number }> {
  const nomes: string[] = [];
  for (const f of fotos) {
    const fd = new FormData(); fd.append("file", new File([f.blob], f.nome, { type: f.mime }));
    const up = await ml("POST", `/post-purchase/v1/claims/${caso.solicitacao_id}/returns/attachments`, tk, { form: fd });
    if (up.ok && up.j?.file_name) nomes.push(String(up.j.file_name));
  }
  if (motivo.exige_fotos && !nomes.length) return { ok: false, status: 0, j: null, erro: "Não consegui enviar as fotos para o Mercado Livre.", fotos: 0 };
  const r = await ml("POST", `/post-purchase/v1/claims/${caso.solicitacao_id}/actions/return-review-fail`, tk, { json: [{ reason: motivo.id, message: texto.slice(0, 2000), attachments: nomes }] });
  return { ...r, fotos: nomes.length };
}
async function aceitarML(caso: any, tk: string): Promise<Res> { return await ml("POST", `/post-purchase/v1/claims/${caso.solicitacao_id}/actions/return-review-ok`, tk); }

// ================= TikTok Shop =================
const TT = "https://open-api.tiktokglobalshop.com", TT_AUTH = "https://auth.tiktok-shops.com", TT_PADRAO = "6lo1ttda2b1bf";
async function credTT(lojaId: string) {
  const ler = () => admin.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em, dados_extras").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const k = (cred.dados_extras as any)?.app_key ?? TT_PADRAO, s = Deno.env.get(`TIKTOK_SECRET_${k}`) ?? (k === TT_PADRAO ? (Deno.env.get("TIKTOK_APP_SECRET") ?? "") : "");
  const cipher = (cred.dados_extras as any)?.shop_cipher;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return { token: cred.token_acesso, cipher, k, s };
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${TT_AUTH}/api/v2/token/refresh?` + new URLSearchParams({ app_key: k, app_secret: s, refresh_token: cred.token_renovacao, grant_type: "refresh_token" }));
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || (t.code ?? 0) !== 0 || !t.data?.access_token) { const { data: o } = await ler(); return valido(o) ? { token: o!.token_acesso, cipher, k, s } : null; }
  await admin.from("credenciais_lojas").update({ token_acesso: t.data.access_token, token_renovacao: t.data.refresh_token ?? cred.token_renovacao, expira_em: new Date(Number(t.data.access_token_expire_in) * 1000).toISOString(), atualizado_em: new Date().toISOString() }).eq("loja_id", lojaId);
  return { token: t.data.access_token, cipher, k, s };
}
async function tts(metodo: "GET" | "POST", caminho: string, c: any, extra: Record<string, string> = {}, o: { json?: any; form?: FormData } = {}): Promise<Res> {
  const body = o.json ? JSON.stringify(o.json) : "";
  const q: Record<string, string> = { app_key: c.k, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...extra };
  q.sign = await hmac(c.s, c.s + caminho + Object.keys(q).sort().map((x) => x + q[x]).join("") + body + c.s);
  const r = await fetch(`${TT}${caminho}?${new URLSearchParams(q)}`, { method: metodo, headers: { "x-tts-access-token": c.token, ...(o.json ? { "Content-Type": "application/json" } : {}) }, body: o.json ? body : o.form, signal: AbortSignal.timeout(30_000) });
  const j: any = await r.json().catch(() => ({}));
  const ok = r.ok && (j.code ?? 0) === 0;
  return { ok, status: r.status, j, erro: ok ? "" : `${j.code ?? r.status} ${String(j.message ?? "").slice(0, 200)}` };
}
async function opcoesTT(caso: any, c: any) {
  const r = await tts("GET", "/return_refund/202309/reject_reasons", c, { return_or_cancel_id: String(caso.solicitacao_id), locale: "pt-BR" });
  const lista: any[] = r.j?.data?.reasons ?? [];
  return { aberto: r.ok && lista.length > 0, situacao: r.ok ? "" : r.erro, pode_aceitar: false, motivos: lista.map((x: any) => ({ id: String(x.name), rotulo: String(x.text ?? x.name), exige_fotos: true, pede: "Envie fotos do produto recebido." })) };
}
async function contestarTT(caso: any, c: any, motivo: any, texto: string, fotos: { blob: Blob; nome: string; mime: string }[]): Promise<Res & { fotos: number }> {
  const imgs: any[] = [];
  for (const f of fotos) {
    const fd = new FormData(); fd.append("data", new File([f.blob], f.nome, { type: f.mime })); fd.append("use_case", "MAIN_IMAGE");
    const up = await tts("POST", "/product/202309/images/upload", c, {}, { form: fd });
    const d = up.j?.data; if (up.ok && d?.uri) imgs.push({ image_id: d.uri, mime_type: f.mime, width: Number(d.width ?? 0), height: Number(d.height ?? 0) });
  }
  if (!imgs.length) return { ok: false, status: 0, j: null, erro: "Não consegui enviar as fotos para o TikTok.", fotos: 0 };
  const r = await tts("POST", `/return_refund/202309/returns/${caso.solicitacao_id}/reject`, c, { idempotency_key: `${caso.id}-rej` }, { json: { decision: "REJECT_RECEIVED_PACKAGE", reject_reason: motivo.id, comment: texto.slice(0, 1000), images: imgs } });
  return { ...r, fotos: imgs.length };
}

// ================= comum =================
async function cfg(): Promise<Record<string, string>> {
  const { data } = await admin.from("devol_config").select("chave, valor");
  const o: Record<string, string> = {}; for (const x of data ?? []) o[x.chave] = String(x.valor ?? ""); return o;
}
async function fotosDoCaso(casoId: string) {
  const { data: anexos } = await admin.from("devol_anexos").select("caminho, mime").eq("caso_id", casoId).neq("estado", "excluido").order("criado_em");
  const l: { blob: Blob; nome: string; mime: string }[] = [];
  for (const a of (anexos ?? []).filter((a: any) => /^image\/(jpe?g|png)$/i.test(String(a.mime ?? "")) || /\.(jpe?g|png)$/i.test(a.caminho)).slice(0, 9)) {
    const { data: blob } = await admin.storage.from("devol-provas").download(a.caminho);
    if (blob) l.push({ blob, nome: a.caminho.split("/").pop() ?? "foto.jpg", mime: a.mime || "image/jpeg" });
  }
  return l;
}
const evento = (casoId: string, tipo: string, dados: any) => admin.from("devol_eventos").insert({ caso_id: casoId, tipo, evento_chave: `${tipo}:${casoId}:${Date.now()}`, dados });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const corpo: any = await req.json().catch(() => ({}));
    const modo = String(corpo.modo ?? "");
    let usuarioId: string | null = null;
    const segredo = req.headers.get("x-lucro-token") ?? "";
    if (segredo) {
      const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
      if (!seg?.valor || seg.valor !== segredo || !["opcoes", "loja"].includes(modo)) return resp({ ok: false, mensagem: "não autorizado" }, 401);
    } else {
      const usuario = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
      const { data: u } = await usuario.auth.getUser();
      if (!u?.user) return resp({ ok: false, mensagem: "Sessão inválida. Entre de novo." }, 401);
      const { data: acesso } = await usuario.rpc("tem_acesso", { p_app: "devolucoes" });
      if (!acesso) return resp({ ok: false, mensagem: "Sem acesso ao app de devoluções." }, 403);
      usuarioId = u.user.id;
    }
    if (modo === "loja") {
      const { data: lojas } = await admin.from("lojas").select("id, apelido").eq("marketplace", "shopee").eq("ativa", true);
      const out: any[] = [];
      for (const l of lojas ?? []) { const c = await credSp(l.id); out.push({ loja: l.apelido, dados: c ? await lojaSp(c) : "sem credencial" }); }
      return resp({ ok: true, lojas: out });
    }

    const { data: caso } = await admin.from("devol_casos").select("id, loja_id, solicitacao_id, status, pedido").eq("id", String(corpo.caso_id ?? "")).maybeSingle();
    if (!caso) return resp({ ok: false, mensagem: "Caso não encontrado." }, 404);
    const { data: loja } = await admin.from("lojas").select("marketplace, apelido").eq("id", caso.loja_id).maybeSingle();
    const mk = String(loja?.marketplace ?? "");
    const nomeMk = mk === "shopee" ? "Shopee" : mk === "tiktok_shop" ? "TikTok Shop" : "Mercado Livre";
    const c: any = mk === "shopee" ? await credSp(caso.loja_id) : mk === "tiktok_shop" ? await credTT(caso.loja_id) : await tokenML(caso.loja_id);
    if (!c) return resp({ ok: false, mensagem: `A conexão desta loja com o ${nomeMk} precisa ser refeita.` }, 502);
    const opcoes = () => mk === "shopee" ? opcoesSp(caso, c) : mk === "tiktok_shop" ? opcoesTT(caso, c) : opcoesML(caso, c);

    if (modo === "opcoes") { const o: any = await opcoes(); o.motivos = o.motivos.map(({ _bruto, ...m }: any) => m); const cf = await cfg(); return resp({ ok: true, marketplace: mk, email_ok: mk !== "shopee" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((cf.email_contestacao ?? "").trim()), ...o }); }
    if (!["contestar", "aceitar"].includes(modo)) return resp({ ok: false, mensagem: "Pedido inválido." }, 400);

    const conf = await cfg();
    if (conf.kill_switch === "true") return resp({ ok: false, mensagem: "O interruptor geral está ligado. Nada é enviado." }, 423);
    if (conf.envio_real !== "true") return resp({ ok: false, mensagem: "O envio real aos marketplaces está desligado nas configurações." }, 423);
    if (corpo.confirmado !== true) return resp({ ok: false, mensagem: "Falta a confirmação da pessoa." }, 400);
    const { data: ja } = await admin.from("devol_eventos").select("tipo, criado_em").eq("caso_id", caso.id).in("tipo", ["contestacao_enviada", "devolucao_aceita", "contestacao_tentativa"]).order("criado_em", { ascending: false }).limit(5);
    if ((ja ?? []).some((e: any) => e.tipo === "contestacao_enviada" || e.tipo === "devolucao_aceita")) return resp({ ok: false, mensagem: "Este caso já teve uma resposta enviada ao marketplace. Não envio duas vezes." }, 409);
    if ((ja ?? []).some((e: any) => Date.now() - new Date(e.criado_em).getTime() < 90_000)) return resp({ ok: false, mensagem: "Um envio deste caso começou há menos de 2 minutos. Aguarde e atualize." }, 409);

    const op: any = await opcoes();
    if (modo === "aceitar") {
      if (mk === "tiktok_shop") return resp({ ok: false, mensagem: "No TikTok Shop, se a loja não recusar, a devolução é aprovada sozinha no prazo. Toque em Concordo para só encerrar aqui." }, 409);
      if (!op.pode_aceitar) return resp({ ok: false, mensagem: `O ${nomeMk} não oferece mais essa ação neste caso.` }, 409);
      await evento(caso.id, "contestacao_tentativa", { usuario: usuarioId, acao: "aceitar" });
      const r = mk === "shopee" ? await aceitarSp(caso, c) : await aceitarML(caso, c);
      await evento(caso.id, r.ok ? "devolucao_aceita" : "contestacao_erro", { usuario: usuarioId, acao: "aceitar", http: r.status, resposta: r.ok ? "ok" : r.erro });
      if (!r.ok) return resp({ ok: false, mensagem: `O ${nomeMk} recusou: ${r.erro}` }, 502);
      return resp({ ok: true, mensagem: `Devolução aceita no ${nomeMk}.` });
    }

    if (!["PREPARADO", "RECURSO_DISPONIVEL", "COMPLEMENTACAO", "AGUARDANDO_PROVAS", "NOVO", "AGUARDANDO_ANALISE"].includes(caso.status)) return resp({ ok: false, mensagem: "Este caso não está aguardando contestação." }, 409);
    if (!op.aberto) return resp({ ok: false, mensagem: `O ${nomeMk} não aceita mais contestação neste caso (prazo encerrado ou fase errada).` }, 409);
    const motivo = op.motivos.find((m: any) => m.id === String(corpo.motivo_id ?? ""));
    if (!motivo) return resp({ ok: false, mensagem: "Escolha um motivo da lista do marketplace." }, 400);
    const { data: rel } = await admin.from("devol_relatos").select("relato").eq("caso_id", caso.id).order("criado_em", { ascending: false }).limit(1).maybeSingle();
    const texto = String(corpo.texto ?? rel?.relato ?? "").trim();
    if (texto.length < 20) return resp({ ok: false, mensagem: "Não há texto para enviar." }, 400);
    if (/https?:\/\/|www\.|\[/.test(texto)) return resp({ ok: false, mensagem: "O texto tem link ou colchete. Ajuste antes de enviar." }, 400);
    let email = "";
    if (mk === "shopee") {
      const reEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      const informado = String(corpo.email ?? "").trim();
      email = reEmail.test(informado) ? informado : (conf.email_contestacao ?? "").trim();
      if (!reEmail.test(email)) return resp({ ok: false, mensagem: "Falta o e-mail de contato da loja para contestações na Shopee." }, 400);
      if (!(conf.email_contestacao ?? "").trim() && email === informado) await admin.from("devol_config").upsert({ chave: "email_contestacao", valor: email });
    }
    const fotos = await fotosDoCaso(caso.id);
    await evento(caso.id, "contestacao_tentativa", { usuario: usuarioId, motivo: motivo.id, fotos: fotos.length });
    const r = mk === "shopee" ? await contestarSp(caso, c, motivo, texto, fotos, email) : mk === "tiktok_shop" ? await contestarTT(caso, c, motivo, texto, fotos) : await contestarML(caso, c, motivo, texto, fotos);
    await evento(caso.id, r.ok ? "contestacao_enviada" : "contestacao_erro", { usuario: usuarioId, marketplace: mk, motivo: motivo.id, fotos: r.fotos, http: r.status, resposta: r.ok ? "ok" : r.erro, texto: texto.slice(0, 1000) });
    if (!r.ok) return resp({ ok: false, mensagem: `O ${nomeMk} recusou: ${r.erro}` }, 502);
    await admin.from("devol_casos").update({ status: "ENVIADO", prioridade: "P3", prazo_em: null }).eq("id", caso.id);
    return resp({ ok: true, mensagem: `Contestação enviada ao ${nomeMk} com ${r.fotos} foto${r.fotos === 1 ? "" : "s"}.` });
  } catch (e) {
    return resp({ ok: false, mensagem: `Erro: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }, 500);
  }
});
