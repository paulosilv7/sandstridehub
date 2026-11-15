// Central Sandstride: login único e lista das ferramentas liberadas para cada pessoa.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const APPS = [
  { id: 'chat', nome: 'Chats', desc: 'Conversas e perguntas de todos os marketplaces.', href: 'chat/',
    icone: '<path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z M3 13h5.5l1 2.5h5l1-2.5H21"/>' },
  { id: 'precificacao', nome: 'Precificação', desc: 'Preços, margens e reajustes por marketplace.', href: 'precificacao/',
    icone: '<path d="M12 3v18M16 7.5c-.7-1.3-2.2-2-4-2-2.4 0-4 1.2-4 3 0 4.2 8.400 2.200 8.400 6.400 0 1.800-1.800 3.100-4.400 3.100-1.900 0-3.400-.8-4.200-2.200"/>' },
  { id: 'estoque', nome: 'Estoque', desc: 'Estoque com grade de cor e tamanho.', href: 'estoque/',
    icone: '<path d="M3 8 12 3l9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8"/>' },
  { id: 'lucro', nome: 'Lucro ao vivo', desc: 'Lucro das vendas em tempo real, por loja e marketplace.', href: 'lucro/',
    icone: '<path d="M3 17l5-5 4 4 8-9M15 7h5v5"/>' },
  { id: 'devolucoes', nome: 'Devoluções', desc: 'Reclamações, devoluções e contestações de todos os marketplaces, com a Sandy.', href: 'devolucoes/',
    icone: '<path d="M12 3 4 6v5c0 5 3.400 8.500 8 10 4.600-1.500 8-5 8-10V6l-8-3Zm-3 9 2.500 2.500L15.500 9.500"/>' },
  { id: 'fornecedores', nome: 'Fornecedores', desc: 'Compras, pagamentos e saldo devedor por fornecedor.', href: 'fornecedores/',
    usuarios: ['ebccd17d-16d7-46cc-82cd-1622c3fd254d', '0cd665bf-e4fb-4087-91a7-e5312cbafe6a'],
    icone: '<path d="M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16M2 21h20M8 7h5M8 11h5M8 15h2m7-5h3v11M8 21v-3h5v3"/>' },
  { id: 'financeiro', nome: 'Financeiro', desc: 'Recebimentos dos marketplaces, despesas, contas fixas e resultado do mês.', href: 'financeiro/',
    usuarios: ['ebccd17d-16d7-46cc-82cd-1622c3fd254d', '0cd665bf-e4fb-4087-91a7-e5312cbafe6a'],
    icone: '<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3M3 7a2 2 0 0 0 2 2h14a1 1 0 0 1 1 1v3m0 3h-4a1.500 1.500 0 0 1 0-3h4v3Z"/>' },
  { id: 'ads', nome: 'Gestor de Ads', desc: 'Gastos e resultados dos anúncios pagos em cada marketplace.', breve: true,
    icone: '<path d="M4 20V10m6 10V4m6 16v-7m5 7H3"/>' },
];
const GRUPOS = [['Vender', ['lucro', 'precificacao', 'ads']], ['Atender', ['chat', 'devolucoes']], ['Operar', ['estoque', 'financeiro', 'fornecedores']]];
const FAVORITOS = ['lucro', 'chat', 'devolucoes', 'financeiro'];
const IC = {
  casa: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  lua: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.500z"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  lado: '<path d="M4 4h16v16H4zM9 4v16"/>',
  seta: '<path d="M7 17 17 7M8 7h9v9"/>',
  relogio: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',
  alerta: '<path d="M12 4 2.500 20h19zM12 10v4M12 17h.01"/>',
  check: '<path d="M5 12.500 10 17 19 7"/>',
  usuarios: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.900M16 3.100a4 4 0 0 1 0 7.800"/>'
};
const svg = (d, t = 18) => `<svg class="i" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const logo = () => '<img class="logo-a" src="img/sandstride-escuro.png" alt="Sandstride"><img class="logo-b" src="img/sandstride.png" alt="">';
const msgIcone = (tipo) => svg(tipo === 'ok' ? IC.check : IC.alerta);
let user = null, eu = null, acessos = new Set();
const proximo = new URLSearchParams(location.search).get('next');

function telaLogin(msg = '', tipo = 'erro', modo = 'entrar') {
  const rec = modo === 'recuperar';
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="f" novalidate>${logo()}<div class="titulo"><h2>Central Sandstride</h2><p class="sub">${rec ? 'Informe seu e-mail para receber o link de nova senha.' : 'Entre com o e-mail e a senha da equipe.'}</p></div>` +
    (msg ? `<p class="${tipo}" role="alert">${msgIcone(tipo)}<span>${esc(msg)}</span></p>` : '') +
    '<label class="campo"><span class="rot">E-mail</span><input id="e" type="email" autocomplete="username" required></label>' +
    (rec ? '' : '<label class="campo"><span class="rot">Senha</span><input id="s" type="password" autocomplete="current-password" required></label>') +
    `<button class="btn dark" type="submit">${rec ? 'Enviar link' : 'Entrar'}</button><button type="button" class="link" id="troca">${rec ? 'Voltar para o login' : 'Esqueci a senha'}</button></form></div>`;
  $('troca').onclick = () => telaLogin('', 'erro', rec ? 'entrar' : 'recuperar');
  $('f').onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $('e').value.trim();
    if (!email) return telaLogin('Informe o e-mail.', 'erro', modo);
    if (rec) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
      return telaLogin(error ? 'Não consegui enviar o link. Tente de novo em instantes.' : 'Se esse e-mail estiver cadastrado, o link chega em alguns minutos.', error ? 'erro' : 'ok', modo);
    }
    const { error } = await sb.auth.signInWithPassword({ email, password: $('s').value });
    if (error) return telaLogin('E-mail ou senha incorretos.', 'erro', modo);
    iniciar();
  };
}
function telaNovaSenha(msg = '') {
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="f" novalidate>${logo()}<div class="titulo"><h2>Crie sua senha</h2><p class="sub">Pelo menos 8 caracteres.</p></div>` +
    (msg ? `<p class="erro" role="alert">${msgIcone('erro')}<span>${esc(msg)}</span></p>` : '') +
    '<label class="campo"><span class="rot">Nova senha</span><input id="a" type="password" autocomplete="new-password"></label><label class="campo"><span class="rot">Repita a senha</span><input id="b" type="password" autocomplete="new-password"></label><button class="btn dark" type="submit">Salvar e entrar</button></form></div>';
  $('f').onsubmit = async (ev) => {
    ev.preventDefault();
    const a = $('a').value;
    if (a.length < 8) return telaNovaSenha('A senha precisa ter pelo menos 8 caracteres.');
    if (a !== $('b').value) return telaNovaSenha('As senhas não são iguais.');
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return telaNovaSenha('Não consegui salvar a senha. Tente de novo.');
    history.replaceState(null, '', location.pathname);
    iniciar();
  };
}
const fotoUrl = (p) => p ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${p}` : '';
function avatar(p, nome, cls = '') {
  const u = fotoUrl(p);
  return u ? `<img class="av ${cls}" src="${esc(u)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(String(nome || '?').charAt(0).toUpperCase())}</span>`;
}
function reduzir(file) {
  return new Promise((ok, falha) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : falha(new Error('imagem'))), 'image/jpeg', 0.86);
    };
    img.onerror = () => falha(new Error('imagem'));
    img.src = url;
  });
}
async function trocarFoto(file) {
  const labels = [...document.querySelectorAll('.meu-av')];
  const marca = (fn) => labels.forEach(fn);
  try {
    if (!file.type.startsWith('image/')) throw new Error('tipo');
    marca((l) => l.classList.add('envia'));
    const blob = await reduzir(file);
    const path = `${user.id}/${Date.now()}.jpg`;
    const { error } = await sb.storage.from('avatares').upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    const { error: e2 } = await sb.rpc('definir_minha_foto', { p_path: path });
    if (e2) throw e2;
    if (eu.foto_path) await sb.storage.from('avatares').remove([eu.foto_path]);
    eu.foto_path = path;
    await tela();
  } catch (e) {
    console.error(e);
    marca((l) => { l.classList.remove('envia'); l.title = 'Não consegui enviar a foto. Use uma imagem JPG, PNG ou WEBP.'; l.classList.add('erro-foto'); });
  }
}
const podeAbrir = (id) => {
  const app = APPS.find((a) => a.id === id);
  if (app?.usuarios) return app.usuarios.includes(user.id);
  return eu.papel === 'admin' || acessos.has(id);
};
const visiveis = () => APPS.filter((a) => a.breve || podeAbrir(a.id));
const porId = (id) => APPS.find((a) => a.id === id);

// Tema claro e escuro (preferência guardada neste navegador)
const TEMA_CH = 'sandstride-tema', MENU_CH = 'sandstride-menu';
let marcaTema = null;
function temaAtual() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function pintaTema(t) {
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === 'dark' ? '#0A0A0A' : '#EDEDEC';
  document.querySelectorAll('#temaIc,#temaM').forEach((b) => { b.innerHTML = svg(t === 'dark' ? IC.sol : IC.lua); });
  if (marcaTema) marcaTema(t);
}
function poeTema(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(TEMA_CH, t); } catch (e) { /* sem armazenamento: vale só nesta visita */ }
  pintaTema(t);
}
// Seletor em pílula: o segmento ativo desliza (200 ms)
function seg(el, valor, ao) {
  const bs = [...el.querySelectorAll('button')], p = el.querySelector('.polegar');
  const marca = (v, chama) => {
    bs.forEach((b) => {
      const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      if (on && b.offsetWidth) { p.style.width = b.offsetWidth + 'px'; p.style.transform = `translateX(${b.offsetLeft}px)`; }
    });
    if (chama && ao) ao(v);
  };
  bs.forEach((b) => b.addEventListener('click', () => marca(b.dataset.v, true)));
  marca(valor, false);
  return (v) => marca(v, false);
}
function recolher(rec) {
  $('app').classList.toggle('rec', rec);
  try { localStorage.setItem(MENU_CH, rec ? '1' : '0'); } catch (e) { /* idem */ }
  $('recolhe').setAttribute('aria-label', rec ? 'Expandir menu' : 'Recolher menu');
  setTimeout(() => marcaTema && marcaTema(temaAtual()), 300);
}

function itemMenu(a) {
  const ic = svg(a.icone);
  if (a.breve) return `<span class="nv off" title="${esc(a.nome)}: em breve">${ic}<span>${esc(a.nome)}</span><span class="tag ex">Em breve</span></span>`;
  return `<a class="nv" href="${a.href}" title="${esc(a.nome)}"${a.externo ? ' rel="noopener"' : ''}>${ic}<span>${esc(a.nome)}</span></a>`;
}
function lateral() {
  const grupos = GRUPOS.map(([nome, ids]) => {
    const itens = ids.map(porId).filter((a) => a && (a.breve || podeAbrir(a.id)));
    return itens.length ? `<div class="gl">${nome}</div>${itens.map(itemMenu).join('')}` : '';
  }).join('');
  const papel = eu.papel === 'admin' ? 'Administrador' : 'Atendente';
  return `<aside class="lat" aria-label="Menu"><div class="lat-marca"><img src="img/sandstride.png" alt="Sandstride"><span class="mk" aria-hidden="true">S</span></div>` +
    `<nav aria-label="Ferramentas"><a class="nv" href="./" aria-current="page">${svg(IC.casa)}<span>Central</span></a>${grupos}</nav>` +
    `<div class="pe"><div class="eu-bloco"><label class="meu-av" title="Trocar minha foto" for="foto">${avatar(eu.foto_path, eu.nome, 'g')}<span class="cam" aria-hidden="true">+</span></label><div class="eu-txt"><b>${esc(eu.nome)}</b><span>${papel}</span></div></div>` +
    '<div class="seg" id="tema" role="group" aria-label="Tema"><span class="polegar"></span><button type="button" data-v="light">Claro</button><button type="button" data-v="dark">Escuro</button></div>' +
    `<button class="ibtn tema-ic" id="temaIc" type="button" aria-label="Trocar tema claro ou escuro">${svg(IC.lua)}</button>` +
    `<button class="nv" data-sair type="button">${svg(IC.sair)}<span>Sair</span></button>` +
    `<button class="nv" id="recolhe" type="button" aria-label="Recolher menu">${svg(IC.lado)}<span>Recolher menu</span></button></div></aside>`;
}
function topoM() {
  return `<header class="topo-m">${logo()}<span class="sp"></span><button class="ibtn" id="temaM" type="button" aria-label="Trocar tema claro ou escuro">${svg(IC.lua)}</button>` +
    `<button class="ibtn" data-sair type="button" aria-label="Sair">${svg(IC.sair)}</button>` +
    `<label class="meu-av" title="Trocar minha foto" for="foto">${avatar(eu.foto_path, eu.nome, 'g')}<span class="cam" aria-hidden="true">+</span></label></header>`;
}
function barraM() {
  const fav = FAVORITOS.filter((id) => podeAbrir(id)).slice(0, 3).map(porId);
  return `<nav class="barra-m" aria-label="Atalhos"><div class="barra"><a href="./" aria-current="page" aria-label="Central">${svg(IC.casa)}<span>Central</span></a>` +
    fav.map((a) => `<a href="${a.href}" aria-label="${esc(a.nome)}">${svg(a.icone)}<span>${esc(a.nome)}</span></a>`).join('') + '</div></nav>';
}

async function tela() {
  const itens = new Map(visiveis().map((a) => [a.id, a]));
  let n = 1;
  const grupos = GRUPOS.map(([nome, ids]) => {
    const lista = ids.map((id) => itens.get(id)).filter(Boolean);
    if (!lista.length) return '';
    const tiles = lista.map((a) => {
      const ic = `<span class="ico">${svg(a.icone, 20)}</span>`, o = `style="--o:${n++}"`;
      if (a.breve) return `<div class="tile off entra" ${o}><div class="topo">${ic}</div><h3>${esc(a.nome)}</h3><p>${esc(a.desc)}</p><span class="tag ex">${svg(IC.relogio)}Em breve</span></div>`;
      return `<a class="tile entra" ${o} href="${a.href}"${a.externo ? ' rel="noopener"' : ''}><div class="topo">${ic}<span class="ir">${svg(IC.seta)}</span></div><h3>${esc(a.nome)}</h3><p>${esc(a.desc)}</p></a>`;
    }).join('');
    return `<section class="grupo" aria-label="${nome}"><h2 class="gt">${nome}</h2><div class="tiles">${tiles}</div></section>`;
  }).join('');
  let h = `<div class="pg-cab entra" style="--o:0"><h1>Olá, ${esc(eu.nome.split(' ')[0])}.</h1><p class="sub">Escolha uma ferramenta.</p></div>` +
    (grupos || '<div class="card"><p class="sub">Você ainda não tem acesso a nenhuma ferramenta. Peça a um administrador para liberar.</p></div>');
  h += `<section class="card entra" style="--o:${n++}" id="coruja" aria-label="Modo Corujão"><div class="qcab"><span class="ico">${svg(IC.lua)}</span><h2>Modo Corujão</h2></div><p class="corpo">Das 00h às 06h as atualizações automáticas rodam de hora em hora. Ligue para manter o ritmo normal; ele desliga sozinho às 6h.</p><div id="coruja-st" class="corujao-st"><span class="sub">Carregando…</span></div></section>`;
  if (eu.papel === 'admin') h += `<section class="card entra" style="--o:${n++}" id="acessos" aria-label="Acessos da equipe"><div class="qcab"><span class="ico">${svg(IC.usuarios)}</span><h2>Quem acessa o quê</h2></div><p class="corpo">Marque as ferramentas que cada pessoa pode abrir. Administradores acessam tudo.</p><div id="tab" class="tbl"><p class="sub">Carregando…</p></div></section>`;
  let rec = false; try { rec = localStorage.getItem(MENU_CH) === '1'; } catch (e) { /* idem */ }
  $('raiz').innerHTML = `<div class="app${rec ? ' rec' : ''}" id="app">${lateral()}<div class="col">${topoM()}<main class="wrap">${h}</main></div>${barraM()}<input id="foto" class="sr" type="file" accept="image/*"></div>`;
  document.querySelectorAll('[data-sair]').forEach((b) => { b.onclick = async () => { await sb.auth.signOut(); location.reload(); }; });
  $('foto').onchange = (ev) => { const f = ev.target.files[0]; if (f) trocarFoto(f); };
  marcaTema = seg($('tema'), temaAtual(), poeTema);
  pintaTema(temaAtual());
  const alterna = () => poeTema(temaAtual() === 'dark' ? 'light' : 'dark');
  $('temaIc').onclick = alterna; $('temaM').onclick = alterna;
  $('recolhe').onclick = () => recolher(!$('app').classList.contains('rec'));
  if (document.fonts?.ready) document.fonts.ready.then(() => marcaTema && marcaTema(temaAtual()));
  carregarCoruja();
  if (eu.papel === 'admin') tabelaAcessos();
}
window.addEventListener('resize', () => marcaTema && marcaTema(temaAtual()));
const fHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
function desenharCoruja(st, erro = '') {
  const el = $('coruja-st'); if (!el) return;
  if (!st) { el.innerHTML = '<span class="sub">Não foi possível carregar o estado do modo.</span>'; return; }
  el.innerHTML = (st.ativo
    ? `<span class="tag ate">${svg(IC.lua)}Ligado até as ${fHora.format(new Date(st.ate))}</span><button class="btn sec" id="coruja-bt" type="button">Desligar</button>`
    : `<span class="tag">${svg(IC.relogio)}Desligado</span><button class="btn pri" id="coruja-bt" type="button">Ligar até as 6h</button>`) +
    (erro ? `<span class="erro">${svg(IC.alerta)}<span>${esc(erro)}</span></span>` : '');
  $('coruja-bt').onclick = async () => {
    $('coruja-bt').disabled = true;
    const { data, error } = await sb.rpc('corujao_definir', { p_ativar: !st.ativo });
    if (error) return desenharCoruja(st, 'Não consegui mudar o modo. Tente de novo.');
    desenharCoruja(data);
  };
}
async function carregarCoruja() {
  const { data, error } = await sb.rpc('corujao_obter');
  desenharCoruja(error ? null : data);
}
async function tabelaAcessos() {
  const [{ data: eq }, { data: ac }] = await Promise.all([
    sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome'), sb.from('acessos_apps').select('usuario_id, app')]);
  const tem = new Set((ac || []).map((x) => `${x.usuario_id}|${x.app}`));
  const cols = APPS.filter((a) => !a.breve);
  $('tab').innerHTML = `<table><thead><tr><th>Pessoa</th>${cols.map((a) => `<th class="c">${esc(a.nome)}</th>`).join('')}</tr></thead><tbody>` +
    (eq || []).map((p) => `<tr><td><div class="pessoa">${avatar(p.foto_path, p.nome)}<div><b>${esc(p.nome)}</b><br><span class="sub">${p.papel === 'admin' ? 'Administrador' : 'Atendente'}</span></div></div></td>` +
      cols.map((a) => a.usuarios ? `<td class="c"><span class="tag">${a.usuarios.includes(p.usuario_id) ? 'Administrador' : 'Restrito'}</span></td>` : p.papel === 'admin' ? '<td class="c"><span class="tag">Tudo</span></td>' :
        `<td class="c"><input type="checkbox" data-u="${p.usuario_id}" data-a="${a.id}" aria-label="${esc(p.nome)}: ${esc(a.nome)}"${tem.has(`${p.usuario_id}|${a.id}`) ? ' checked' : ''}></td>`).join('') + '</tr>').join('') + '</tbody></table><p id="msg-acessos" class="sub" style="margin:12px 0 0" aria-live="polite"></p>';
  $('tab').onchange = async (ev) => {
    const c = ev.target; if (!c.dataset.u) return;
    const q = c.checked ? sb.from('acessos_apps').insert({ usuario_id: c.dataset.u, app: c.dataset.a })
      : sb.from('acessos_apps').delete().eq('usuario_id', c.dataset.u).eq('app', c.dataset.a);
    const { error } = await q;
    const msg = $('msg-acessos');
    if (error) { c.checked = !c.checked; c.title = 'Não foi possível salvar.'; if (msg) msg.textContent = 'Não foi possível salvar este acesso. Atualize a página e tente de novo; se continuar, avise o suporte.'; }
    else if (msg) msg.textContent = c.checked ? 'Acesso liberado.' : 'Acesso retirado.';
  };
}
let iniciando = false;
async function iniciar() {
  if (iniciando) return; iniciando = true;
  try {
    const { data } = await sb.auth.getSession();
    user = data?.session?.user;
    if (!user) { iniciando = false; return telaLogin(); }
    const { data: e } = await sb.from('equipe').select('usuario_id, nome, papel, foto_path').eq('usuario_id', user.id).maybeSingle();
    if (!e) { await sb.auth.signOut(); iniciando = false; return telaLogin('Seu acesso ainda não foi liberado. Peça a um administrador.'); }
    eu = e;
    const { data: ac } = await sb.from('acessos_apps').select('app').eq('usuario_id', user.id);
    acessos = new Set((ac || []).map((x) => x.app));
    if (proximo && /^\/[a-z0-9\-/]*(\?c=[0-9a-f-]{36})?$/i.test(proximo) && !proximo.startsWith('//')) { location.replace(proximo); return; }
    await tela();
  } catch (err) { console.error(err); $('raiz').innerHTML = '<p class="muted" style="text-align:center;margin-top:30vh">Não foi possível carregar. Atualize a página.</p>'; }
  iniciando = false;
}
const veioConvite = /type=(invite|recovery)/.test(location.hash);
(async () => { const { data } = await sb.auth.getSession(); if (data?.session && veioConvite) telaNovaSenha(); else iniciar(); })();
