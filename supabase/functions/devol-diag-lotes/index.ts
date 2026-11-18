// Diagnóstico (somente leitura): para cada lote sem caso, diz por que não liga.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ML = "https://api.mercadolibre.com";
async function get(p: string, tk: string, extra: Record<string, string> = {}) {
  try { const r = await fetch(`${ML}${p}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json", ...extra }, signal: AbortSignal.timeout(15_000) }); return { ok: r.ok, j: await r.json().catch(() => null) }; } catch (_) { return { ok: false, j: null }; }
}
Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return new Response("no", { status: 401 });
  const { data: lojas } = await admin.from("lojas").select("id, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
  const toks: { ap: string; tk: string }[] = [];
  for (const l of lojas ?? []) { const { data: c } = await admin.from("credenciais_lojas").select("token_acesso").eq("loja_id", l.id).maybeSingle(); if (c?.token_acesso) toks.push({ ap: l.apelido, tk: c.token_acesso }); }
  const { data: lotes } = await admin.from("devol_recebimentos").select("id, criado_em, analise_resumo").is("caso_id", null).is("dispensado_em", null).order("criado_em", { ascending: false }).limit(60);
  const out: any[] = [];
  for (const r of lotes ?? []) {
    const et: any[] = (r.analise_resumo?.etiqueta ?? []).filter((e: any) => e?.tipo !== "nome");
    const nums = [...new Set(et.map((e: any) => String(e.valor ?? "").replace(/\D/g, "")).filter((n: string) => n.length >= 8 && n.length <= 16))] as string[];
    const alfa = et.map((e: any) => String(e.valor ?? "")).filter((v: string) => /^[0-9]{6}[A-Z0-9]{6,10}$/i.test(v.replace(/\s/g, "")) && /[A-Za-z]/.test(v));
    const d: any = { id: String(r.id).slice(0, 8), dia: String(r.criado_em).slice(0, 10), nums, alfa, ml: [] as any[] };
    for (const n of nums) {
      for (const t of toks) {
        const sh = await get(`/shipments/${n}`, t.tk, { "x-format-new": "true" });
        if (sh.ok && sh.j?.id) {
          const it = await get(`/shipments/${n}/items`, t.tk);
          const pedido = String(Array.isArray(it.j) ? (it.j[0]?.order_id ?? "") : "");
          let nc = -1;
          if (pedido) { const cl = await get(`/post-purchase/v1/claims/search?resource=order&resource_id=${pedido}`, t.tk); nc = (cl.j?.data ?? []).length; }
          const { data: caso } = pedido ? await admin.from("devol_casos").select("status").eq("pedido", pedido).limit(1).maybeSingle() : { data: null } as any;
          d.ml.push({ n, loja: t.ap, pedido, st: `${sh.j.status}/${sh.j.substatus}`, reclamacoes: nc, caso_hub: caso?.status ?? null });
          break;
        }
      }
      if (d.ml.length) break;
    }
    out.push(d);
  }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
