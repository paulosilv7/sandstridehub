// Ponte entre os sites da Sandstride e as planilhas do Google.
// Só atende quem está logado, faz parte da equipe e tem acesso à ferramenta pedida.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Planilhas liberadas. "escrita" = pode gravar; as demais são só leitura.
const PLANILHAS: Record<string, { app: string; escrita: boolean }> = {
  '1wBNFiJSXASoe7ru_E-zo_JhhBnyK8cqegiTiTUYBFGg': { app: 'precificacao', escrita: true }, // base oficial
  '10o_H9kqwgwKMrKRpUKvS_tG0oQPvzFEy_7rCJJWoXSs': { app: 'precificacao', escrita: true }, // base de teste
  '1DYmXJSmBv25WE8Xm9FOkQff1p10ODXZolNDWSoB013Q': { app: 'precificacao', escrita: false }, // base antiga
  '1vYGhjXrJsYvPQx0t3cFqvl_fxTKIlmxUnpEzJaTb4cA': { app: 'precificacao', escrita: false }, // estoque
};

function json(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/* ---- token do Google (conta de serviço) ---- */
let cacheToken: { valor: string; expira: number } | null = null;
const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function tokenGoogle(): Promise<string> {
  if (cacheToken && cacheToken.expira > Date.now() + 60_000) return cacheToken.valor;
  const cru = Deno.env.get('GOOGLE_SERVICE_ACCOUNT');
  if (!cru) throw new Error('Conta de serviço do Google não configurada.');
  const conta = JSON.parse(cru);
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: conta.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
  }));
  const pem = String(conta.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(`${cab}.${corpo}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${corpo}.${b64url(assinatura)}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('O Google recusou a conta de serviço.');
  cacheToken = { valor: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cacheToken.valor;
}
async function google(url: string, init: RequestInit = {}) {
  const t = await tokenGoogle();
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
  return r;
}
async function erroGoogle(r: Response) {
  let msg = '';
  try { msg = (await r.json())?.error?.message ?? ''; } catch (_) { /* ignora */ }
  return json({ ok: false, erro: `O Google respondeu ${r.status}${msg ? `: ${msg}` : ''}` }, r.status === 404 ? 404 : r.status === 403 ? 403 : 502);
}

const RANGE_OK = /^[A-Za-z0-9_À-ÿ ]+![A-Z]{1,3}[0-9]{0,6}(:[A-Z]{1,3}[0-9]{0,6})?$/;
const ID_OK = /^[A-Za-z0-9_-]{10,80}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'Método não permitido.' }, 405);
  try {
    // 1) quem é
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ ok: false, erro: 'Faça login para continuar.' }, 401);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: u, error: eu } = await admin.auth.getUser(jwt);
    if (eu || !u?.user) return json({ ok: false, erro: 'Sua sessão expirou. Entre de novo.' }, 401);
    const uid = u.user.id;
    const temAcesso = async (app: string) => {
      const { data: eq } = await admin.from('equipe').select('papel').eq('usuario_id', uid).maybeSingle();
      if (!eq) return false;
      if (eq.papel === 'admin') return true;
      const { data: a } = await admin.from('acessos_apps').select('app').eq('usuario_id', uid).eq('app', app).maybeSingle();
      return !!a;
    };

    const b = await req.json().catch(() => ({}));
    const op = String(b.op ?? '');

    // 2) fotos do Drive
    if (op === 'foto') {
      if (!(await temAcesso('precificacao'))) return json({ ok: false, erro: 'Você não tem acesso a esta ferramenta.' }, 403);
      const id = String(b.fileId ?? '');
      if (!ID_OK.test(id)) return json({ ok: false, erro: 'Arquivo inválido.' }, 400);
      const meta = await google(`https://www.googleapis.com/drive/v3/files/${id}?fields=mimeType,size`);
      if (!meta.ok) return erroGoogle(meta);
      const m = await meta.json();
      if (!String(m.mimeType).startsWith('image/')) return json({ ok: false, erro: 'O arquivo não é uma imagem.' }, 415);
      if (Number(m.size) > 6_000_000) return json({ ok: false, erro: 'Imagem grande demais.' }, 413);
      const r = await google(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
      if (!r.ok) return erroGoogle(r);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = ''; const passo = 0x8000;
      for (let i = 0; i < bytes.length; i += passo) s += String.fromCharCode(...bytes.subarray(i, i + passo));
      return json({ ok: true, dataUri: `data:${m.mimeType};base64,${btoa(s)}` });
    }

    // 3) planilhas
    const sid = String(b.spreadsheetId ?? '');
    const cfg = PLANILHAS[sid];
    if (!cfg) return json({ ok: false, erro: 'Planilha não liberada.' }, 403);
    if (!(await temAcesso(cfg.app))) return json({ ok: false, erro: 'Você não tem acesso a esta ferramenta.' }, 403);
    const range = String(b.range ?? '');
    if (!RANGE_OK.test(range)) return json({ ok: false, erro: 'Intervalo inválido.' }, 400);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}`;

    if (op === 'get') {
      const r = await google(base);
      if (!r.ok) return erroGoogle(r);
      const j = await r.json();
      return json({ ok: true, values: j.values ?? [] });
    }
    if (op === 'update' || op === 'append') {
      if (!cfg.escrita) return json({ ok: false, erro: 'Esta planilha é somente leitura.' }, 403);
      const values = b.values;
      if (!Array.isArray(values) || values.length > 2000 || !values.every((l: unknown) => Array.isArray(l) && l.length <= 60)) {
        return json({ ok: false, erro: 'Dados inválidos.' }, 400);
      }
      const r = op === 'update'
        ? await google(`${base}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values }) })
        : await google(`${base}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ majorDimension: 'ROWS', values }) });
      if (!r.ok) return erroGoogle(r);
      return json({ ok: true });
    }
    return json({ ok: false, erro: 'Operação desconhecida.' }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, erro: e instanceof Error ? e.message : 'Erro inesperado.' }, 500);
  }
});
