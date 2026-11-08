// Devoluções (SOMENTE LEITURA): guarda, em cada caso do Mercado Livre com revisão pendente, o número do envio da devolução
// (o número de 11 dígitos que vai impresso na etiqueta do pacote), para a Sandy ligar o lote de fotos ao caso certo.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function um(c: any, token: string) {
  try {
    const r = await fetch(`https://api.mercadolibre.com/post-purchase/v2/claims/${c.solicitacao_id}/returns`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 || r.status >= 500) return;
    let id = "-";
    if (r.ok) {
      const j: any = await r.json();
      const s = (j?.shipments ?? []).find((x: any) => String(x?.type ?? "return") === "return" && x?.shipment_id);
      if (s) id = String(s.shipment_id);
    }
    await supabase.from("devol_casos").update({ envio_devolucao_id: id }).eq("id", c.id);
  } catch (_) { /* tenta na próxima */ }
}

async function executar() {
  const inicio = Date.now();
  const { data: kill } = await supabase.from("devol_config").select("valor").eq("chave", "kill_switch").maybeSingle();
  if (kill?.valor === "true") return;
  const { data: lojas } = await supabase.from("lojas").select("id").eq("marketplace", "mercado_livre").eq("ativa", true);
  for (const l of lojas ?? []) {
    const { data: cred } = await supabase.from("credenciais_lojas").select("token_acesso, expira_em").eq("loja_id", l.id).maybeSingle();
    if (!cred?.token_acesso || !cred.expira_em || new Date(cred.expira_em).getTime() - Date.now() < 60_000) continue;
    const { data: casos } = await supabase.from("devol_casos").select("id, solicitacao_id").eq("loja_id", l.id).is("envio_devolucao_id", null)
      .not("status", "in", "(ENCERRADO,CONCILIADO)").contains("acoes_loja", ["return_review_ok"]).limit(80);
    const lista = casos ?? [];
    for (let i = 0; i < lista.length; i += 6) {
      if (Date.now() - inicio > 100_000) return;
      await Promise.all(lista.slice(i, i + 6).map((c: any) => um(c, cred.token_acesso)));
    }
  }
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  EdgeRuntime.waitUntil(executar());
  return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "Content-Type": "application/json" } });
});
