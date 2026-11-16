// Recebe o código de autorização do dia do Mercado Livre (coletas/devoluções).
// Quem chama: um script no Gmail de cada loja (Apps Script) que lê o e-mail do Mercado Livre e envia aqui.
// Segurança: segredo no cabeçalho x-codigo-token (tabela ml_codigo_segredo). Só grava o código do dia de hoje.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const J = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const hojeSP = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const igual = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

Deno.serve(async (req) => {
  if (req.method !== "POST") return J({ erro: "use POST" }, 405);
  const { data: seg } = await sb.from("ml_codigo_segredo").select("valor").maybeSingle();
  const enviado = req.headers.get("x-codigo-token") ?? "";
  if (!seg?.valor || !igual(enviado, seg.valor)) return J({ erro: "nao autorizado" }, 401);

  let corpo: any = {};
  try { corpo = await req.json(); } catch (_) { return J({ erro: "json invalido" }, 400); }
  const codigo = String(corpo.codigo ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(codigo)) return J({ erro: "codigo invalido" }, 400);

  // a loja vem pelo apelido (ex.: "Sandstride I"), fixo em cada script
  const apelido = String(corpo.loja ?? "").trim();
  const { data: lojas } = await sb.from("lojas").select("id, apelido").eq("marketplace", "mercado_livre").eq("ativa", true);
  const loja = (lojas ?? []).find((l: any) => String(l.apelido).toLowerCase() === apelido.toLowerCase());
  if (!loja) return J({ erro: "loja desconhecida", validas: (lojas ?? []).map((l: any) => l.apelido) }, 400);

  const dia = hojeSP();
  const { error } = await sb.from("ml_codigos_dia").upsert({ loja_id: loja.id, dia, codigo, recebido_em: new Date().toISOString() }, { onConflict: "loja_id,dia" });
  if (error) return J({ erro: "falha ao gravar" }, 500);
  return J({ ok: true, loja: loja.apelido, dia });
});
