// Financeiro > Recebimentos: lê o que os marketplaces informam sobre dinheiro (só leitura, nada é gravado).
// Mercado Livre: a liberar (valor e data informados pelo ML), liberado nos últimos 7 e 30 dias e pagamentos em mediação.
// Shopee e TikTok ainda não entram aqui (entram depois, com a mesma regra: só valor que o marketplace informa).
// Quem pode chamar: apenas Paulo e Lucas (login). Valores líquidos (net_received_amount), em reais.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const API = "https://api.mercadolibre.com";
const MP = "https://api.mercadopago.com";
const PERMITIDOS = new Set(["0cd665bf-e4fb-4087-91a7-e5312cbafe6a", "ebccd17d-16d7-46cc-82cd-1622c3fd254d"]);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA = 86400_000;

async function tokenDaLoja(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  if (!cred) return null;
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (valido(cred)) return cred.token_acesso;
  if (!cred.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) { const { data: outra } = await ler(); return valido(outra) ? outra!.token_acesso : null; }
  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token,
    token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

async function pagamentos(token: string, params: Record<string, string>, maximo = 5000): Promise<any[]> {
  const todos: any[] = [];
  for (let offset = 0; offset < maximo; offset += 1000) {
    const qs = new URLSearchParams({ ...params, limit: "1000", offset: String(offset) });
    const r = await fetch(`${MP}/v1/payments/search?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`MP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const lista: any[] = j.results ?? [];
    todos.push(...lista);
    if (lista.length < 1000 || offset + 1000 >= Number(j.paging?.total ?? 0)) break;
  }
  return todos;
}
const liquido = (p: any) => Number(p?.transaction_details?.net_received_amount ?? 0);
// dia (AAAA-MM-DD) no horário de São Paulo
const diaSP = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoSP = (ms: number) => new Date(ms).toISOString();

async function lerLoja(loja: any) {
  const token = await tokenDaLoja(loja.id);
  if (!token) return { id: loja.id, nome: loja.nome, erro: "conexão precisa ser refeita" };
  const agora = Date.now();
  const [futuros, passados, med, chb] = await Promise.all([
    pagamentos(token, { sort: "money_release_date", criteria: "asc", range: "money_release_date", begin_date: isoSP(agora), end_date: isoSP(agora + 120 * DIA), status: "approved" }),
    pagamentos(token, { sort: "money_release_date", criteria: "desc", range: "money_release_date", begin_date: isoSP(agora - 30 * DIA), end_date: isoSP(agora), status: "approved" }),
    pagamentos(token, { sort: "date_created", criteria: "desc", status: "in_mediation" }),
    pagamentos(token, { sort: "date_created", criteria: "desc", status: "charged_back" }),
  ]);
  const lib: Record<string, number> = {};
  let arec = 0;
  for (const p of futuros) {
    if (!p.money_release_date || new Date(p.money_release_date).getTime() <= agora) continue;
    const v = liquido(p);
    arec += v;
    const d = diaSP(p.money_release_date);
    lib[d] = r2((lib[d] ?? 0) + v);
  }
  let pago7 = 0, pago30 = 0;
  for (const p of passados) {
    if (p.money_release_status !== "released" || !p.money_release_date) continue;
    const t = new Date(p.money_release_date).getTime();
    if (t > agora) continue;
    const v = liquido(p);
    pago30 += v;
    if (t >= agora - 7 * DIA) pago7 += v;
  }
  const disputa = [...med, ...chb];
  return {
    id: loja.id, nome: loja.nome,
    a_receber: r2(arec), liberacoes: lib,
    pago_7d: r2(pago7), pago_30d: r2(pago30),
    disputa: { qtd: disputa.length, valor: r2(disputa.reduce((s, p) => s + liquido(p), 0)) },
  };
}

async function autorizado(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: u, error } = await supabase.auth.getUser(jwt);
  return !error && !!u?.user && PERMITIDOS.has(u.user.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso ao Financeiro." }, 403);
  try {
    const { data: lojas } = await supabase.from("lojas").select("id, nome").eq("marketplace", "mercado_livre").eq("ativa", true).order("nome");
    const saida = await Promise.all((lojas ?? []).map((l: any) => lerLoja(l).catch((e) => ({ id: l.id, nome: l.nome, erro: (e as Error).message.slice(0, 200) }))));
    return resp({ ok: true, gerado_em: new Date().toISOString(), mercado_livre: saida });
  } catch (e) {
    console.error("financeiro-recebimentos", (e as Error).message);
    return resp({ ok: false, erro: "Falha inesperada." }, 500);
  }
});
