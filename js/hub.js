// Central Sandstride: login único e as telas da Central (Meu dia, Placar, Prioridades, Revisão semanal).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { montarShell } from './shell.js';
import { montarMeuDia } from './meudia.js';
import { montarPlacar, montarPrioridades, montarRevisao, ICONES_CENTRAL } from './gestao.js';
import { montarCaixaIdeias } from './ideias.js';

const sb = window.SB = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const IC = {
  alerta: '<path d="M12 4 2.500 20h19zM12 10v4M12 17h.01"/>',
  check: '<path d="M5 12.500 10 17 19 7"/>',
};
const svg = (d, t = 18) => `<svg class="i" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const logo = () => '<img class="logo-a" src="img/sandstride-escuro.png" alt="Sandstride"><img class="logo-b" src="img/sandstride.png" alt="">';
const msgIcone = (tipo) => svg(tipo === 'ok' ? IC.check : IC.alerta);
let user = null, eu = null;
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
// A Central tem quatro telas, trocadas pelo endereço (#placar, #prioridades, #revisao)
const TELAS = { '': montarMeuDia, '#placar': montarPlacar, '#prioridades': montarPrioridades, '#revisao': montarRevisao };
let shellPronto = false;
async function tela() {
  const monta = TELAS[location.hash] || montarMeuDia;
  $('raiz').innerHTML = '<main class="wrap"><div class="md"></div></main>';
  const el = $('raiz').querySelector('.md');
  const p = monta({ sb, user, eu, el, caixa: montarCaixaIdeias });
  if (!shellPronto) {
    shellPronto = true;
    const vai = (h) => () => { if (location.hash === h || (!h && !location.hash)) return; location.hash = h; };
    const em = (h) => () => (TELAS[location.hash] ? location.hash : '') === h;
    await montarShell({ ativo: 'central', raiz: './', subs: [
      { rotulo: 'Meu dia', d: ICONES_CENTRAL.dia, ao: vai(''), ativo: em('') },
      { rotulo: 'Placar', d: ICONES_CENTRAL.placar, ao: vai('#placar'), ativo: em('#placar') },
      { rotulo: 'Prioridades', d: ICONES_CENTRAL.prioridades, ao: vai('#prioridades'), ativo: em('#prioridades') },
      { rotulo: 'Revisão semanal', d: ICONES_CENTRAL.revisao, ao: vai('#revisao'), ativo: em('#revisao') },
    ] });
    window.addEventListener('hashchange', () => { if (user && eu && !/type=(invite|recovery)/.test(location.hash)) tela(); });
  }
  await p;
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
    if (proximo && /^\/[a-z0-9\-/]*(\?c=[0-9a-f-]{36})?$/i.test(proximo) && !proximo.startsWith('//')) { location.replace(proximo); return; }
    await tela();
  } catch (err) { console.error(err); $('raiz').innerHTML = '<p class="muted" style="text-align:center;margin-top:30vh">Não foi possível carregar. Atualize a página.</p>'; }
  iniciando = false;
}
const veioConvite = /type=(invite|recovery)/.test(location.hash);
(async () => { const { data } = await sb.auth.getSession(); if (data?.session && veioConvite) telaNovaSenha(); else iniciar(); })();
