// Token do Mercado Livre: lê o salvo em credenciais_lojas e renova só quando falta menos de 1 min para vencer.
// Se a renovação falhar porque outra função renovou na frente (o refresh token do ML vale uma vez), usa o token que ela gravou.
// deno-lint-ignore-file no-explicit-any
export const ML_API = "https://api.mercadolibre.com";
const CLIENT_ID = Deno.env.get("ML_CLIENT_ID") ?? "7039466443806040";
const CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET") ?? "";

const valido = (c: any) => !!c?.expira_em && new Date(c.expira_em).getTime() - Date.now() > 60_000;

export async function tokenML(db: any, lojaId: string, aoFalhar?: (msg: string) => unknown): Promise<string | null> {
  const ler = () => db.from("credenciais_lojas").select("token_acesso, token_renovacao, expira_em").eq("loja_id", lojaId).maybeSingle();
  const { data: c } = await ler();
  if (valido(c)) return c.token_acesso;
  if (!c?.token_renovacao) return null;
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: c.token_renovacao }),
  });
  const t: any = await r.json().catch(() => ({}));
  if (r.ok) {
    await db.from("credenciais_lojas").update({
      token_acesso: t.access_token,
      token_renovacao: t.refresh_token ?? c.token_renovacao,
      expira_em: new Date(Date.now() + (t.expires_in ?? 21600) * 1000).toISOString(),
      atualizado_em: new Date().toISOString(),
    }).eq("loja_id", lojaId);
    return t.access_token;
  }
  const { data: o } = await ler();
  if (valido(o)) return o.token_acesso;
  await aoFalhar?.(`falha ao renovar o token: ${r.status} ${t?.error ?? ""}`);
  return null;
}
