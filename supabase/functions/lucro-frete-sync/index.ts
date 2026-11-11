// Lucro Ao Vivo: copia da Precificação (aba VERSOES, canal MERCADO_LIVRE) o frete de cada versão para a tabela lucro_frete_ref.
// Esse frete é só uma RESERVA: o Lucro usa enquanto o Mercado Livre ainda não manda o frete oficial do envio (pedido com frete_pendente).
// O frete oficial nunca é sobrescrito por este valor.
// Quem chama: o agendador do banco (x-lucro-token), junto com as demais sincronizações do Lucro.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const PLANILHA = "1wBNFiJSXASoe7ru_E-zo_JhhBnyK8cqegiTiTUYBFGg"; // base oficial da Precificação
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

let cacheToken: { valor: string; expira: number } | null = null;
const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function tokenGoogle(): Promise<string> {
  if (cacheToken && cacheToken.expira > Date.now() + 60_000) return cacheToken.valor;
  const cru = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
  if (!cru) throw new Error("Conta de serviço do Google não configurada.");
  const conta = JSON.parse(cru);
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({
    iss: conta.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600,
  }));
  const pem = String(conta.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(`${cab}.${corpo}`));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${cab}.${corpo}.${b64url(assinatura)}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("O Google recusou a conta de serviço.");
  cacheToken = { valor: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cacheToken.valor;
}

// "R$ 1.234,56", "22,25", "15" ou 8.75 -> número (null se vazio/inválido)
function numero(v: any): number | null {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/R\$/g, "").replace(/\s/g, "");
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function autorizado(req: Request): Promise<boolean> {
  const chave = req.headers.get("x-lucro-token");
  if (!chave) return false;
  const { data } = await supabase.rpc("lucro_token_ok", { p: chave });
  return data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp({ ok: false, erro: "Método não permitido." }, 405);
  try {
    if (!(await autorizado(req))) return resp({ ok: false, erro: "Sem acesso." }, 403);
    const t = await tokenGoogle();
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${PLANILHA}/values/${encodeURIComponent("VERSOES!A2:K2000")}`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return resp({ ok: false, erro: `Google respondeu ${r.status}` }, 502);
    const linhas: any[][] = (await r.json()).values ?? [];

    // colunas: A id_versao, B id_produto, C id_canal, D nome, E status, F preco_venda, ... K frete
    const ativos = new Map<string, number>(), arquivados = new Map<string, number>();
    for (const l of linhas) {
      if (String(l[2] ?? "").trim() !== "MERCADO_LIVRE") continue;
      const codigo = String(l[1] ?? "").trim(), status = String(l[4] ?? "").trim();
      const preco = numero(l[5]), frete = numero(l[10]);
      if (!codigo || preco === null || preco <= 0 || frete === null) continue; // sem frete na versão = sem reserva
      if (status === "Rascunho") continue;
      (status === "Arquivada" ? arquivados : ativos).set(`${codigo}|${preco}`, frete);
    }
    // versão arquivada só serve de reserva para produto que não tem nenhuma versão em uso
    const usados = new Set([...ativos.keys()].map((k) => k.split("|")[0]));
    const final = new Map(ativos);
    for (const [k, f] of arquivados) if (!usados.has(k.split("|")[0])) final.set(k, f);
    if (final.size < 5) return resp({ ok: false, erro: `Só ${final.size} fretes lidos da Precificação; tabela mantida.` }, 200);

    const rows = [...final].map(([k, frete]) => { const [codigo, preco] = k.split("|"); return { codigo, preco: Number(preco), frete, atualizado_em: new Date().toISOString() }; });
    const { error: eu } = await supabase.from("lucro_frete_ref").upsert(rows, { onConflict: "codigo,preco" });
    if (eu) return resp({ ok: false, erro: eu.message }, 500);
    // remove o que saiu da planilha
    const { data: atuais } = await supabase.from("lucro_frete_ref").select("codigo, preco");
    const sobra = (atuais ?? []).filter((a: any) => !final.has(`${a.codigo}|${Number(a.preco)}`));
    for (const s of sobra) await supabase.from("lucro_frete_ref").delete().eq("codigo", s.codigo).eq("preco", s.preco);
    // recalcula hoje e ontem (pedidos com frete provisório usam a reserva)
    const { count } = await supabase.from("lucro_pedidos").select("id", { count: "exact", head: true }).eq("frete_pendente", true);
    if ((count ?? 0) > 0) {
      const { data: dias } = await supabase.from("lucro_pedidos").select("dia").eq("frete_pendente", true);
      for (const d of new Set((dias ?? []).map((x: any) => x.dia))) await supabase.rpc("lucro_calcular_dia", { p_dia: d });
    }
    return resp({ ok: true, fretes: rows.length, removidos: sobra.length, pendentes: count ?? 0 });
  } catch (e) {
    console.error("lucro-frete-sync", (e as Error).message);
    return resp({ ok: false, erro: "Falha inesperada." }, 500);
  }
});
