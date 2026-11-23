// Devoluções: guarda o texto oficial do Mercado Livre para cada código de motivo (PDD9939, PNR9560...). Só leitura no ML.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import { tokenML as tokenMLCompartilhado } from "../_shared/ml.ts";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ML = "https://api.mercadolibre.com";
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const tokenML = (lojaId: string) => tokenMLCompartilhado(admin, lojaId);
Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return J({ ok: false }, 401);
  const { data: lojas } = await admin.from("lojas").select("id").eq("marketplace", "mercado_livre").eq("ativa", true);
  let tk: string | null = null;
  for (const l of lojas ?? []) { tk = await tokenML(l.id); if (tk) break; }
  if (!tk) return J({ ok: false, m: "sem token" }, 502);
  const { data: cods } = await admin.from("devol_casos").select("motivo_original, lojas!inner(marketplace)").eq("lojas.marketplace", "mercado_livre").not("motivo_original", "is", null).limit(3000);
  const unicos = [...new Set((cods ?? []).map((c: any) => String(c.motivo_original)).filter((c) => /^[A-Z]{3}\d+$/.test(c)))];
  const out: any[] = [];
  for (const cod of unicos) {
    const r = await fetch(`${ML}/post-purchase/v1/claims/reasons/${cod}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r || !r.ok) { out.push({ cod, http: r?.status ?? 0 }); continue; }
    const j: any = await r.json().catch(() => ({}));
    await admin.from("devol_motivos_ml").upsert({ codigo: cod, nome: String(j?.name ?? "").slice(0, 300), detalhe: String(j?.detail ?? "").slice(0, 500), fluxo: String(j?.flow ?? ""), bruto: j, atualizado_em: new Date().toISOString() });
    out.push({ cod, nome: j?.name, detalhe: j?.detail, fluxo: j?.flow });
  }
  return J({ ok: true, out });
});
