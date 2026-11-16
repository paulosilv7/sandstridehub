// Configurações: perfil e foto, aparência, Modo Corujão, quem acessa o quê e sair.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { montarShell, APPS } from './shell.js';
import { botaoAcao } from './molas.js';
import { TIPOS, suporte, inscricaoAtual, ativar, desativar, lerPrefs, salvarPref } from './avisos.js';

const sb = window.SB = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IC = {
  lua: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  usuarios: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  relogio: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',
  alerta: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
  sol: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sino: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
const svg = (d, t = 18) => `<svg class="i" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const fotoUrl = (p) => (p ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${p}` : '');
const avatar = (p, nome, cls = '') => { const u = fotoUrl(p); return u ? `<img class="av ${cls}" src="${esc(u)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(String(nome || '?').charAt(0).toUpperCase())}</span>`; };
const TEMA_CH = 'sandstride-tema';
let user, eu;

function temaAtual() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function poeTema(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(TEMA_CH, t); } catch (e) { /* vale só nesta visita */ }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === 'dark' ? '#0A0A0A' : '#EDEDEC';
  window.dispatchEvent(new CustomEvent('sandstride-tema', { detail: t }));
}
// seletor em pílula: o segmento ativo desliza
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
  if (document.fonts?.ready) document.fonts.ready.then(() => marca(temaAtual(), false));
  window.addEventListener('resize', () => marca(temaAtual(), false));
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
  const lab = document.querySelector('.meu-av'), msg = $('msg-foto');
  try {
    if (!file.type.startsWith('image/')) throw new Error('tipo');
    lab.classList.remove('erro-foto'); lab.classList.add('envia'); msg.textContent = 'Enviando…';
    const blob = await reduzir(file);
    const path = `${user.id}/${Date.now()}.jpg`;
    const { error } = await sb.storage.from('avatares').upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    const { error: e2 } = await sb.rpc('definir_minha_foto', { p_path: path });
    if (e2) throw e2;
    if (eu.foto_path) await sb.storage.from('avatares').remove([eu.foto_path]);
    eu.foto_path = path;
    lab.querySelector('.av').outerHTML = avatar(path, eu.nome, 'g');
    document.querySelectorAll('.sh-av').forEach((el) => { el.outerHTML = `<img class="sh-av" src="${esc(fotoUrl(path))}" alt="">`; });
    lab.classList.remove('envia'); msg.textContent = 'Foto atualizada.';
  } catch (e) {
    console.error(e);
    lab.classList.remove('envia'); lab.classList.add('erro-foto'); msg.textContent = 'Não consegui enviar a foto. Use uma imagem JPG, PNG ou WEBP.';
  }
}

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

async function textosAvisos() {
  const el = $('textos-corpo'); if (!el) return;
  const { data, error } = await sb.from('push_textos').select('*').order('tipo');
  if (error || !data) { el.innerHTML = '<p class="sub">Não consegui carregar os textos.</p>'; return; }
  const ordem = ['tarefa_nova', 'tarefa_alterada', 'resumo', 'meta_mes', 'meta_lucro'];
  data.sort((a, b) => ordem.indexOf(a.tipo) - ordem.indexOf(b.tipo));
  el.innerHTML = '<div class="tx-lista">' + data.map((t) => `<form class="tx-item" data-tipo="${esc(t.tipo)}"><b>${esc(t.nome)}</b>` +
    `<label class="campo"><span class="rot">Título</span><input class="md-in" name="titulo" maxlength="80" value="${esc(t.titulo)}"></label>` +
    `<label class="campo"><span class="rot">Mensagem</span><textarea class="md-in" name="corpo" rows="2" maxlength="200">${esc(t.corpo)}</textarea></label>` +
    `<p class="sub">Pode usar: ${esc(t.variaveis)}</p><div class="acoes"><button class="btn sec" type="submit">Salvar</button></div></form>`).join('') + '</div>';
  el.querySelectorAll('form').forEach((f) => {
    const ba = botaoAcao(f.querySelector('button'), { ok: 'Salvo', carregando: 'Salvando…' });
    f.addEventListener('submit', (ev) => { ev.preventDefault(); ba.rodar(async () => {
      const titulo = f.elements.titulo.value.trim(), corpo = f.elements.corpo.value.trim(); if (!titulo) { f.elements.titulo.focus(); return false; }
      const { error: e } = await sb.from('push_textos').update({ titulo, corpo, atualizado_em: new Date().toISOString(), atualizado_por: user.id }).eq('tipo', f.dataset.tipo);
      return !e; }); });
  });
}

async function montarAvisos() {
  const el = $('avisos-corpo'); if (!el) return;
  const sup = suporte(), sub = sup.ok ? await inscricaoAtual() : null, perm = 'Notification' in window ? Notification.permission : 'denied';
  const ligado = !!sub && perm === 'granted';
  let h = '';
  if (!sup.ok) h = sup.motivo === 'ios-instalar'
    ? '<p class="sub">No iPhone, os avisos só funcionam com o app instalado: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>. Abra o Sandstride por esse ícone e volte aqui.</p>'
    : '<p class="sub">Este navegador não permite avisos. Tente pelo Chrome, Edge ou Safari atualizado.</p>';
  else {
    h = `<div class="corujao-st">${ligado ? `<span class="tag rec">${svg(IC.sino)}Ligados neste aparelho</span>` : `<span class="tag">${svg(IC.sino)}Desligados neste aparelho</span>`}` +
      `<button class="btn ${ligado ? 'sec' : 'pri'}" id="av-bt" type="button">${ligado ? 'Desligar neste aparelho' : 'Ativar avisos neste aparelho'}</button>` +
      (ligado ? '<button class="btn sec" id="av-teste" type="button">Enviar aviso de teste</button>' : '') + '</div>' +
      (perm === 'denied' ? '<p class="erro" role="alert">Os avisos estão bloqueados neste navegador. Libere em Configurações do site e tente de novo.</p>' : '');
    if (ligado) {
      const pf = await lerPrefs(sb, user);
      h += '<p class="sub av-tit">Quais avisos você quer receber</p><ul class="av-lista">' + TIPOS.map(([k, nome, desc]) =>
        `<li><label><input type="checkbox" data-pref="${k}"${pf[k] ? ' checked' : ''}><span><b>${esc(nome)}</b><span class="sub">${esc(desc)}</span></span></label></li>`).join('') + '</ul><p id="av-msg" class="sub" aria-live="polite"></p>';
    }
  }
  el.innerHTML = h;
  const bt = $('av-bt');
  if (bt) {
    const ba = botaoAcao(bt, { ok: ligado ? 'Desligado' : 'Ativado', carregando: ligado ? 'Desligando…' : 'Ativando…' });
    bt.addEventListener('click', () => ba.rodar(async () => {
      try { if (ligado) await desativar(sb); else await ativar(sb, user); }
      catch (e) { const m = e.message === 'negado' ? 'Você não permitiu os avisos neste navegador.' : 'Não consegui ativar os avisos. Tente de novo.'; el.querySelector('.av-erro')?.remove(); el.insertAdjacentHTML('beforeend', `<p class="erro av-erro" role="alert">${m}</p>`); return false; }
      setTimeout(montarAvisos, 1400); return true;
    }));
  }
  const t = $('av-teste');
  if (t) {
    const bt2 = botaoAcao(t, { ok: 'Enviado', carregando: 'Enviando…' });
    t.addEventListener('click', () => bt2.rodar(async () => { const { error } = await sb.rpc('push_teste'); return !error; }));
  }
  el.querySelectorAll('[data-pref]').forEach((c) => c.addEventListener('change', async () => {
    const ok = await salvarPref(sb, user, c.dataset.pref, c.checked);
    if (!ok) c.checked = !c.checked;
    const m = $('av-msg'); if (m) m.textContent = ok ? 'Preferência salva.' : 'Não consegui salvar. Tente de novo.';
  }));
}

(async () => {
  const { data } = await sb.auth.getSession();
  user = data?.session?.user;
  if (!user) { location.replace('../'); return; }
  const { data: e } = await sb.from('equipe').select('usuario_id, nome, papel, foto_path').eq('usuario_id', user.id).maybeSingle();
  if (!e) { location.replace('../'); return; }
  eu = e;
  const papel = eu.papel === 'admin' ? 'Administrador' : 'Atendente';
  let n = 1; const o = () => `style="--o:${n++}"`;
  const card = (id, ico, titulo, corpo, extra) => `<section class="card entra" ${o()} id="${id}" aria-label="${titulo}"><div class="qcab"><span class="ico">${svg(ico)}</span><h2>${titulo}</h2></div>${corpo ? `<p class="corpo">${corpo}</p>` : ''}${extra}</section>`;
  let h = '<div class="pg-cab entra" style="--o:0"><h1>Configurações</h1><p class="sub">Seu perfil, a aparência do sistema e os acessos da equipe.</p></div><div class="cfg-grade">';
  h += card('perfil', IC.user, 'Perfil', '',
    `<div class="perfil"><label class="meu-av" title="Trocar minha foto" for="foto">${avatar(eu.foto_path, eu.nome, 'g')}<span class="cam" aria-hidden="true">+</span></label>` +
    `<div class="perfil-txt"><b>${esc(eu.nome)}</b><span class="sub">${papel}</span><span id="msg-foto" class="sub" aria-live="polite"></span></div>` +
    '<div class="perfil-acoes"><label class="btn sec" for="foto" style="cursor:pointer">Trocar foto</label></div></div><input id="foto" class="sr" type="file" accept="image/*">');
  h += card('aparencia', IC.sol, 'Aparência', 'Escolha o tema do sistema neste aparelho.',
    '<div class="seg" id="tema" role="group" aria-label="Tema"><span class="polegar"></span><button type="button" data-v="light">Claro</button><button type="button" data-v="dark">Escuro</button></div>');
  h += card('avisos', IC.sino, 'Avisos no aparelho', 'Receba avisos no celular ou no computador, mesmo com o sistema fechado. Cada aparelho se liga separadamente.', '<div id="avisos-corpo"><span class="sub">Carregando…</span></div>');
  if (eu.papel === 'admin') h += card('textos', IC.sino, 'Textos dos avisos', 'Como cada aviso aparece no aparelho. As palavras entre chaves, como {tarefa}, são trocadas pelo valor na hora do envio.', '<div id="textos-corpo"><span class="sub">Carregando…</span></div>');
  h += card('coruja', IC.lua, 'Modo Corujão', 'Das 00h às 06h as atualizações automáticas rodam de hora em hora. Ligue para manter o ritmo normal; ele desliga sozinho às 6h.',
    '<div id="coruja-st" class="corujao-st"><span class="sub">Carregando…</span></div>');
  if (eu.papel === 'admin') h += card('acessos', IC.usuarios, 'Quem acessa o quê', 'Marque as ferramentas que cada pessoa pode abrir. Administradores acessam tudo.', '<div id="tab" class="tbl"><p class="sub">Carregando…</p></div>');
  h += card('conta', IC.sair, 'Conta', 'Encerre a sessão neste aparelho.', '<div class="acoes"><button class="btn sec" id="sair" type="button">Sair</button></div>');
  h += '</div>';
  $('raiz').innerHTML = `<main class="wrap">${h}</main>`;
  $('foto').onchange = (ev) => { const f = ev.target.files[0]; if (f) trocarFoto(f); };
  seg($('tema'), temaAtual(), poeTema);
  $('sair').onclick = async () => { await sb.auth.signOut(); location.href = '../'; };
  carregarCoruja();
  montarAvisos();
  if (eu.papel === 'admin') textosAvisos();
  if (eu.papel === 'admin') tabelaAcessos();
  await montarShell({ ativo: 'configuracoes', raiz: '../' });
  window.dispatchEvent(new Event('resize'));
})();
