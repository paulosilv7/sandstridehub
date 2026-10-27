// Central Sandstride: login único e lista das ferramentas liberadas para cada pessoa.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const APPS = [
  { id: 'chat', nome: 'Caixa de entrada', desc: 'Conversas e perguntas de todos os marketplaces.', href: 'chat/',
    icone: '<path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z M3 13h5.5l1 2.5h5l1-2.5H21"/>' },
  { id: 'precificacao', nome: 'Precificação', desc: 'Preços, margens e reajustes por marketplace.', href: 'precificacao/',
    icone: '<path d="M12 3v18M16 7.5c-.7-1.3-2.2-2-4-2-2.4 0-4 1.2-4 3 0 4.2 8.400 2.200 8.400 6.400 0 1.800-1.800 3.100-4.400 3.100-1.900 0-3.400-.8-4.200-2.200"/>' },
  { id: 'estoque', nome: 'Estoque do galpão', desc: 'Estoque com grade de cor e tamanho.', href: 'estoque/',
    icone: '<path d="M3 8 12 3l9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8"/>' },
];
let user = null, eu = null, acessos = new Set();
const proximo = new URLSearchParams(location.search).get('next');

function telaLogin(msg = '', tipo = 'erro', modo = 'entrar') {
  const rec = modo === 'recuperar';
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="f" novalidate><img src="img/sandstride.png" alt="Sandstride"><div style="text-align:center"><h2>Central Sandstride</h2><p class="sub" style="margin:4px 0 0">${rec ? 'Informe seu e-mail para receber o link de nova senha.' : 'Entre com o e-mail e a senha da equipe.'}</p></div>` +
    (msg ? `<p class="${tipo}" role="alert">${esc(msg)}</p>` : '') +
    '<label class="campo"><span class="eyebrow">E-mail</span><input id="e" type="email" autocomplete="username" required></label>' +
    (rec ? '' : '<label class="campo"><span class="eyebrow">Senha</span><input id="s" type="password" autocomplete="current-password" required></label>') +
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
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="f" novalidate><img src="img/sandstride.png" alt="Sandstride"><h2 style="text-align:center">Crie sua senha</h2><p class="sub" style="margin:0;text-align:center">Pelo menos 8 caracteres.</p>` +
    (msg ? `<p class="erro" role="alert">${esc(msg)}</p>` : '') +
    '<label class="campo"><span class="eyebrow">Nova senha</span><input id="a" type="password" autocomplete="new-password"></label><label class="campo"><span class="eyebrow">Repita a senha</span><input id="b" type="password" autocomplete="new-password"></label><button class="btn dark" type="submit">Salvar e entrar</button></form></div>';
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
function topo() {
  return `<header class="top"><img src="img/sandstride.png" alt="Sandstride"><span class="sp"></span>` +
    `<label class="meu-av" title="Trocar minha foto" for="foto">${avatar(eu.foto_path, eu.nome, 'g')}<span class="cam" aria-hidden="true">+</span></label><input id="foto" class="sr" type="file" accept="image/*">` +
    `<span class="eu">${esc(eu.nome)} · ${eu.papel === 'admin' ? 'Administrador' : 'Atendente'}</span><button class="btn ghost" id="sair" type="button">Sair</button></header>`;
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
  const label = document.querySelector('.meu-av');
  try {
    if (!file.type.startsWith('image/')) throw new Error('tipo');
    label.classList.add('envia');
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
    label.classList.remove('envia');
    label.title = 'Não consegui enviar a foto. Use uma imagem JPG, PNG ou WEBP.';
    label.classList.add('erro-foto');
  }
}
const podeAbrir = (id) => eu.papel === 'admin' || acessos.has(id);

async function tela() {
  const tiles = APPS.filter((a) => podeAbrir(a.id)).map((a) => {
    const ic = `<span class="ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a.icone}</svg></span>`;
    if (a.breve) return `<div class="tile off">${ic}<h2>${a.nome}</h2><p class="sub" style="margin:0">${a.desc}</p><span class="tag">Em breve</span></div>`;
    return `<a class="tile" href="${a.href}"${a.externo ? ' rel="noopener"' : ''}>${ic}<h2>${a.nome}</h2><p class="sub" style="margin:0">${a.desc}</p></a>`;
  }).join('');
  let h = `<div class="wrap">${topo()}<div><h1>Olá, ${esc(eu.nome.split(' ')[0])}.</h1><p class="sub" style="margin:4px 0 0">Escolha uma ferramenta.</p></div>` +
    (tiles ? `<div class="tiles">${tiles}</div>` : '<div class="card"><p class="muted" style="margin:0">Você ainda não tem acesso a nenhuma ferramenta. Peça a um administrador para liberar.</p></div>');
  if (eu.papel === 'admin') h += '<section class="card" id="acessos" aria-label="Acessos da equipe"><h2>Quem acessa o quê</h2><p class="sub" style="margin:0">Marque as ferramentas que cada pessoa pode abrir. Administradores acessam tudo.</p><div id="tab" class="tbl"><p class="muted">Carregando…</p></div></section>';
  $('raiz').innerHTML = h + '</div>';
  $('sair').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  $('foto').onchange = (ev) => { const f = ev.target.files[0]; if (f) trocarFoto(f); };
  if (eu.papel === 'admin') tabelaAcessos();
}
async function tabelaAcessos() {
  const [{ data: eq }, { data: ac }] = await Promise.all([
    sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome'), sb.from('acessos_apps').select('usuario_id, app')]);
  const tem = new Set((ac || []).map((x) => `${x.usuario_id}|${x.app}`));
  $('tab').innerHTML = `<table><thead><tr><th>Pessoa</th>${APPS.map((a) => `<th class="c">${a.nome}</th>`).join('')}</tr></thead><tbody>` +
    (eq || []).map((p) => `<tr><td><div style="display:flex;align-items:center;gap:10px">${avatar(p.foto_path, p.nome)}<div><b>${esc(p.nome)}</b><br><span class="sub">${p.papel === 'admin' ? 'Administrador' : 'Atendente'}</span></div></div></td>` +
      APPS.map((a) => p.papel === 'admin' ? '<td class="c sub">Tudo</td>' :
        `<td class="c"><input type="checkbox" data-u="${p.usuario_id}" data-a="${a.id}" aria-label="${esc(p.nome)}: ${a.nome}"${tem.has(`${p.usuario_id}|${a.id}`) ? ' checked' : ''}></td>`).join('') + '</tr>').join('') + '</tbody></table>';
  $('tab').onchange = async (ev) => {
    const c = ev.target; if (!c.dataset.u) return;
    const q = c.checked ? sb.from('acessos_apps').insert({ usuario_id: c.dataset.u, app: c.dataset.a })
      : sb.from('acessos_apps').delete().eq('usuario_id', c.dataset.u).eq('app', c.dataset.a);
    const { error } = await q;
    if (error) { c.checked = !c.checked; c.title = 'Não foi possível salvar.'; }
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
    if (proximo && /^\/[a-z0-9\-/]*$/i.test(proximo) && !proximo.startsWith('//')) { location.replace(proximo); return; }
    await tela();
  } catch (err) { console.error(err); $('raiz').innerHTML = '<p class="muted" style="text-align:center;margin-top:30vh">Não foi possível carregar. Atualize a página.</p>'; }
  iniciando = false;
}
const veioConvite = /type=(invite|recovery)/.test(location.hash);
(async () => { const { data } = await sb.auth.getSession(); if (data?.session && veioConvite) telaNovaSenha(); else iniciar(); })();
