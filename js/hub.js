// Central Sandstride: login único e lista das ferramentas liberadas para cada pessoa.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { montarShell } from './shell.js';
import { montarMeuDia } from './meudia.js';

const sb = window.SB = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
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
const podeAbrir = (id) => {
  const app = APPS.find((a) => a.id === id);
  if (app?.usuarios) return app.usuarios.includes(user.id);
  return eu.papel === 'admin' || acessos.has(id);
};
const visiveis = () => APPS.filter((a) => a.breve || podeAbrir(a.id));
const porId = (id) => APPS.find((a) => a.id === id);

async function tela() {
  // ferramentas em fileira compacta (o menu lateral já leva a tudo)
  const atalhos = GRUPOS.flatMap(([, ids]) => ids).map(porId).filter((a) => a && (a.breve || podeAbrir(a.id))).map((a) => (a.breve
    ? `<span class="atalho off" title="${esc(a.nome)}: em breve">${svg(a.icone)}<span>${esc(a.nome)}</span><span class="tag ex">Em breve</span></span>`
    : `<a class="atalho" href="${a.href}">${svg(a.icone)}<span>${esc(a.nome)}</span></a>`)).join('');
  $('raiz').innerHTML = `<main class="wrap"><div id="meudia" class="md"></div><section class="grupo entra" style="--o:5" aria-label="Ferramentas"><h2 class="gt">Ferramentas</h2>` +
    (atalhos ? `<div class="atalhos">${atalhos}</div>` : '<div class="card"><p class="sub">Você ainda não tem acesso a nenhuma ferramenta. Peça a um administrador para liberar.</p></div>') + '</section></main>';
  await Promise.all([montarMeuDia({ sb, user, eu, el: $('meudia') }), montarShell({ ativo: 'central', raiz: './' })]);
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
