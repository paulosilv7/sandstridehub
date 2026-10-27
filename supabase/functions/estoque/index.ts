// Estoque do galpão: lê e grava na planilha do Google (BASE, PRODUTOS, HISTÓRICO, ETIQUETAS).
// Só atende quem está logado e tem acesso à ferramenta "estoque"; cadastrar/editar exige administrador.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PLANILHAS: Record<string, string> = {
  oficial: '1vYGhjXrJsYvPQx0t3cFqvl_fxTKIlmxUnpEzJaTb4cA',
  teste: '1l90QI4xrqMRyDyx-ht90lYfs_uiHqDK7BAFzQmpYoQ4',
};
const FUSO = 'America/Sao_Paulo';

class ErroUsuario extends Error {}
const falha = (m: string): never => { throw new ErroUsuario(m); };
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ---------- Google ---------- */
let cacheToken: { valor: string; expira: number } | null = null;
const b64url = (b: ArrayBuffer | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function tokenGoogle(): Promise<string> {
  if (cacheToken && cacheToken.expira > Date.now() + 60_000) return cacheToken.valor;
  const cru = Deno.env.get('GOOGLE_SERVICE_ACCOUNT');
  if (!cru) falha('Conta de serviço do Google não configurada.');
  const conta = JSON.parse(cru!);
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: conta.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600,
  }));
  const pem = String(conta.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const ass = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(`${cab}.${corpo}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${corpo}.${b64url(ass)}` }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) falha('O Google recusou a conta de serviço.');
  cacheToken = { valor: j.access_token, expira: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cacheToken.valor;
}
async function g(url: string, init: RequestInit = {}) {
  const t = await tokenGoogle();
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } });
  if (!r.ok) {
    let msg = ''; try { msg = (await r.json())?.error?.message ?? ''; } catch (_) { /* ignora */ }
    console.error('google', r.status, url, msg);
    falha(`O Google respondeu ${r.status}${msg ? `: ${msg}` : ''}`);
  }
  return r.json();
}
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const enc = encodeURIComponent;

class Planilha {
  constructor(public id: string) {}
  async ler(ranges: string[], formatado = false): Promise<any[][][]> {
    const q = ranges.map((r) => `ranges=${enc(r)}`).join('&');
    const opc = formatado ? 'valueRenderOption=FORMATTED_VALUE' : 'valueRenderOption=UNFORMATTED_VALUE';
    const j = await g(`${API}/${this.id}/values:batchGet?${q}&${opc}`);
    return (j.valueRanges ?? []).map((v: any) => v.values ?? []);
  }
  async gravar(data: { range: string; values: any[][] }[]) {
    if (!data.length) return;
    await g(`${API}/${this.id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
  }
  async limpar(ranges: string[]) {
    if (!ranges.length) return;
    await g(`${API}/${this.id}/values:batchClear`, { method: 'POST', body: JSON.stringify({ ranges }) });
  }
  async acrescentar(range: string, values: any[][]) {
    await g(`${API}/${this.id}/values/${enc(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ values }) });
  }
  async abas(): Promise<Record<string, { id: number; linhas: number }>> {
    const j = await g(`${API}/${this.id}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`);
    const m: Record<string, { id: number; linhas: number }> = {};
    for (const s of j.sheets ?? []) m[s.properties.title] = { id: s.properties.sheetId, linhas: s.properties.gridProperties?.rowCount ?? 0 };
    return m;
  }
  async lote(requests: any[]) {
    if (!requests.length) return;
    await g(`${API}/${this.id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
  }
}

/* ---------- utilitários ---------- */
const S = (v: any) => (v === undefined || v === null ? '' : String(v).trim());
const N = (v: any) => { const n = Number(typeof v === 'string' ? v.replace(/\./g, '').replace(',', '.') : v); return Number.isFinite(n) ? n : 0; };
const numTam = (t: string) => { const n = parseFloat(t); return Number.isFinite(n) ? n : 9999; };
function agoraSP() {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const hh = v('hour') === '24' ? '00' : v('hour');
  return { texto: `${v('day')}/${v('month')}/${v('year')} ${hh}:${v('minute')}`, data: `${v('day')}/${v('month')}/${v('year')}`, hora: `${hh}:${v('minute')}` };
}
function msDoTexto(t: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] + 3, +m[5]); // Brasília = UTC-3
}
const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const limpaNome = (s: string) => semAcento(S(s)).toUpperCase().replace(/\s+/g, ' ');
const SIGLAS: Record<string, string> = { 'VERMELHO': 'VML', 'VERDE': 'VRD', 'PRETO/BRANCO': 'PTB', 'BRANCO/PRETO': 'BPT' };
function siglaCor(cor: string) {
  const c = limpaNome(cor);
  if (SIGLAS[c]) return SIGLAS[c];
  if (c.includes('/')) { const p = c.split('/').map((x) => x.replace(/[^A-Z]/g, '')); return (p.map((x) => x[0]).join('') + (p[0] ?? '').slice(1)).slice(0, 3); }
  return c.replace(/[^A-Z]/g, '').slice(0, 3) || 'COR';
}

/* ---------- leitura do estado ---------- */
async function estado(p: Planilha) {
  const [prod, base] = await p.ler(['PRODUTOS!A2:H', 'BASE!A2:C']);
  const tamanhos = new Map<string, { tamanho: string; quantidade: number }[]>();
  base.forEach((l) => {
    const cod = S(l[0]); if (!cod) return;
    if (!tamanhos.has(cod)) tamanhos.set(cod, []);
    tamanhos.get(cod)!.push({ tamanho: S(l[1]), quantidade: N(l[2]) });
  });
  const produtos: any[] = [];
  prod.forEach((l, i) => {
    const cod = S(l[0]); if (!cod) return;
    const lista = (tamanhos.get(cod) ?? []).slice().sort((a, b) => numTam(a.tamanho) - numTam(b.tamanho));
    produtos.push({
      codigo: cod, marca: S(l[1]), produto: S(l[2]), cor: S(l[3]), custo: N(l[4]), foto: S(l[7]),
      grade: lista.map((t) => t.tamanho), qtds: lista.map((t) => t.quantidade), contado: null, _linha: i + 2,
    });
  });
  return { produtos, tamanhos, base };
}
function totaisDe(produtos: any[]) {
  let pares = 0, valor = 0;
  produtos.forEach((p) => p.qtds.forEach((q: number) => { pares += q; valor += q * p.custo; }));
  return { pares, valor: Math.round(valor * 100) / 100 };
}
const publico = (p: any) => { const { _linha, ...resto } = p; return resto; };

async function contagens(p: Planilha): Promise<Map<string, number>> {
  const [h] = await p.ler(["'HISTÓRICO'!A2:C"], true);
  const m = new Map<string, number>();
  h.forEach((l) => { const ms = msDoTexto(S(l[0])); const c = S(l[2]); if (ms && c && ms > (m.get(c) ?? 0)) m.set(c, ms); });
  return m;
}

/* ---------- operações ---------- */
async function iniciar(p: Planilha, ctx: any) {
  const [e, cont] = await Promise.all([estado(p), contagens(p)]);
  e.produtos.forEach((x) => { x.contado = cont.get(x.codigo) ?? null; });
  return { email: ctx.email, admin: ctx.admin, produtos: e.produtos.map(publico), totais: totaisDe(e.produtos) };
}

async function buscarProduto(p: Planilha, _ctx: any, codigo: string) {
  const e = await estado(p);
  const x = e.produtos.find((q) => q.codigo === S(codigo));
  if (!x) falha('Produto não encontrado.');
  const lista = (e.tamanhos.get(x.codigo) ?? []).slice().sort((a, b) => numTam(a.tamanho) - numTam(b.tamanho));
  return { codigo: x.codigo, produto: x.produto, cor: x.cor, foto: x.foto, tamanhos: lista };
}

async function lancar(p: Planilha, ctx: any, lista: { codigo: string; itens: { tamanho: string; antes: number; depois: number }[] }[]) {
  if (!Array.isArray(lista) || !lista.length || lista.length > 200) falha('Nada para lançar.');
  const [base] = await p.ler(['BASE!A2:C']);
  const linha = new Map<string, { n: number; q: number }>();
  base.forEach((l, i) => { const c = S(l[0]); if (c) linha.set(`${c}|${S(l[1])}`, { n: i + 2, q: N(l[2]) }); });
  const quando = agoraSP();
  const grava: { range: string; values: any[][] }[] = [];
  const hist: any[][] = [];
  const cods = new Set<string>();
  for (const prod of lista) {
    const cod = S(prod.codigo);
    if (!Array.isArray(prod.itens)) falha('Dados inválidos.');
    for (const it of prod.itens) {
      const tam = S(it.tamanho); const depois = Math.round(N(it.depois));
      if (depois < 0 || depois > 100000) falha(`Quantidade inválida no tamanho ${tam}.`);
      const alvo = linha.get(`${cod}|${tam}`);
      if (!alvo) falha(`Tamanho ${tam} não existe em ${cod}.`);
      grava.push({ range: `BASE!C${alvo!.n}`, values: [[depois]] });
      hist.push([quando.texto, ctx.email, cod, `'${tam}`, alvo!.q, depois, depois - alvo!.q, '']);
      cods.add(cod);
    }
  }
  await p.gravar(grava);
  if (hist.length) await p.acrescentar("'HISTÓRICO'!A:H", hist);
  const e = await estado(p);
  return { quando: `${quando.data} às ${quando.hora}`, contado: Date.now(), totais: totaisDe(e.produtos) };
}
const lancarVarios = (p: Planilha, c: any, l: any) => lancar(p, c, l);
const lancarEstoque = (p: Planilha, c: any, codigo: string, itens: any[]) => lancar(p, c, [{ codigo, itens }]);

async function listarHistorico(p: Planilha, _ctx: any, n: number) {
  const limite = Math.min(Math.max(Number(n) || 200, 1), 500);
  const [[h], [prod]] = await Promise.all([p.ler(["'HISTÓRICO'!A2:H"], true).then((r) => [r[0]]), p.ler(['PRODUTOS!A2:D']).then((r) => [r[0]])]);
  const info = new Map<string, { produto: string; cor: string }>();
  const linhasProd = prod ?? [];
  linhasProd.forEach((l: any[]) => { const c = S(l[0]); if (c) info.set(c, { produto: S(l[2]), cor: S(l[3]) }); });
  const grupos: any[] = [];
  let atual: any = null; let chave = '';
  for (const l of h) {
    const quando = S(l[0]), usuario = S(l[1]), cod = S(l[2]);
    if (!quando || !cod) continue;
    const k = `${quando}|${usuario}|${cod}`;
    if (!atual || k !== chave) {
      const i = info.get(cod);
      atual = { quando: msDoTexto(quando) ?? 0, usuario, codigo: cod, produto: i?.produto ?? cod, cor: i?.cor ?? '', itens: [] };
      grupos.push(atual); chave = k;
    }
    atual.itens.push({ tamanho: S(l[3]), antes: N(l[4]), depois: N(l[5]) });
  }
  return grupos.reverse().slice(0, limite);
}

async function exigirAdmin(ctx: any) { if (!ctx.admin) falha('Só administradores podem cadastrar ou editar produtos.'); }

async function guardarFoto(ctx: any, codigo: string, foto: { base64: string; tipo: string }) {
  if (!foto?.base64 || String(foto.tipo) !== 'image/jpeg') falha('Foto inválida.');
  if (foto.base64.length > 2_500_000) falha('A foto ficou grande demais.');
  const bytes = Uint8Array.from(atob(foto.base64), (c) => c.charCodeAt(0));
  const caminho = `${codigo.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.jpg`;
  const { error } = await ctx.admin_sb.storage.from('fotos-estoque').upload(caminho, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) falha(`Não consegui guardar a foto: ${error.message}`);
  return `sb:${caminho}`;
}

async function cadastrarProdutos(p: Planilha, ctx: any, d: any) {
  await exigirAdmin(ctx);
  const marca = limpaNome(d?.marca), modelo = limpaNome(d?.produto);
  if (!marca || !modelo) falha('Informe a marca e o modelo.');
  if (!Array.isArray(d.cores) || !d.cores.length || d.cores.length > 30) falha('Informe ao menos uma cor.');
  const custo = Math.max(0, N(d.custo));
  const abas = await p.abas();
  if (!abas['PRODUTOS'] || !abas['BASE'] || !abas['ETIQUETAS']) falha('A planilha não tem as abas esperadas.');
  const [prod, base] = await p.ler(['PRODUTOS!A2:H', 'BASE!A2:A']);
  const usados = new Set(prod.map((l) => S(l[0])).filter(Boolean));
  const livres: number[] = [];
  for (let i = 0; i < 300; i++) { if (!S(prod[i]?.[0])) livres.push(i + 2); }
  let proximaBase = 2;
  base.forEach((l, i) => { if (S(l[0])) proximaBase = i + 3; });
  const baseGrava: any[][] = []; const reqs: any[] = []; const criados: any[] = []; const gravaProd: { range: string; values: any[][] }[] = [];
  for (const c of d.cores) {
    const cor = limpaNome(c.cor); if (!cor) falha('Cor sem nome.');
    const tams: string[] = Array.isArray(c.tamanhos) ? c.tamanhos.map((t: any) => S(t)).filter(Boolean) : [];
    if (!tams.length || tams.length > 40) falha(`Informe os tamanhos de ${cor}.`);
    if (prod.some((l) => limpaNome(S(l[1])) === marca && limpaNome(S(l[2])) === modelo && limpaNome(S(l[3])) === cor)) falha(`${modelo} ${cor} já está cadastrado.`);
    const bruto = `${modelo.replace(/[^A-Z0-9]/g, '')}-${siglaCor(cor)}`;
    let cod = bruto, k = 2; while (usados.has(cod)) cod = `${bruto}${k++}`; usados.add(cod);
    const linha = livres.shift(); if (!linha) falha('A aba PRODUTOS está cheia.');
    if (linha! > 200) falha('A aba PRODUTOS chegou ao limite de linhas.');
    const foto = c.foto ? await guardarFoto(ctx, cod, c.foto) : '';
    gravaProd.push({ range: `PRODUTOS!A${linha}:E${linha}`, values: [[cod, marca, modelo, cor, custo]] });
    if (foto) gravaProd.push({ range: `PRODUTOS!H${linha}`, values: [[foto]] });
    tams.forEach((t) => baseGrava.push([cod, `${t}`, 0]));
    // fórmulas de quantidade/valor (PRODUTOS F:G) e da etiqueta: copiadas da linha 2
    reqs.push({ copyPaste: { source: { sheetId: abas['PRODUTOS'].id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 7 }, destination: { sheetId: abas['PRODUTOS'].id, startRowIndex: linha! - 1, endRowIndex: linha!, startColumnIndex: 0, endColumnIndex: 7 }, pasteType: 'PASTE_FORMAT' } });
    reqs.push({ copyPaste: { source: { sheetId: abas['PRODUTOS'].id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 5, endColumnIndex: 7 }, destination: { sheetId: abas['PRODUTOS'].id, startRowIndex: linha! - 1, endRowIndex: linha!, startColumnIndex: 5, endColumnIndex: 7 }, pasteType: 'PASTE_FORMULA' } });
    if (abas['ETIQUETAS'].linhas < linha!) reqs.push({ appendDimension: { sheetId: abas['ETIQUETAS'].id, dimension: 'ROWS', length: linha! - abas['ETIQUETAS'].linhas } });
    reqs.push({ copyPaste: { source: { sheetId: abas['ETIQUETAS'].id, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 5 }, destination: { sheetId: abas['ETIQUETAS'].id, startRowIndex: linha! - 1, endRowIndex: linha!, startColumnIndex: 0, endColumnIndex: 5 }, pasteType: 'PASTE_FORMULA' } });
    criados.push({ codigo: cod, marca, produto: modelo, cor, foto, custo, grade: tams.slice().sort((a, b) => numTam(a) - numTam(b)), qtds: tams.map(() => 0), contado: null });
  }
  if (proximaBase + baseGrava.length > 1000) falha('A aba BASE chegou ao limite de linhas.');
  await p.gravar(gravaProd);
  await p.gravar([{ range: `BASE!A${proximaBase}:C${proximaBase + baseGrava.length - 1}`, values: baseGrava }]);
  await p.lote(reqs);
  return criados;
}

async function editarProduto(p: Planilha, ctx: any, d: any) {
  await exigirAdmin(ctx);
  const codigo = S(d?.codigo);
  const e = await estado(p);
  const x = e.produtos.find((q) => q.codigo === codigo);
  if (!x) falha('Produto não encontrado.');
  const abas = await p.abas();
  const aba = abas[x!.marca];
  const novoModelo = limpaNome(d.produto) || x!.produto, novaCor = limpaNome(d.cor) || x!.cor;

  if (d.arquivar) {
    const [base] = await p.ler(['BASE!A2:A']);
    const alvo: string[] = [];
    base.forEach((l, i) => { if (S(l[0]) === codigo) alvo.push(`BASE!A${i + 2}:C${i + 2}`); });
    await p.limpar([`PRODUTOS!A${x!._linha}:E${x!._linha}`, `PRODUTOS!H${x!._linha}`, ...alvo]);
  } else {
    // nomes: atualiza a aba da marca (cabeçalho do modelo e a cor dentro do bloco do modelo)
    if (aba && (novoModelo !== x!.produto || novaCor !== x!.cor)) {
      const [tab] = await p.ler([`'${x!.marca}'!A1:BZ400`], true);
      let col = -1, lin = -1;
      for (let r = 0; r < Math.min(12, tab.length) && col < 0; r++) for (let c = 0; c < (tab[r]?.length ?? 0); c++) if (limpaNome(S(tab[r][c])) === x!.produto && c < 200) { col = c; lin = r; break; }
      const letra = (n: number) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
      const grava: { range: string; values: any[][] }[] = [];
      if (col >= 0) {
        if (novaCor !== x!.cor) for (let r = lin + 1; r < tab.length; r++) if (limpaNome(S(tab[r]?.[col])) === x!.cor) grava.push({ range: `'${x!.marca}'!${letra(col)}${r + 1}`, values: [[novaCor]] });
        // o cabeçalho só muda se nenhuma outra cor continuar usando o nome antigo
        if (novoModelo !== x!.produto) {
          grava.push({ range: `'${x!.marca}'!${letra(col)}${lin + 1}`, values: [[novoModelo]] });
        }
      }
      await p.gravar(grava);
    }
    const gravaProd: { range: string; values: any[][] }[] = [];
    if (novoModelo !== x!.produto) e.produtos.filter((q) => q.marca === x!.marca && q.produto === x!.produto).forEach((q) => gravaProd.push({ range: `PRODUTOS!C${q._linha}`, values: [[novoModelo]] }));
    if (novaCor !== x!.cor) gravaProd.push({ range: `PRODUTOS!D${x!._linha}`, values: [[novaCor]] });
    if (d.custo !== null && d.custo !== undefined) {
      const custo = Math.max(0, N(d.custo));
      const alvos = d.custoTodas ? e.produtos.filter((q) => q.marca === x!.marca && q.produto === x!.produto) : [x!];
      alvos.forEach((q) => gravaProd.push({ range: `PRODUTOS!E${q._linha}`, values: [[custo]] }));
    }
    if (d.foto) gravaProd.push({ range: `PRODUTOS!H${x!._linha}`, values: [[await guardarFoto(ctx, codigo, d.foto)]] });
    await p.gravar(gravaProd);

    const remover: string[] = Array.isArray(d.remover) ? d.remover.map((t: any) => S(t)) : [];
    const adicionar: string[] = Array.isArray(d.adicionar) ? d.adicionar.map((t: any) => S(t)).filter(Boolean) : [];
    if (remover.length || adicionar.length) {
      const [base] = await p.ler(['BASE!A2:C']);
      const limpa: string[] = []; let proxima = 2; const existentes = new Set<string>();
      base.forEach((l, i) => {
        if (S(l[0])) proxima = i + 3;
        if (S(l[0]) === codigo) { existentes.add(S(l[1])); if (remover.includes(S(l[1]))) limpa.push(`BASE!A${i + 2}:C${i + 2}`); }
      });
      await p.limpar(limpa);
      const novos = adicionar.filter((t) => !existentes.has(t));
      if (novos.length) {
        if (proxima + novos.length > 1000) falha('A aba BASE chegou ao limite de linhas.');
        await p.gravar([{ range: `BASE!A${proxima}:C${proxima + novos.length - 1}`, values: novos.map((t) => [codigo, t, 0]) }]);
      }
    }
  }
  const [novo, cont] = await Promise.all([estado(p), contagens(p)]);
  novo.produtos.forEach((q) => { q.contado = cont.get(q.codigo) ?? null; });
  return { produtos: novo.produtos.map(publico), totais: totaisDe(novo.produtos) };
}

const FUNCOES: Record<string, (p: Planilha, ctx: any, ...a: any[]) => Promise<any>> = {
  iniciar, buscarProduto, lancarVarios, lancarEstoque, listarHistorico, cadastrarProdutos, editarProduto,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, erro: 'Método não permitido.' }, 405);
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ ok: false, erro: 'Faça login para continuar.' }, 401);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: u, error: eu } = await sb.auth.getUser(jwt);
    if (eu || !u?.user) return json({ ok: false, erro: 'Sua sessão expirou. Entre de novo.' }, 401);
    const uid = u.user.id;
    const { data: eq } = await sb.from('equipe').select('papel').eq('usuario_id', uid).maybeSingle();
    let acesso = eq?.papel === 'admin';
    if (!acesso && eq) {
      const { data: a } = await sb.from('acessos_apps').select('app').eq('usuario_id', uid).eq('app', 'estoque').maybeSingle();
      acesso = !!a;
    }
    if (!acesso) return json({ ok: false, erro: 'Você não tem acesso a esta ferramenta.' }, 403);

    const b = await req.json().catch(() => ({}));
    const fn = String(b.fn ?? '');
    if (!Object.prototype.hasOwnProperty.call(FUNCOES, fn)) return json({ ok: false, erro: 'Operação desconhecida.' }, 400);
    // Enquanto o estoque não for validado, o padrão é a planilha de TESTE; a oficial só com base: 'oficial'.
    const id = PLANILHAS[b.base === 'oficial' ? 'oficial' : 'teste'];
    const ctx = { email: u.user.email ?? '', admin: eq?.papel === 'admin', admin_sb: sb };
    const args = Array.isArray(b.args) ? b.args : [];
    const r = await FUNCOES[fn](new Planilha(id), ctx, ...args);
    return json({ ok: true, r });
  } catch (e) {
    if (e instanceof ErroUsuario) return json({ ok: false, erro: e.message }, 400);
    console.error(e);
    return json({ ok: false, erro: 'Erro inesperado ao falar com a planilha. Tente de novo.' }, 500);
  }
});
