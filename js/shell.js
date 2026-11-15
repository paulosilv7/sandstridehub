// Menu lateral compartilhado do sistema Sandstride (briefing de design v2).
// Uso numa ferramenta: import { montarShell } from '../js/shell.js'; montarShell({ ativo: 'lucro', raiz: '../', subs: [...] });
// Ele envolve o conteúdo que já está no <body> (não recria a tela) e desenha o menu lateral (celular: topo + pílula).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { S, ajustar, passo, limitar, depois, parada, registrar, acordar, pilula } from './molas.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (d) => `<svg class="sh-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ADMINS_FINANCEIRO = ['ebccd17d-16d7-46cc-82cd-1622c3fd254d', '0cd665bf-e4fb-4087-91a7-e5312cbafe6a'];
const APPS = [
  { id: 'chat', nome: 'Chats', href: 'chat/', d: '<path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z M3 13h5.5l1 2.5h5l1-2.5H21"/>' },
  { id: 'precificacao', nome: 'Precificação', href: 'precificacao/', d: '<path d="M12 3v18M16 7.5c-.7-1.3-2.2-2-4-2-2.4 0-4 1.2-4 3 0 4.2 8.4 2.2 8.4 6.4 0 1.8-1.8 3.1-4.4 3.1-1.9 0-3.4-.8-4.2-2.2"/>' },
  { id: 'estoque', nome: 'Estoque', href: 'estoque/', d: '<path d="M3 8 12 3l9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8"/>' },
  { id: 'lucro', nome: 'Lucro ao vivo', href: 'lucro/', d: '<path d="M3 17l5-5 4 4 8-9M15 7h5v5"/>' },
  { id: 'devolucoes', nome: 'Devoluções', href: 'devolucoes/', d: '<path d="M12 3 4 6v5c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-3Zm-3 9 2.5 2.5L15.5 9.5"/>' },
  { id: 'fornecedores', nome: 'Fornecedores', href: 'fornecedores/', usuarios: ADMINS_FINANCEIRO, d: '<path d="M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16M2 21h20M8 7h5M8 11h5M8 15h2m7-5h3v11M8 21v-3h5v3"/>' },
  { id: 'financeiro', nome: 'Financeiro', href: 'financeiro/', usuarios: ADMINS_FINANCEIRO, d: '<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3M3 7a2 2 0 0 0 2 2h14a1 1 0 0 1 1 1v3m0 3h-4a1.5 1.5 0 0 1 0-3h4v3Z"/>' },
  { id: 'ads', nome: 'Gestor de Ads', breve: true, d: '<path d="M4 20V10m6 10V4m6 16v-7m5 7H3"/>' },
];
const GRUPOS = [['Vender', ['lucro', 'precificacao', 'ads']], ['Atender', ['chat', 'devolucoes']], ['Operar', ['estoque', 'financeiro', 'fornecedores']]];
const IC = {
  casa: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  lua: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  lado: '<path d="M4 4h16v16H4zM9 4v16"/>',
};
const TEMA_CH = 'sandstride-tema', MENU_CH = 'sandstride-menu';

function temaAtual() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export async function montarShell({ ativo, raiz = '../', subs = [] } = {}) {
  if (!document.documentElement.getAttribute('data-theme')) document.documentElement.setAttribute('data-theme', temaAtual());
  const sb = window.SB || createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: s } = await sb.auth.getSession();
  const user = s?.session?.user;
  if (!user) return; // sem sessão a própria ferramenta cuida do login
  const [{ data: eu }, { data: ac }] = await Promise.all([
    sb.from('equipe').select('nome, papel, foto_path').eq('usuario_id', user.id).maybeSingle(),
    sb.from('acessos_apps').select('app').eq('usuario_id', user.id),
  ]);
  if (!eu) return;
  const acessos = new Set((ac || []).map((x) => x.app));
  const pode = (a) => (a.usuarios ? a.usuarios.includes(user.id) : eu.papel === 'admin' || acessos.has(a.id));
  const url = (p) => (raiz + p);
  const foto = eu.foto_path ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${eu.foto_path}` : '';
  const av = foto ? `<img class="sh-av" src="${esc(foto)}" alt="">` : `<span class="sh-av" aria-hidden="true">${esc(String(eu.nome || '?').charAt(0).toUpperCase())}</span>`;

  const subHtml = subs.map((x, i) => `<button type="button" class="sh-nv sh-sub" data-sub="${i}" title="${esc(x.rotulo)}">${ic(x.d)}<span>${esc(x.rotulo)}</span><b class="sh-selo" hidden></b></button>`).join('');
  const itens = (ids) => ids.map((id) => APPS.find((a) => a.id === id)).filter((a) => a && (a.breve || pode(a))).map((a) => {
    if (a.breve) return `<span class="sh-nv sh-off" title="${esc(a.nome)}: em breve">${ic(a.d)}<span>${esc(a.nome)}</span><span class="sh-em-breve">Em breve</span></span>`;
    const cur = a.id === ativo;
    return `<a class="sh-nv" href="${url(a.href)}"${cur && !subs.length ? ' aria-current="page"' : ''}${cur && subs.length ? ' data-pai="1"' : ''} title="${esc(a.nome)}">${ic(a.d)}<span>${esc(a.nome)}</span></a>${cur ? subHtml : ''}`;
  }).join('');
  const grupos = GRUPOS.map(([nome, ids]) => { const h = itens(ids); return h ? `<div class="sh-gl">${nome}</div>${h}` : ''; }).join('');
  const papel = eu.papel === 'admin' ? 'Administrador' : 'Atendente';

  const lat = `<aside class="sh-lat" aria-label="Menu"><div class="sh-marca"><img src="${url('img/sandstride.png')}" alt="Sandstride"><span class="sh-mk" aria-hidden="true">S</span></div>` +
    `<nav aria-label="Ferramentas"><a class="sh-nv" href="${url('')}" title="Central">${ic(IC.casa)}<span>Central</span></a>${grupos}</nav>` +
    `<div class="sh-pe"><div class="sh-eu">${av}<div class="sh-eu-txt"><b>${esc(eu.nome)}</b><span>${papel}</span></div></div>` +
    '<div class="sh-seg" id="shTema" role="group" aria-label="Tema"><span class="sh-polegar"></span><button type="button" data-v="light">Claro</button><button type="button" data-v="dark">Escuro</button></div>' +
    `<button class="sh-tema-ic" id="shTemaIc" type="button" aria-label="Trocar tema claro ou escuro">${ic(IC.lua)}</button>` +
    `<button class="sh-nv" id="shSair" type="button">${ic(IC.sair)}<span>Sair</span></button>` +
    `<button class="sh-nv" id="shRecolhe" type="button" aria-label="Recolher menu">${ic(IC.lado)}<span>Recolher menu</span></button></div></aside>`;
  const topo = `<header class="sh-topo"><img class="sh-logo-a" src="${url('img/sandstride-escuro.png')}" alt="Sandstride"><img class="sh-logo-b" src="${url('img/sandstride.png')}" alt=""><span class="sh-sp"></span>` +
    `<button class="sh-ib" id="shTemaM" type="button" aria-label="Trocar tema claro ou escuro">${ic(IC.lua)}</button><button class="sh-ib" id="shSairM" type="button" aria-label="Sair">${ic(IC.sair)}</button></header>`;
  const barra = `<nav class="sh-barra-m" aria-label="Atalhos"><div class="sh-barra"><a href="${url('')}" aria-label="Central">${ic(IC.casa)}<span>Central</span></a>` +
    subs.map((x, i) => `<button type="button" data-sub="${i}" aria-label="${esc(x.rotulo)}">${ic(x.d)}<span>${esc(x.rotulo)}</span><b class="sh-selo" hidden></b></button>`).join('') + '</div></nav>';

  // envolve o conteúdo existente sem recriá-lo (os ouvintes e ids da ferramenta continuam valendo)
  const app = document.createElement('div'); app.className = 'sh-app';
  const col = document.createElement('div'); col.className = 'sh-col';
  let rec = false; try { rec = localStorage.getItem(MENU_CH) === '1'; } catch (e) { /* sem armazenamento */ }
  if (rec) app.classList.add('sh-rec');
  const filhos = [...document.body.childNodes].filter((n) => !(n.nodeName === 'SCRIPT'));
  app.insertAdjacentHTML('afterbegin', lat);
  col.insertAdjacentHTML('afterbegin', topo);
  filhos.forEach((n) => col.appendChild(n));
  app.appendChild(col);
  document.body.prepend(app);
  document.body.insertAdjacentHTML('beforeend', barra);
  document.body.classList.add('sh-com');

  // subitens acionam os botões que a ferramenta já tem
  const marca = () => {
    document.querySelectorAll('[data-sub]').forEach((b) => {
      const x = subs[+b.dataset.sub], on = !!(x.ativo && x.ativo());
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const ba = document.querySelector('.sh-barra [aria-current]'); if (ba && ba.scrollIntoView) ba.scrollIntoView({ inline: 'center', block: 'nearest' });
  };
  document.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => { const x = subs[+b.dataset.sub]; x.ao(); setTimeout(marca, 0); }));
  new MutationObserver(marca).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'hidden'] });
  marca();
  const subAt = document.querySelector('.sh-lat .sh-sub[aria-current]'), navEl = document.querySelector('.sh-lat nav');
  if (subAt && navEl) { const r = subAt.getBoundingClientRect(), n = navEl.getBoundingClientRect(); if (r.bottom > n.bottom || r.top < n.top) navEl.scrollTop += (r.bottom > n.bottom ? r.bottom - n.bottom + 8 : r.top - n.top - 8); }
  window.addEventListener('hashchange', () => setTimeout(marca, 0));

  // tema e menu recolhido
  const seg = document.getElementById('shTema'), polegar = seg.querySelector('.sh-polegar'), bs = [...seg.querySelectorAll('button')];
  const tp = pilula(polegar); // a pílula estica até o botão novo (mola)
  const pinta = (t) => {
    bs.forEach((b) => { const on = b.dataset.v === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); if (on && b.offsetWidth) tp.ir(b.offsetLeft - 4, b.offsetWidth); });
    document.querySelectorAll('#shTemaIc,#shTemaM').forEach((b) => { b.innerHTML = ic(t === 'dark' ? IC.sol : IC.lua); });
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === 'dark' ? '#0A0A0A' : '#EDEDEC';
  };
  const poe = (t) => { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem(TEMA_CH, t); } catch (e) { /* idem */ } pinta(t); window.dispatchEvent(new CustomEvent('sandstride-tema', { detail: t })); };
  bs.forEach((b) => b.addEventListener('click', () => poe(b.dataset.v)));
  const alterna = () => poe(temaAtual() === 'dark' ? 'light' : 'dark');
  document.getElementById('shTemaIc').onclick = alterna; document.getElementById('shTemaM').onclick = alterna;
  pinta(temaAtual());
  if (document.fonts?.ready) document.fonts.ready.then(() => pinta(temaAtual()));
  window.addEventListener('resize', () => pinta(temaAtual()));
  // menu que recolhe por mola: largura 260/24, rótulos em cascata (60 ms + 35 ms por item), seta que vira
  const latEl = app.querySelector('.sh-lat'), btnRec = document.getElementById('shRecolhe');
  const rotulos = [...latEl.querySelectorAll('.sh-nv > span:not(.sh-em-breve)')].map((el) => ({ el, s: S(1, 300, 26) }));
  const W = S(app.classList.contains('sh-rec') ? 64 : 232, 260, 24), R = S(app.classList.contains('sh-rec') ? 1 : 0, 300, 22);
  let anim = false, abrindo = false;
  const larg = () => matchMedia('(min-width:1000px)').matches;
  const limpa = () => { anim = false; latEl.style.width = ''; btnRec.firstElementChild.style.transform = ''; rotulos.forEach((l) => { l.el.style.opacity = ''; l.el.style.transform = ''; }); };
  registrar({
    quadro(dt) { if (!anim) return; passo(W, dt); passo(R, dt); rotulos.forEach((l) => passo(l.s, dt)); },
    desenhar() {
      if (!anim) return;
      latEl.style.width = W.x.toFixed(2) + 'px';
      btnRec.firstElementChild.style.transform = `scaleX(${(1 - 2 * limitar(R.x, 0, 1)).toFixed(3)})`;
      rotulos.forEach((l) => { const o = limitar(l.s.x, 0, 1); l.el.style.opacity = o.toFixed(3); l.el.style.transform = `translateX(${((1 - o) * -10).toFixed(2)}px)`; });
      // recolhendo: quando já fechou, assume o estado final do CSS
      if (!abrindo && W.x < 68 && rotulos.every((l) => l.s.x < 0.03)) { app.classList.add('sh-rec'); limpa(); }
      else if (abrindo && parada(W, 0.3) && rotulos.every((l) => parada(l.s, 0.01))) limpa();
    },
    ativo() { return anim; },
  });
  btnRec.onclick = () => {
    const r = !app.classList.contains('sh-rec') && !(anim && !abrindo); // true = vai recolher
    try { localStorage.setItem(MENU_CH, r ? '1' : '0'); } catch (e) { /* idem */ }
    btnRec.setAttribute('aria-label', r ? 'Expandir menu' : 'Recolher menu');
    if (!larg()) { app.classList.toggle('sh-rec', r); return; }
    anim = true; abrindo = !r;
    if (r) { // recolher: rótulos somem juntos, largura fecha
      W.t = 64; R.t = 1; rotulos.forEach((l) => { l.s.t = 0; });
    } else { // abrir: sai do estado recolhido, largura abre e os rótulos entram em cascata
      if (app.classList.contains('sh-rec')) { app.classList.remove('sh-rec'); W.x = 64; R.x = 1; rotulos.forEach((l) => { l.s.x = 0; l.s.v = 0; }); }
      W.t = 232; R.t = 0;
      ajustar(W, 260, 24);
      rotulos.forEach((l, i) => { l.s.t = 0; depois(0.06 + Math.min(i, 10) * 0.035, () => { if (abrindo) l.s.t = 1; }); });
    }
    acordar();
  };
  // selo de contador (bolinha vermelha com número) em um subitem: window.shellSelo(rotuloOuIndice, n); n=0 esconde
  window.shellSelo = (qual, n) => {
    const i = typeof qual === 'number' ? qual : subs.findIndex((x) => x.rotulo === qual); if (i < 0) return;
    n = Math.max(0, Math.floor(+n || 0));
    document.querySelectorAll(`[data-sub="${i}"] .sh-selo`).forEach((el) => {
      const antes = +el.dataset.n || 0; el.dataset.n = String(n);
      el.hidden = n === 0; el.textContent = n > 99 ? '99+' : String(n);
      if (n > antes && antes >= 0 && !matchMedia('(prefers-reduced-motion:reduce)').matches && el.animate) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)', offset: .4 }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
    });
  };
  if (window.__selos) Object.entries(window.__selos).forEach(([k, v]) => window.shellSelo(k, v));
  const sair = async () => { await sb.auth.signOut(); location.href = url(''); };
  document.getElementById('shSair').onclick = sair; document.getElementById('shSairM').onclick = sair;
}
