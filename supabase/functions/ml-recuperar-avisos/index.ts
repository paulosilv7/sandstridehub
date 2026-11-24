// Recupera os avisos do Mercado Livre (mensagens e perguntas) que não conseguimos receber numa pane.
// O ML guarda por cerca de 2 dias os avisos que falharam (missed_feeds). Esta função pede esses avisos de volta
// e reenvia cada um para ml-notificacoes, que grava de forma idempotente (mesma mensagem nunca duplica).
// Corpo: { desde: ISO, ate?: ISO, topicos?: ["messages","questions"], simular?: true }. Cabeçalho x-lucro-token.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://api.mercadolibre.com";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function token(lojaId: string): Promise<string | null> {
  const ler = () => supabase.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: cred } = await ler();
  const valido = (c: any) => c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;
  if (cred && valido(cred)) return cred.token_acesso;
  if (!cred?.token_renovacao) return null;
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: cred.token_renovacao }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) { const { data: outra } = await ler(); return valido(outra) ? outra!.token_acesso : null; }
  await supabase.from("credenciais_lojas").update({
    token_acesso: t.access_token, token_renovacao: t.refresh_token ?? cred.token_renovacao,
    expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(), atualizado_em: new Date().toISOString(),
  }).eq("loja_id", lojaId);
  return t.access_token;
}

Deno.serve(async (req) => {
  const enviado = req.headers.get("x-lucro-token") ?? "";
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || enviado !== seg.valor) return new Response("não autorizado", { status: 401 });
  const corpo: any = await req.json().catch(() => ({}));
  const desde = new Date(corpo.desde ?? Date.now() - 48 * 3600_000).getTime();
  const ate = new Date(corpo.ate ?? Date.now()).getTime();
  const topicos: string[] = corpo.topicos ?? ["messages", "questions"];
  const simular = !!corpo.simular;

  const { data: lojas } = await supabase.from("lojas").select("id, id_externo, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
  const resumo: any = { lojas: (lojas ?? []).length, topicos: {}, reenviados: 0, erros: [] as string[] };
  const vistos = new Set<string>();
  const selfUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ml-notificacoes`;

  for (const loja of lojas ?? []) {
    const tk = await token(loja.id);
    if (!tk) { resumo.erros.push(`sem token: ${loja.apelido}`); continue; }
    for (const topico of topicos) {
      let offset = 0, total = Infinity, paginas = 0;
      while (offset < total && paginas < 60) {
        const url = `${API}/missed_feeds?app_id=${CLIENT_ID}&topic=${topico}&offset=${offset}&limit=50`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
        if (!r.ok) { resumo.erros.push(`${loja.apelido}/${topico}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`); break; }
        const d: any = await r.json();
        const lista: any[] = d?.messages ?? [];
        total = Number(d?.paging?.total ?? lista.length);
        const chave = `${loja.apelido}/${topico}`;
        resumo.topicos[chave] = { total, lidos: ((resumo.topicos[chave]?.lidos) ?? 0) + lista.length };
        for (const n of lista) {
          const quando = new Date(n.sent ?? n.received ?? 0).getTime();
          if (quando < desde || quando > ate) continue;
          if (String(n.user_id) !== String(loja.id_externo)) continue;
          const k = `${n.topic}:${n.resource}`;
          if (vistos.has(k)) continue;
          vistos.add(k);
          if (simular) { resumo.reenviados++; continue; }
          const rr = await fetch(selfUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: n.topic, resource: n.resource, user_id: n.user_id, application_id: n.application_id }) });
          if (rr.ok) resumo.reenviados++; else resumo.erros.push(`reenvio ${k}: ${rr.status}`);
        }
        if (!lista.length) break;
        offset += lista.length; paginas++;
      }
    }
  }
  return new Response(JSON.stringify(resumo), { headers: { "Content-Type": "application/json" } });
});
