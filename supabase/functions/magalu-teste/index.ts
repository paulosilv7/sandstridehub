// Diagnóstico temporário da API da Magalu (somente leitura). Será removido.
import { createClient } from "jsr:@supabase/supabase-js@2";
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
Deno.serve(async (req) => {
  const { data: seg } = await supabase.from("lucro_segredo").select("valor").limit(1).maybeSingle();
  if (!seg?.valor || req.headers.get("x-lucro-token") !== seg.valor) return new Response("Sem acesso", { status: 403 });
  const corpo = await req.json().catch(() => ({}));
  const { data: c } = await supabase.from("credenciais_lojas").select("token_acesso, lojas!inner(id_externo, marketplace)").eq("lojas.marketplace", "magalu").limit(1).maybeSingle();
  if (!c) return Response.json({ erro: "sem credencial" });
  const tenant = (c as any).lojas.id_externo as string;
  const saida: any[] = [];
  for (const t of (corpo.testes ?? [])) {
    const h: Record<string, string> = { Authorization: `Bearer ${c.token_acesso}`, Accept: "application/json" };
    if (t.tenant === "id") h["X-Tenant-Id"] = tenant;
    else if (t.tenant === "semprefixo") h["X-Tenant-Id"] = tenant.replace(/^GENPUB\./, "");
    else if (t.tenant) h["X-Tenant-Id"] = String(t.tenant);
    const r = await fetch(`https://api.magalu.com${t.caminho}`, { headers: h });
    const txt = await r.text();
    saida.push({ caminho: t.caminho, tenant: t.tenant ?? null, status: r.status, corpo: txt.slice(0, corpo.max ?? 700) });
  }
  return Response.json(saida);
});
