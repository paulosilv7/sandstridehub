// Importa a planilha SISTEMA ESTOQUE (abas PRODUTOS, BASE e HISTÓRICO) para as tabelas est_* do banco.
// Rodar só na virada (antes de congelar a planilha): substitui produtos, grade e o histórico importado.
// Quem chama: o próprio banco/o administrador técnico, com o cabeçalho x-lucro-token.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const PLANILHA = "1vYGhjXrJsYvPQx0t3cFqvl_fxTKIlmxUnpEzJaTb4cA";

const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function tokenGoogle(): Promise<string> {
  const conta = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({ iss: conta.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 }));
  const pem = String(conta.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const ass = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(`${cab}.${corpo}`));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${cab}.${corpo}.${b64url(ass)}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("O Google recusou a conta de serviço.");
  return j.access_token;
}
async function ler(tok: string, faixas: string[], formatado: boolean): Promise<any[][][]> {
  const q = faixas.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const opc = formatado ? "valueRenderOption=FORMATTED_VALUE" : "valueRenderOption=UNFORMATTED_VALUE";
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA}/values:batchGet?${q}&${opc}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  return ((await r.json()).valueRanges ?? []).map((v: any) => v.values ?? []);
}
const S = (v: any) => (v === undefined || v === null ? "" : String(v).trim());
const N = (v: any) => { const n = Number(typeof v === "string" ? v.replace(/\./g, "").replace(",", ".") : v); return Number.isFinite(n) ? n : 0; };
function quando(t: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2})/.exec(t);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5])).toISOString() : null;
}
async function lotes(tabela: string, linhas: any[], opcoes: any = {}) {
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from(tabela).upsert(linhas.slice(i, i + 500), opcoes);
    if (error) throw new Error(`${tabela}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const chave = req.headers.get("x-lucro-token");
    const { data: ok } = chave ? await sb.rpc("lucro_token_ok", { p: chave }) : { data: false };
    if (ok !== true) return resp({ ok: false, erro: "Sem acesso." }, 403);
    const tok = await tokenGoogle();
    const [prod, base] = await ler(tok, ["PRODUTOS!A2:H", "BASE!A2:C"], false);
    const [hist] = await ler(tok, ["'HISTÓRICO'!A2:H"], true);

    const produtos = prod.filter((l) => S(l[0])).map((l) => ({ codigo: S(l[0]), marca: S(l[1]), produto: S(l[2]), cor: S(l[3]), custo: N(l[4]), foto: S(l[7]) || null, ativo: true }));
    const codigos = new Set(produtos.map((p) => p.codigo));
    const grade = base.filter((l) => S(l[0]) && codigos.has(S(l[0]))).map((l) => ({ codigo: S(l[0]), tamanho: S(l[1]), quantidade: Math.max(0, Math.round(N(l[2]))) }));
    const historico = hist.map((l) => ({ quando: quando(S(l[0])), usuario: S(l[1]), codigo: S(l[2]), tamanho: S(l[3]), antes: Math.round(N(l[4])), depois: Math.round(N(l[5])), diferenca: Math.round(N(l[6])), origem: "planilha" }))
      .filter((h) => h.quando && h.codigo && h.tamanho);

    // produtos: atualiza os que já existem sem apagar o vínculo com o Fornecedores
    await lotes("est_produtos", produtos, { onConflict: "codigo" });
    await sb.from("est_produtos").update({ ativo: false }).not("codigo", "in", `(${[...codigos].map((c) => `"${c}"`).join(",")})`);
    await sb.from("est_grade").delete().neq("codigo", "");
    await lotes("est_grade", grade, { onConflict: "codigo,tamanho" });
    await sb.from("est_historico").delete().eq("origem", "planilha");
    for (let i = 0; i < historico.length; i += 500) {
      const { error } = await sb.from("est_historico").insert(historico.slice(i, i + 500));
      if (error) throw new Error(`est_historico: ${error.message}`);
    }
    await sb.rpc("est_sincronizar_custos");
    const { data: tot } = await sb.rpc("est_totais");
    return resp({ ok: true, produtos: produtos.length, grade: grade.length, historico: historico.length, totais: tot });
  } catch (e) {
    console.error(e);
    return resp({ ok: false, erro: String((e as Error).message ?? e) }, 500);
  }
});
