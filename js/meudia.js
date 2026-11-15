// Central "Meu dia": cumprimento, rotina de hoje, tarefas, metas do mês e visão da equipe.
import { SUPABASE_URL } from './config.js';
import { S, passo, parada, registrar, acordar } from './molas.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const svg = (d, t = 18) => `<svg class="i" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const IC = {
  rotina: '<path d="M4 6.5 5.5 8 8 5M4 12.5 5.5 14 8 11M4 18.5 5.5 20 8 17M11 6.5h9M11 12.5h9M11 18.5h9"/>',
  tarefa: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1ZM8 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 13l2 2 4-4"/>',
  meta: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01"/>',
  equipe: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  lapis: '<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  relogio: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',
  alerta: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
};
export const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'], DIAS_N = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const TZ = 'America/Sao_Paulo';
export const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export const dataDe = (iso) => new Date(iso + 'T12:00:00Z');
export const soma = (iso, n) => { const d = dataDe(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const fCurto = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const fMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
export const nBR = (n, c = 0) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
export const valor = (n, un) => (un === 'reais' ? `R$ ${nBR(n, 2)}` : un === 'pct' ? `${nBR(n, Number.isInteger(+n) ? 0 : 1)}%` : nBR(n));
function saudacao() {
  const h = +new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date());
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export async function montarMeuDia({ sb, user, eu, el, caixa }) {
  const admin = eu.papel === 'admin';
  const E = { equipe: [], rotinas: [], feitos: new Set(), tarefas: [], metas: [], filtro: 'hoje', primeira: true, erro: '', pop: false, aberta: new Set(), rasc: { titulo: '', resp: user.id, prazo: '', imp: 'normal' } };
  const hoje = hojeISO(), dsem = dataDe(hoje).getUTCDay(), mes = hoje.slice(0, 8) + '01';
  const fotoUrl = (p) => (p ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${p}` : '');
  const av = (p, cls = '') => { const u = fotoUrl(p?.foto_path); return u ? `<img class="av ${cls}" src="${esc(u)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(String(p?.nome || '?').charAt(0).toUpperCase())}</span>`; };
  const pessoa = (id) => E.equipe.find((p) => p.usuario_id === id);
  const prim = (nome) => String(nome || '').split(' ')[0];

  async function carregar() {
    const [eq, ro, fe, ta, me] = await Promise.all([
      sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome'),
      sb.from('central_rotinas').select('*').eq('ativo', true).order('ordem').order('criado_em'),
      sb.from('central_rotina_feitos').select('rotina_id').eq('dia', hoje),
      sb.from('central_tarefas').select('*').or(`feita_em.is.null,feita_em.gte.${hoje}T00:00:00-03:00`).order('prazo', { nullsFirst: false }).order('criado_em'),
      sb.from('central_metas').select('*').eq('mes', mes).order('atualizado_em'),
    ]);
    E.erro = [eq, ro, fe, ta, me].some((r) => r.error) ? 'Não consegui carregar tudo. Atualize a página.' : '';
    E.equipe = eq.data || []; E.rotinas = ro.data || []; E.feitos = new Set((fe.data || []).map((x) => x.rotina_id));
    E.tarefas = ta.data || []; E.metas = me.data || [];
  }
  const rotinaDe = (uid) => E.rotinas.filter((r) => r.usuario_id === uid && (r.dias || []).includes(dsem));
  const PESO = { baixa: 0, normal: 1, alta: 2 };
  const abertas = (uid) => E.tarefas.filter((t) => t.responsavel_id === uid && !t.feita_em);
  const atrasada = (t) => !t.feita_em && t.prazo && t.prazo < hoje;

  // ---- molas: anel do dia e medidores das metas
  const anel = S(0, 140, 20), medidores = new Map();
  registrar({
    quadro(dt) { passo(anel, dt); medidores.forEach((m) => passo(m, dt)); },
    desenhar() {
      const a = el.querySelector('#md-anel');
      if (a) { if (parada(anel, 0.002)) { anel.x = anel.t; anel.v = 0; } a.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, anel.x)).toFixed(4)} 1`); a.style.opacity = anel.x < 0.005 ? 0 : 1; }
      medidores.forEach((m, id) => {
        const p = el.querySelector(`[data-arco="${id}"]`); if (!p) return;
        if (parada(m, 0.002)) { m.x = m.t; m.v = 0; }
        p.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, m.x)).toFixed(4)} 1`); p.style.opacity = m.x < 0.005 ? 0 : 1;
        const n = el.querySelector(`[data-pct="${id}"]`); if (n) n.textContent = `${Math.round(Math.max(0, m.x) * 100)}%`;
      });
    },
    ativo() { return !parada(anel, 0.002) || [...medidores.values()].some((m) => !parada(m, 0.002)); },
  });

  // ---- quadros
  function resumo() {
    const r = rotinaDe(user.id), f = r.filter((x) => E.feitos.has(x.id)).length, ab = abertas(user.id);
    const hj = ab.filter((t) => !t.prazo || t.prazo === hoje).length, at = ab.filter(atrasada).length;
    const total = r.length, falta = total - f, pct = total ? Math.round((f / total) * 100) : 0;
    const titulo = !total && !ab.length ? 'Nada marcado para hoje'
      : total && !falta && !hj && !at ? 'Tudo em dia'
      : total && !falta ? 'Rotina concluída'
      : falta === 1 ? 'Falta 1 item da rotina' : `Faltam ${falta} itens da rotina`;
    const sub = at ? `Você tem ${at} ${at === 1 ? 'tarefa atrasada' : 'tarefas atrasadas'} para resolver.`
      : hj ? `${hj} ${hj === 1 ? 'tarefa' : 'tarefas'} com prazo para hoje.`
      : total ? 'Nenhuma tarefa pendente para hoje.' : 'Monte sua rotina para acompanhar o dia aqui.';
    return { f, total, hj, at, pct, titulo, sub };
  }
  const rotH = (n) => (n === 1 ? 'tarefa<br>para hoje' : 'tarefas<br>para hoje'), rotA = (n) => (n === 1 ? 'atrasada' : 'atrasadas');
  function palco() {
    const R = resumo(); anel.t = R.total ? R.f / R.total : 0;
    return `<section class="card md-palco" aria-label="Seu dia">` +
      `<div class="md-anelbox"><svg class="md-anel" viewBox="0 0 120 120" role="img" aria-label="${R.f} de ${R.total} itens da rotina feitos"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="10"/><circle id="md-anel" cx="60" cy="60" r="52" pathLength="1" fill="none" stroke="var(--destaque-claro)" stroke-width="10" stroke-linecap="round" stroke-dasharray="0 1" transform="rotate(-90 60 60)"/></svg>` +
      `<div class="md-anelnum"><b id="md-feitas">${R.f}</b><span>de ${R.total}</span></div></div>` +
      `<div class="md-palco-txt"><span class="md-rot">Rotina de hoje</span><h2 class="md-tit" id="md-tit">${R.titulo}</h2><p class="md-sub" id="md-sub">${R.sub}</p></div>` +
      `<div class="md-stats"><div class="md-st"><b id="md-s-hj">${R.hj}</b><span id="md-s-hjt">${rotH(R.hj)}</span></div>` +
      `<div class="md-st${R.at ? ' ate' : ''}" id="md-s-atc"><b id="md-s-at">${R.at}</b><span id="md-s-att">${rotA(R.at)}</span></div>` +
      `<div class="md-st"><b id="md-s-pct">${R.pct}%</b><span>da rotina<br>feita</span></div></div></section>`;
  }
  function atualizaPalco() {
    const R = resumo(), q = (i) => el.querySelector('#' + i); if (!q('md-feitas')) return;
    q('md-feitas').textContent = R.f; q('md-tit').textContent = R.titulo; q('md-sub').textContent = R.sub;
    q('md-s-hj').textContent = R.hj; q('md-s-hjt').innerHTML = rotH(R.hj); q('md-s-at').textContent = R.at; q('md-s-att').textContent = rotA(R.at);
    q('md-s-atc').classList.toggle('ate', !!R.at); q('md-s-pct').textContent = R.pct + '%';
    anel.t = R.total ? R.f / R.total : 0; acordar();
  }
  function qRotina() {
    const r = rotinaDe(user.id);
    const linhas = r.map((x) => { const on = E.feitos.has(x.id); return `<li><button type="button" class="md-chk${on ? ' on' : ''}" data-rot="${x.id}" aria-pressed="${on}"><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(x.titulo)}</span></button></li>`; }).join('');
    return `<section class="card" aria-label="Rotina de hoje"><div class="qcab"><span class="ico">${svg(IC.rotina)}</span><h2>Rotina de hoje</h2><button class="ibtn p" type="button" data-editar="${user.id}" aria-label="Editar minha rotina" title="Editar minha rotina">${svg(IC.lapis)}</button></div>` +
      (r.length ? `<ul class="md-lista">${linhas}</ul>` : `<div class="md-vazio listrado"><p>Sem rotina para ${DIAS_N[dsem]}.</p><button class="btn sec" type="button" data-editar="${user.id}">Montar rotina</button></div>`) + '</section>';
  }
  function listaTarefas() {
    const sem = soma(hoje, 7);
    const f = { hoje: (t) => t.responsavel_id === user.id && (!t.prazo || t.prazo === hoje), atrasadas: (t) => t.responsavel_id === user.id && atrasada(t), semana: (t) => t.responsavel_id === user.id && t.prazo > hoje && t.prazo <= sem, equipe: (t) => t.responsavel_id !== user.id }[E.filtro];
    const l = E.tarefas.filter((t) => f(t) && (E.filtro !== 'atrasadas' || !t.feita_em)).sort((a, b) => (!!a.feita_em - !!b.feita_em) || (PESO[b.importancia] || 1) - (PESO[a.importancia] || 1));
    if (!l.length) return `<div class="md-vazio"><p>${{ hoje: 'Nada para hoje.', atrasadas: 'Nada atrasado.', semana: 'Nada nos próximos 7 dias.', equipe: 'A equipe não tem tarefas abertas.' }[E.filtro]}</p></div>`;
    return `<ul class="md-lista">${l.map((t) => {
      const on = !!t.feita_em, meu = t.responsavel_id === user.id, pode = meu || t.criado_por === user.id || admin, p = pessoa(t.responsavel_id);
      const prazo = t.prazo ? `<span class="tag${atrasada(t) ? ' ate' : ''}">${svg(atrasada(t) ? IC.alerta : IC.relogio)}${t.prazo === hoje ? 'Hoje' : fCurto.format(dataDe(t.prazo))}</span>` : '';
      const imp = t.importancia === 'alta' && !on ? `<span class="tag alta">Alta</span>` : '';
      return `<li><button type="button" class="md-chk${on ? ' on' : ''}" data-tar="${t.id}" aria-pressed="${on}"${pode ? '' : ' disabled'}><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(t.titulo)}</span></button>` +
        `${imp}${prazo}${!meu && p ? `<span class="md-quem" title="${esc(p.nome)}">${av(p, 'p')}</span>` : ''}${t.criado_por === user.id || admin ? `<button class="md-x" type="button" data-apaga="${t.id}" aria-label="Apagar tarefa">${svg(IC.x, 14)}</button>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  function popNova() {
    const R = E.rasc, imp = (v, r) => `<button type="button" data-imp="${v}" class="${R.imp === v ? 'on' : ''}" aria-pressed="${R.imp === v}">${r}</button>`;
    return `<div class="md-pop" role="dialog" aria-label="Nova tarefa"><form id="md-nova">` +
      `<label class="campo"><span>Nome da tarefa</span><input class="md-in" id="md-titulo" maxlength="160" autocomplete="off" value="${esc(R.titulo)}"></label>` +
      `<div class="md-duo"><label class="campo"><span>Responsável</span><select class="md-in" id="md-resp">${E.equipe.map((p) => `<option value="${p.usuario_id}"${p.usuario_id === R.resp ? ' selected' : ''}>${esc(p.usuario_id === user.id ? 'Para mim' : prim(p.nome))}</option>`).join('')}</select></label>` +
      `<label class="campo"><span>Data</span><input class="md-in" id="md-prazo" type="date" min="${hoje}" value="${esc(R.prazo)}"></label></div>` +
      `<div class="campo"><span>Importância</span><div class="md-imp" role="group" aria-label="Importância">${imp('baixa', 'Baixa')}${imp('normal', 'Normal')}${imp('alta', 'Alta')}</div></div>` +
      `<div class="md-acoes"><button class="btn" type="button" data-pop="fecha">Cancelar</button><button class="btn pri" type="submit">Criar tarefa</button></div></form></div>`;
  }
  function qTarefas() {
    const ab = abertas(user.id), n = { hoje: ab.filter((t) => !t.prazo || t.prazo === hoje).length, atrasadas: ab.filter(atrasada).length };
    const bt = (v, r) => `<button type="button" data-f="${v}" class="${E.filtro === v ? 'on' : ''}" aria-pressed="${E.filtro === v}">${r}${n[v] ? `<i>${n[v]}</i>` : ''}</button>`;
    return `<section class="card md-tarefas" aria-label="Tarefas"><div class="qcab"><span class="ico">${svg(IC.tarefa)}</span><h2>Tarefas</h2>` +
      `<button class="btn pri md-mais${E.pop ? ' on' : ''}" type="button" data-pop="abre" aria-label="Nova tarefa" aria-expanded="${E.pop}">${svg(IC.mais)}</button></div>` +
      (E.pop ? popNova() : '') +
      `<div class="md-filtros" role="group" aria-label="Filtro">${bt('hoje', 'Hoje')}${bt('atrasadas', 'Atrasadas')}${bt('semana', 'Semana')}${bt('equipe', 'Equipe')}</div>` +
      `<div id="md-tarefas">${listaTarefas()}</div></section>`;
  }
  function qMetas() {
    const cards = E.metas.map((m) => {
      const pct = Math.max(0, Math.min(1, m.atual / m.alvo));
      if (!medidores.has(m.id)) medidores.set(m.id, S(0, 140, 20)); medidores.get(m.id).t = pct;
      const p = m.responsavel_id && pessoa(m.responsavel_id);
      return `<div class="md-meta"><div class="md-meta-cab"><b>${esc(m.titulo)}</b>${p ? `<span class="md-quem" title="${esc(p.nome)}">${av(p, 'p')}</span>` : ''}${admin ? `<button class="ibtn p" type="button" data-meta="${m.id}" aria-label="Atualizar meta">${svg(IC.lapis)}</button>` : ''}</div>` +
        `<div class="md-med"><svg viewBox="0 0 200 112" aria-hidden="true"><path d="M20 100A80 80 0 0 1 180 100" fill="none" stroke="var(--elevado)" stroke-width="14" stroke-linecap="round"/><path data-arco="${m.id}" d="M20 100A80 80 0 0 1 180 100" pathLength="1" fill="none" stroke="${pct >= 1 ? 'var(--recebido)' : 'var(--destaque)'}" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 1"/></svg><b data-pct="${m.id}">0%</b></div>` +
        `<p class="md-meta-v"><b>${valor(m.atual, m.unidade)}</b> de ${valor(m.alvo, m.unidade)}</p></div>`;
    }).join('');
    [...medidores.keys()].forEach((id) => { if (!E.metas.some((m) => m.id === id)) medidores.delete(id); });
    const nomeMes = fMes.format(dataDe(mes));
    return `<section class="card" aria-label="Metas do mês"><div class="qcab"><span class="ico">${svg(IC.meta)}</span><h2>Metas de ${nomeMes}</h2>${admin ? `<button class="btn sec" type="button" data-meta="nova">${svg(IC.mais)}Meta</button>` : ''}</div>` +
      (cards ? `<div class="md-metas">${cards}</div>` : `<div class="md-vazio listrado"><p>Nenhuma meta em ${nomeMes}.</p></div>`) + '</section>';
  }
  function qEquipe() {
    if (!admin) return '';
    const linhas = E.equipe.map((p) => {
      const r = rotinaDe(p.usuario_id), f = r.filter((x) => E.feitos.has(x.id)).length, ab = abertas(p.usuario_id), at = ab.filter(atrasada).length;
      const pct = r.length ? Math.round((f / r.length) * 100) : 0;
      const ord = ab.slice().sort((a, b) => (!!b.prazo && b.prazo < hoje) - (!!a.prazo && a.prazo < hoje) || (PESO[b.importancia] || 1) - (PESO[a.importancia] || 1) || (a.prazo || '9') .localeCompare(b.prazo || '9'));
      const ver = E.aberta.has(p.usuario_id) ? ord : ord.slice(0, 3);
      const pend = ord.length ? `<ul class="md-pend">${ver.map((t) => `<li><span class="tx">${esc(t.titulo)}</span>${t.importancia === 'alta' ? '<span class="tag alta">Alta</span>' : ''}${t.prazo ? `<span class="tag${atrasada(t) ? ' ate' : ''}">${svg(atrasada(t) ? IC.alerta : IC.relogio)}${t.prazo === hoje ? 'Hoje' : fCurto.format(dataDe(t.prazo))}</span>` : '<span class="tag">Sem data</span>'}</li>`).join('')}</ul>` +
        (ord.length > 3 ? `<button class="md-mais-t" type="button" data-todas="${p.usuario_id}">${E.aberta.has(p.usuario_id) ? 'Mostrar menos' : `Ver as ${ord.length} tarefas`}</button>` : '') : '<p class="md-pend-vazio">Nenhuma tarefa aberta.</p>';
      return `<li class="md-pes"><div class="md-lin"><div class="pessoa">${av(p)}<div><b>${esc(p.nome)}</b><br><span class="sub">${r.length ? `${f} de ${r.length} da rotina` : 'sem rotina hoje'}</span></div></div>` +
        `<div class="md-barra${r.length ? '' : ' listrado'}" aria-hidden="true"><span style="width:${pct}%"></span></div>` +
        `<span class="tag">${svg(IC.tarefa)}${ab.length} ${ab.length === 1 ? 'aberta' : 'abertas'}</span>${at ? `<span class="tag ate">${svg(IC.alerta)}${at}</span>` : '<span class="md-sp"></span>'}` +
        `<button class="ibtn p" type="button" data-editar="${p.usuario_id}" aria-label="Editar rotina de ${esc(p.nome)}" title="Editar rotina">${svg(IC.lapis)}</button></div>` +
        `<div class="md-pendentes"><span class="md-rot">Pendente</span>${pend}</div></li>`;
    }).join('');
    return `<section class="card" aria-label="Equipe hoje"><div class="qcab"><span class="ico">${svg(IC.equipe)}</span><h2>Equipe hoje</h2></div><ul class="md-equipe">${linhas}</ul></section>`;
  }

  function desenhar() {
    const e = E.primeira ? ' entra' : ''; let n = 0; const o = () => (E.primeira ? ` style="--o:${n++}"` : '');
    const foco = document.activeElement?.id;
    const pA = `<div class="pg-cab${e}"${o()}><h1>${saudacao()}, ${esc(prim(eu.nome))}.</h1><p class="sub md-data">${esc(fDia.format(dataDe(hoje)))}</p></div>` +
      (E.erro ? `<p class="erro" role="alert">${svg(IC.alerta)}<span>${esc(E.erro)}</span></p>` : '') +
      `<div class="${e.trim()}"${o()}>${palco()}</div>`;
    const pE = `<div class="${e.trim()}"${o()}>${qRotina()}</div><div class="${e.trim()}"${o()}>${qTarefas()}</div>`;
    const pB = `<div class="${e.trim()}"${o()}>${qMetas()}</div>` + (admin ? `<div class="${e.trim()}"${o()}>${qEquipe()}</div>` : '');
    el.querySelector('#md-a').innerHTML = pA; el.querySelector('#md-e').innerHTML = pE; el.querySelector('#md-b').innerHTML = pB;
    if (foco && el.querySelector('#' + foco)) el.querySelector('#' + foco).focus();
    E.primeira = false; acordar();
  }
  const falhou = (msg) => { E.erro = msg; desenhar(); };

  // ---- ações
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.rot) {
      const id = b.dataset.rot, on = !E.feitos.has(id);
      if (on) E.feitos.add(id); else E.feitos.delete(id);
      marcar(b, on); const r = rotinaDe(user.id), f = r.filter((x) => E.feitos.has(x.id)).length;
      atualizaPalco();
      const { error } = on ? await sb.from('central_rotina_feitos').insert({ rotina_id: id, dia: hoje, usuario_id: user.id }) : await sb.from('central_rotina_feitos').delete().eq('rotina_id', id).eq('dia', hoje);
      if (error) { if (on) E.feitos.delete(id); else E.feitos.add(id); falhou('Não consegui salvar a marcação. Tente de novo.'); } else setTimeout(desenhar, 700);
    } else if (b.dataset.tar) {
      const t = E.tarefas.find((x) => x.id === b.dataset.tar); if (!t) return;
      const antes = t.feita_em; t.feita_em = antes ? null : new Date().toISOString(); marcar(b, !!t.feita_em);
      const { error } = await sb.from('central_tarefas').update({ feita_em: t.feita_em }).eq('id', t.id);
      if (error) { t.feita_em = antes; falhou('Não consegui salvar a tarefa. Tente de novo.'); } else setTimeout(desenhar, 700);
    } else if (b.dataset.apaga) {
      const i = E.tarefas.findIndex((x) => x.id === b.dataset.apaga); if (i < 0) return;
      const [t] = E.tarefas.splice(i, 1); desenhar();
      const { error } = await sb.from('central_tarefas').delete().eq('id', t.id);
      if (error) { E.tarefas.splice(i, 0, t); falhou('Não consegui apagar a tarefa.'); }
    } else if (b.dataset.pop) { E.pop = b.dataset.pop === 'abre' ? !E.pop : false; desenhar(); if (E.pop) el.querySelector('#md-titulo')?.focus(); }
    else if (b.dataset.imp) { E.rasc.imp = b.dataset.imp; desenhar(); }
    else if (b.dataset.todas) { const u = b.dataset.todas; if (E.aberta.has(u)) E.aberta.delete(u); else E.aberta.add(u); desenhar(); }
    else if (b.dataset.f) { E.filtro = b.dataset.f; desenhar(); }
    else if (b.dataset.editar) janelaRotina(b.dataset.editar);
    else if (b.dataset.meta) janelaMeta(b.dataset.meta);
  });
  function marcar(b, on) {
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 600); }
  }
  el.addEventListener('input', (ev) => {
    const k = { 'md-titulo': 'titulo', 'md-resp': 'resp', 'md-prazo': 'prazo' }[ev.target.id]; if (k) E.rasc[k] = ev.target.value;
  });
  el.addEventListener('change', (ev) => { const k = { 'md-resp': 'resp', 'md-prazo': 'prazo' }[ev.target.id]; if (k) E.rasc[k] = ev.target.value; });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && E.pop) { E.pop = false; desenhar(); el.querySelector('.md-mais')?.focus(); } });
  el.addEventListener('pointerdown', (ev) => { if (E.pop && !ev.target.closest('.md-pop, .md-mais')) { E.pop = false; desenhar(); } });
  el.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'md-nova') return; ev.preventDefault();
    const R = E.rasc, titulo = R.titulo.trim(); if (!titulo) { el.querySelector('#md-titulo').focus(); return; }
    const nova = { titulo, responsavel_id: R.resp, prazo: R.prazo || null, importancia: R.imp, criado_por: user.id };
    const { data, error } = await sb.from('central_tarefas').insert(nova).select().single();
    if (error || !data) return falhou('Não consegui criar a tarefa. Tente de novo.');
    E.tarefas.push(data); if (data.responsavel_id !== user.id) E.filtro = 'equipe'; else if (data.prazo && data.prazo > hoje) E.filtro = 'semana'; else E.filtro = 'hoje';
    E.rasc = { titulo: '', resp: user.id, prazo: '', imp: 'normal' }; E.pop = false; E.erro = ''; desenhar();
  });

  // ---- janelas (rotina de uma pessoa, meta)
  function janela(html) {
    document.getElementById('md-dlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'md-dlg'; d.className = 'md-dlg'; d.innerHTML = html; document.body.appendChild(d);
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-fecha]')) d.close(); });
    d.addEventListener('close', () => { d.remove(); desenhar(); });
    d.showModal(); return d;
  }
  function janelaRotina(uid) {
    const p = pessoa(uid) || eu, meu = uid === user.id;
    const d = janela(`<div class="qcab"><span class="ico">${svg(IC.rotina)}</span><h2>${meu ? 'Minha rotina' : `Rotina de ${esc(prim(p.nome))}`}</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div><ul class="md-edit" id="md-edit"></ul>` +
      `<form class="md-nova" id="md-rot-nova"><input class="md-in" id="md-rot-t" placeholder="Novo item da rotina" maxlength="120" aria-label="Novo item da rotina" autocomplete="off"><button class="btn pri" type="submit" aria-label="Adicionar item">${svg(IC.mais)}</button></form><p class="erro" id="md-rot-erro" role="alert" hidden></p>`);
    const lista = d.querySelector('#md-edit'), erro = d.querySelector('#md-rot-erro');
    const falha = (m) => { erro.hidden = false; erro.textContent = m; };
    const pinta = () => {
      const l = E.rotinas.filter((r) => r.usuario_id === uid);
      lista.innerHTML = l.length ? l.map((r) => `<li><span class="tx">${esc(r.titulo)}</span><span class="md-dias" role="group" aria-label="Dias da semana">${DIAS.map((x, i) => `<button type="button" data-r="${r.id}" data-d="${i}" class="${r.dias.includes(i) ? 'on' : ''}" aria-pressed="${r.dias.includes(i)}" aria-label="${DIAS_N[i]}">${x}</button>`).join('')}</span><button class="md-x" type="button" data-tira="${r.id}" aria-label="Remover item">${svg(IC.x, 14)}</button></li>`).join('') : '<li class="md-vazio"><p>Nenhum item ainda.</p></li>';
    };
    pinta();
    lista.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return; erro.hidden = true;
      if (b.dataset.r) {
        const r = E.rotinas.find((x) => x.id === b.dataset.r), i = +b.dataset.d, antes = r.dias;
        r.dias = antes.includes(i) ? antes.filter((x) => x !== i) : [...antes, i].sort(); pinta();
        const { error } = await sb.from('central_rotinas').update({ dias: r.dias }).eq('id', r.id);
        if (error) { r.dias = antes; pinta(); falha('Não consegui salvar os dias.'); }
      } else if (b.dataset.tira) {
        const i = E.rotinas.findIndex((x) => x.id === b.dataset.tira), [r] = E.rotinas.splice(i, 1); pinta();
        const { error } = await sb.from('central_rotinas').update({ ativo: false }).eq('id', r.id);
        if (error) { E.rotinas.splice(i, 0, r); pinta(); falha('Não consegui remover o item.'); }
      }
    });
    d.querySelector('#md-rot-nova').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const t = d.querySelector('#md-rot-t'), titulo = t.value.trim(); if (!titulo) return; t.value = ''; erro.hidden = true;
      const { data, error } = await sb.from('central_rotinas').insert({ usuario_id: uid, titulo, dias: [1, 2, 3, 4, 5, 6], ordem: E.rotinas.filter((r) => r.usuario_id === uid).length }).select().single();
      if (error || !data) return falha('Não consegui adicionar o item.');
      E.rotinas.push(data); pinta(); t.focus();
    });
  }
  function janelaMeta(id) {
    const m = id === 'nova' ? null : E.metas.find((x) => x.id === id);
    const d = janela(`<form id="md-meta-f"><div class="qcab"><span class="ico">${svg(IC.meta)}</span><h2>${m ? 'Atualizar meta' : 'Nova meta'}</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<label class="campo"><span class="rot">Meta</span><input id="mm-t" maxlength="80" required value="${esc(m?.titulo || '')}" placeholder="Ex.: Pares vendidos"></label>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Medida</span><select id="mm-u" class="md-in">${[['un', 'Quantidade'], ['reais', 'Reais (R$)'], ['pct', 'Porcentagem (%)']].map(([v, r]) => `<option value="${v}"${m?.unidade === v ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<label class="campo"><span class="rot">Responsável</span><select id="mm-r" class="md-in"><option value="">Toda a empresa</option>${E.equipe.map((p) => `<option value="${p.usuario_id}"${m?.responsavel_id === p.usuario_id ? ' selected' : ''}>${esc(prim(p.nome))}</option>`).join('')}</select></label></div>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Onde estamos</span><input id="mm-a" inputmode="decimal" required value="${m ? String(m.atual).replace('.', ',') : '0'}"></label><label class="campo"><span class="rot">Onde queremos chegar</span><input id="mm-v" inputmode="decimal" required value="${m ? String(m.alvo).replace('.', ',') : ''}"></label></div>` +
      `<p class="erro" id="mm-erro" role="alert" hidden></p><div class="md-acoes">${m ? '<button class="btn sec" type="button" id="mm-apaga">Apagar meta</button>' : ''}<span class="md-sp"></span><button class="btn sec" type="button" data-fecha>Cancelar</button><button class="btn pri" type="submit">Salvar</button></div></form>`);
    const num = (s) => { const v = String(s).trim().replace(/\./g, '').replace(',', '.'); return v === '' ? NaN : Number(v); };
    const erro = d.querySelector('#mm-erro'), falha = (t) => { erro.hidden = false; erro.textContent = t; };
    d.querySelector('#md-meta-f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reg = { titulo: d.querySelector('#mm-t').value.trim(), unidade: d.querySelector('#mm-u').value, responsavel_id: d.querySelector('#mm-r').value || null, atual: num(d.querySelector('#mm-a').value), alvo: num(d.querySelector('#mm-v').value), atualizado_em: new Date().toISOString() };
      if (!reg.titulo) return falha('Dê um nome para a meta.');
      if (!(reg.alvo > 0) || !(reg.atual >= 0)) return falha('Use números: onde estamos (0 ou mais) e onde queremos chegar (maior que 0).');
      const q = m ? sb.from('central_metas').update(reg).eq('id', m.id).select().single() : sb.from('central_metas').insert({ ...reg, mes }).select().single();
      const { data, error } = await q;
      if (error || !data) return falha('Não consegui salvar a meta. Tente de novo.');
      if (m) Object.assign(m, data); else E.metas.push(data);
      d.close();
    });
    d.querySelector('#mm-apaga')?.addEventListener('click', async () => {
      const { error } = await sb.from('central_metas').delete().eq('id', m.id);
      if (error) return falha('Não consegui apagar a meta.');
      E.metas = E.metas.filter((x) => x.id !== m.id); d.close();
    });
  }

  el.innerHTML = '<div id="md-a"></div><div class="md-cols"><div class="md-esq" id="md-e"></div><div id="md-ideias"></div></div><div id="md-b"></div>';
  await carregar();
  desenhar();
  if (caixa) caixa({ sb, user, eu, el: el.querySelector('#md-ideias'), aoCriarTarefa: async () => { await carregar(); desenhar(); } });
}
