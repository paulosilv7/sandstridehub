// Lucro Ao Vivo: copia da Precificação (tabela prec_versoes do banco, canal MERCADO_LIVRE) o frete de cada versão para a tabela lucro_frete_ref.
// Esse frete é só uma RESERVA: o Lucro usa enquanto o Mercado Livre ainda não manda o frete oficial do envio (pedido com frete_pendente).
// O frete oficial nunca é sobrescrito por este valor.
// Quem chama: o agendador do banco (x-lucro-token), junto com as demais sincronizações do Lucro.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lucro-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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
    const { data: linhas, error: el } = await supabase.from("prec_versoes").select("id_produto, status, preco_venda, frete").eq("id_canal", "MERCADO_LIVRE");
    if (el) return resp({ ok: false, erro: el.message }, 500);

    const ativos = new Map<string, number>(), arquivados = new Map<string, number>();
    for (const l of linhas ?? []) {
      const codigo = String(l.id_produto ?? "").trim(), status = String(l.status ?? "").trim();
      const preco = numero(l.preco_venda), frete = numero(l.frete);
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
    // remove o que saiu da Precificação
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
