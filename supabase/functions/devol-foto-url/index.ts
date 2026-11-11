// Gera links temporários (10 min) das fotos de um caso para baixar. Só com o token interno.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  const { data: seg } = await admin.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return J({ ok: false }, 401);
  const corpo: any = await req.json().catch(() => ({}));
  const caminhos: string[] = (Array.isArray(corpo.caminhos) ? corpo.caminhos : []).filter((c: any) => typeof c === "string" && c.startsWith("recebimentos/")).slice(0, 12);
  const out: any[] = [];
  for (const c of caminhos) {
    const { data } = await admin.storage.from("devol-provas").createSignedUrl(c, 600);
    out.push({ caminho: c, url: data?.signedUrl ?? null });
  }
  return J({ ok: true, out });
});
