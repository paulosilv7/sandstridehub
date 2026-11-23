// Central "Meu dia": cumprimento, rotina de hoje, tarefas, metas do mês e visão da equipe.
import { SUPABASE_URL } from './config.js';
import { S, passo, parada, registrar, acordar, botaoAcao } from './molas.js';
import { novoEstado, chipsResp, alternaResp, donosDe } from './responsaveis.js';
import { abrirDetalheTarefa, tagImp, seloTarefa } from './tarefa-detalhe.js';
import { esc, svg, IC, DIAS, DIAS_N, TZ, hojeISO, dataDe, soma, fCurto, fDia, fMes, valor, prim } from './util.js';

function saudacao() {
  const h = +new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date());
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export async function montarMeuDia({ sb, user, eu, el, caixa }) {
  const admin = eu.papel === 'admin';
  const E = { itens: [], lojasML: null, codigos: [], equipe: [], rotinas: [], feitos: new Set(), tarefas: [], metas: [], filtro: 'hoje', eqAberta: false, feitosSem: [], primeira: true, erro: '', pop: false, aberta: new Set(), rasc: { titulo: '', resp: user.id, prazo: '', imp: 'normal' } };
  const hoje = hojeISO(), dsem = dataDe(hoje).getUTCDay(), mes = hoje.slice(0, 8) + '01';
  // semana de trabalho: segunda a sexta (no fim de semana mostra a próxima)
  const segunda = dsem === 0 ? soma(hoje, 1) : dsem === 6 ? soma(hoje, 2) : soma(hoje, 1 - dsem), sexta = soma(segunda, 4);
  const fotoUrl = (p) => (p ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${p}` : '');
  const av = (p, cls = '') => { const u = fotoUrl(p?.foto_path); return u ? `<img class="av ${cls}" src="${esc(u)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(String(p?.nome || '?').charAt(0).toUpperCase())}</span>`; };
  const pessoa = (id) => E.equipe.find((p) => p.usuario_id === id);

  async function carregar() {
    const [eq, ro, fe, ta, me, lj, cd] = await Promise.all([
      sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome'),
      sb.from('central_rotinas').select('*').eq('ativo', true).order('ordem').order('criado_em'),
      sb.from('central_rotina_feitos').select('rotina_id, dia, usuario_id').gte('dia', segunda).lte('dia', sexta),
      sb.from('central_tarefas').select('*').or(`feita_em.is.null,feita_em.gte.${hoje}T00:00:00-03:00,and(prazo.gte.${segunda},prazo.lte.${sexta})`).order('prazo', { nullsFirst: false }).order('criado_em'),
      Promise.resolve(sb.rpc('metas_atualizar_auto')).catch(() => null).then(() => sb.from('central_metas').select('*').eq('mes', mes).order('atualizado_em')),
      sb.from('lojas').select('id, apelido').eq('marketplace', 'mercado_livre').eq('ativa', true).order('apelido'),
      sb.from('ml_codigos_dia').select('loja_id, codigo, recebido_em').eq('dia', hoje),
    ]);
    // o cartão do código do dia é um extra: se não carregar, some em vez de mostrar erro na tela inteira
    E.lojasML = lj.error || cd.error ? null : (lj.data || []); E.codigos = cd.data || [];
    E.erro = [eq, ro, fe, ta, me].some((r) => r.error) ? 'Não consegui carregar tudo. Atualize a página.' : '';
    E.equipe = eq.data || []; E.rotinas = ro.data || []; E.feitosSem = fe.data || []; E.feitos = new Set(E.feitosSem.filter((x) => x.dia === hoje).map((x) => x.rotina_id));
    E.tarefas = ta.data || []; E.metas = me.data || [];
    // subtarefas (checklist) das tarefas carregadas; se falhar, as tarefas seguem sem o contador
    const ids = E.tarefas.map((t) => t.id);
    const it = ids.length ? await sb.from('central_tarefa_itens').select('id, tarefa_id, texto, feito, ordem').in('tarefa_id', ids).order('ordem').order('criado_em') : { data: [] };
    E.itens = it.error ? [] : (it.data || []);
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
    const r = rotinaDe(user.id), rf = r.filter((x) => E.feitos.has(x.id)).length, ab = abertas(user.id);
    const ini = new Date(`${hoje}T00:00:00-03:00`).getTime();
    // tarefas do dia: as minhas sem data ou vencendo até hoje, ainda abertas ou concluídas hoje
    const doDia = E.tarefas.filter((t) => t.responsavel_id === user.id && (!t.prazo || t.prazo <= hoje) && (!t.feita_em || new Date(t.feita_em).getTime() >= ini));
    const tt = doDia.length, tf = doDia.filter((t) => t.feita_em).length;
    const hj = ab.filter((t) => !t.prazo || t.prazo === hoje).length, at = ab.filter(atrasada).length;
    const total = r.length + tt, f = rf + tf, falta = total - f, pct = total ? Math.round((f / total) * 100) : 0;
    const titulo = !total ? 'Nada marcado para hoje'
      : !falta ? (at ? 'Dia concluído' : 'Tudo em dia')
      : falta === 1 ? 'Falta 1 item hoje' : `Faltam ${falta} itens hoje`;
    const partes = [r.length ? `${rf} de ${r.length} da rotina` : '', tt ? `${tf} de ${tt} ${tt === 1 ? 'tarefa' : 'tarefas'}` : ''].filter(Boolean).join(' · ');
    const sub = at ? `${partes ? partes + ' · ' : ''}${at} ${at === 1 ? 'atrasada' : 'atrasadas'}`
      : partes || 'Monte sua rotina para acompanhar o dia aqui.';
    return { f, total, hj, at, pct, titulo, sub };
  }
  const rotH = (n) => (n === 1 ? 'tarefa<br>para hoje' : 'tarefas<br>para hoje'), rotA = (n) => (n === 1 ? 'atrasada' : 'atrasadas');
  function palco() {
    const R = resumo(); anel.t = R.total ? R.f / R.total : 0;
    return `<section class="card md-palco" aria-label="Seu dia">` +
      `<div class="md-anelbox"><svg class="md-anel" viewBox="0 0 120 120" role="img" aria-label="${R.f} de ${R.total} itens do dia feitos"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="10"/><circle id="md-anel" cx="60" cy="60" r="52" pathLength="1" fill="none" stroke="var(--destaque-claro)" stroke-width="10" stroke-linecap="round" stroke-dasharray="0 1" transform="rotate(-90 60 60)"/></svg>` +
      `<div class="md-anelnum"><b id="md-feitas">${R.f}</b><span>de ${R.total}</span></div></div>` +
      `<div class="md-palco-txt"><span class="md-rot">Seu dia</span><h2 class="md-tit" id="md-tit">${R.titulo}</h2><p class="md-sub" id="md-sub">${R.sub}</p></div>` +
      `<div class="md-stats"><div class="md-st"><b id="md-s-hj">${R.hj}</b><span id="md-s-hjt">${rotH(R.hj)}</span></div>` +
      `<div class="md-st${R.at ? ' ate' : ''}" id="md-s-atc"><b id="md-s-at">${R.at}</b><span id="md-s-att">${rotA(R.at)}</span></div>` +
      `<div class="md-st"><b id="md-s-pct">${R.pct}%</b><span>do dia<br>feito</span></div></div></section>`;
  }
  function atualizaPalco() {
    const R = resumo(), q = (i) => el.querySelector('#' + i); if (!q('md-feitas')) return;
    q('md-feitas').textContent = R.f; q('md-tit').textContent = R.titulo; q('md-sub').textContent = R.sub;
    q('md-s-hj').textContent = R.hj; q('md-s-hjt').innerHTML = rotH(R.hj); q('md-s-at').textContent = R.at; q('md-s-att').textContent = rotA(R.at);
    q('md-s-atc').classList.toggle('ate', !!R.at); q('md-s-pct').textContent = R.pct + '%';
    anel.t = R.total ? R.f / R.total : 0; acordar();
  }
  const fSem = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const ABR = ['seg', 'ter', 'qua', 'qui', 'sex'];
  // Rotina da semana: painel só para consultar. Marcar como feita só no dia, pela lista de Tarefas.
  // "Minha semana": quadro estilo Trello. Uma coluna por dia (segunda a sexta); os cartões são os itens da rotina daquele dia
  // e as tarefas minhas com data naquele dia. Dá para marcar em qualquer dia (adiantar); a lista de Tarefas mostra o mesmo.
  function qRotina() {
    const mine = E.rotinas.filter((r) => r.usuario_id === user.id);
    const minhas = E.tarefas.filter((t) => t.responsavel_id === user.id && t.prazo && t.prazo >= segunda && t.prazo <= sexta);
    const feito = (id, dia) => E.feitosSem.some((x) => x.rotina_id === id && x.dia === dia);
    const cols = ABR.map((ab, i) => {
      const dia = soma(segunda, i), eHoje = dia === hoje, passou = dia < hoje;
      const cards = [
        ...mine.filter((r) => (r.dias || []).includes(i + 1)).map((r) => ({ tipo: 'Rotina', on: feito(r.id, dia), attr: `data-rot="${r.id}" data-dia="${dia}"`, titulo: r.titulo })),
        ...minhas.filter((t) => t.prazo === dia).sort((a, b) => (PESO[b.importancia] ?? 1) - (PESO[a.importancia] ?? 1)).map((t) => ({ tipo: 'Tarefa', on: !!t.feita_em, attr: `data-tar="${t.id}"`, tid: t.id, titulo: t.titulo, imp: t.importancia || 'normal', selo: seloTarefa(t, E.itens) })),
      ].sort((a, b) => a.on - b.on);
      const feitas = cards.filter((c) => c.on).length;
      const lis = cards.map((c) => {
        const falta = passou && !c.on;
        return `<li class="kb-card ${c.tipo === 'Rotina' ? 'rot' : 'tar'}${c.on ? ' feita' : ''}${falta ? ' falta' : ''}"${c.tid ? ` data-tid="${c.tid}"` : ''}><button type="button" class="md-chk${c.on ? ' on' : ''}" ${c.attr} aria-pressed="${c.on}"><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(c.titulo)}</span></button>` +
          `<span class="kb-meta"><span class="kb-tipo">${svg(c.tipo === 'Rotina' ? IC.repetir : IC.tarefa, 12)}${c.tipo === 'Rotina' ? 'Rotina' : 'Avulsa'}</span>${c.imp && !c.on ? tagImp(c.imp) : ''}${c.selo || ''}${falta ? '<span class="kb-falta">Não feita</span>' : ''}</span></li>`;
      }).join('');
      return `<li class="kb-col${eHoje ? ' hoje' : ''}${passou ? ' passou' : ''}" data-dia="${dia}" aria-label="${DIAS_N[i + 1]}, ${dataDe(dia).getUTCDate()}"><div class="kb-cab"><b>${ABR[i]}</b><span class="kb-dia">${dataDe(dia).getUTCDate()}</span>${cards.length ? `<em class="kb-n">${feitas}/${cards.length}</em>` : ''}</div>` +
        (cards.length ? `<ul class="kb-cards">${lis}</ul>` : `<p class="kb-nada">Nada marcado</p>`) + `</li>`;
    }).join('');
    const faixa = `${fSem.format(dataDe(segunda)).replace('.', '')} a ${fSem.format(dataDe(sexta)).replace('.', '')}`;
    return `<section class="card md-rsem" aria-label="Minha semana"><div class="qcab"><span class="ico">${svg(IC.rotina)}</span><h2>Minha semana</h2><span class="rs-faixa">${esc(faixa)}</span><button class="ibtn p" type="button" data-editar="${user.id}" aria-label="Editar minha rotina" title="Editar minha rotina">${svg(IC.lapis, 18)}</button></div>` +
      (mine.length || minhas.length ? `<ol class="kb">${cols}</ol><p class="rs-dica">Marque aqui ou na lista de Tarefas, também para adiantar. Arraste uma tarefa avulsa para outro dia (no celular, segure e arraste).</p>` : `<div class="md-vazio listrado"><p>Nada para esta semana ainda.</p><button class="btn sec" type="button" data-editar="${user.id}">Montar rotina</button></div>`) + '</section>';
  }
  // Código de autorização do dia (Mercado Livre): chega por e-mail em cada loja e é gravado por ml-codigo-receber.
  // Sólido = código recebido; hachurado = ainda aguardando o e-mail. No fim de semana só aparece se algum código chegou.
  function qCodigos() {
    if (!E.lojasML || !E.lojasML.length) return '';
    const fimSem = dsem === 0 || dsem === 6;
    if (fimSem && !E.codigos.length) return '';
    const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
    const itens = E.lojasML.map((l) => {
      const c = E.codigos.find((x) => x.loja_id === l.id);
      const nome = esc(String(l.apelido).replace(/^Sandstride\s*/i, 'Loja '));
      if (!c) return `<li class="cd-it espera"><span class="cd-loja">${nome}</span><span class="cd-esp">Aguardando o e-mail</span></li>`;
      return `<li class="cd-it"><button type="button" class="cd-bt" data-cod="${esc(c.codigo)}" aria-label="Copiar o código da ${nome}: ${esc(c.codigo)}"><span class="cd-loja">${nome}</span><b class="cd-num">${esc(c.codigo)}</b><span class="cd-dica">${svg(IC.copiar, 14)}<span class="cd-t">Tocar para copiar</span> · chegou às ${esc(hora.format(new Date(c.recebido_em)))}</span></button></li>`;
    }).join('');
    return `<section class="card md-cod" aria-label="Código do dia do Mercado Livre"><div class="qcab"><span class="ico">${svg(IC.caixa)}</span><h2>Código do dia</h2><span class="cd-faixa">Coletas e devoluções · Mercado Livre</span></div><ul class="cd-lista">${itens}</ul></section>`;
  }
  const fimMesISO = () => new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7), 0)).toISOString().slice(0, 10);
  const filtroDe = (t) => (!t.prazo || t.prazo === hoje ? 'hoje' : t.prazo < hoje ? 'atrasadas' : t.prazo <= fimMesISO() ? 'mes' : 'depois');
  // o que aparece nas listas: tarefas minhas e as que eu criei para outras pessoas (não somem depois de criadas)
  const doMeu = (t) => t.responsavel_id === user.id || t.criado_por === user.id;
  function listaTarefas() {
    const fimMes = fimMesISO();
    const f = { hoje: (t) => doMeu(t) && (!t.prazo || t.prazo === hoje), atrasadas: (t) => doMeu(t) && atrasada(t), mes: (t) => doMeu(t) && t.prazo > hoje && t.prazo <= fimMes, depois: (t) => doMeu(t) && t.prazo > fimMes }[E.filtro];
    const ini = new Date(`${hoje}T00:00:00-03:00`).getTime();
    const l = E.tarefas.filter((t) => f(t) && (!t.feita_em || new Date(t.feita_em).getTime() >= ini) && (E.filtro !== 'atrasadas' || !t.feita_em)).sort((a, b) => (!!a.feita_em - !!b.feita_em) || ((a.prazo || hoje) < (b.prazo || hoje) ? -1 : (a.prazo || hoje) > (b.prazo || hoje) ? 1 : 0) || (PESO[b.importancia] ?? 1) - (PESO[a.importancia] ?? 1));
    const rot = E.filtro === 'hoje' ? rotinaDe(user.id).slice().sort((a, b) => E.feitos.has(a.id) - E.feitos.has(b.id)) : [];
    const lr = rot.map((r) => { const on = E.feitos.has(r.id); return `<li class="md-rotli"><button type="button" class="md-chk${on ? ' on' : ''}" data-rot="${r.id}" aria-pressed="${on}"><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(r.titulo)}</span></button><span class="tag rot">${svg(IC.rotina, 12)}Rotina</span></li>`; });
    if (!l.length && !lr.length) return `<div class="md-vazio"><p>${{ hoje: 'Nada para hoje.', atrasadas: 'Nada atrasado.', mes: 'Nada mais para este mês.', depois: 'Nada para os próximos meses.' }[E.filtro]}</p></div>`;
    const feitasT = l.filter((t) => t.feita_em), abertasT = l.filter((t) => !t.feita_em);
    const item = (t) => {
      const on = !!t.feita_em, meu = t.responsavel_id === user.id, pode = meu || t.criado_por === user.id || admin, p = pessoa(t.responsavel_id);
      const prazo = t.prazo ? `<span class="tag${atrasada(t) ? ' ate' : ''}">${svg(atrasada(t) ? IC.alerta : IC.relogio)}${t.prazo === hoje ? 'Hoje' : fCurto.format(dataDe(t.prazo))}</span>` : '';
      const imp = on ? '' : tagImp(t.importancia);
      return `<li><button type="button" class="md-chk${on ? ' on' : ''}" data-tar="${t.id}" aria-pressed="${on}"${pode ? '' : ' disabled'}><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(t.titulo)}</span></button>` +
        `${imp}${seloTarefa(t, E.itens)}${prazo}${!meu && p ? `<span class="md-quem" title="${esc(p.nome)}">${av(p, 'p')}</span>` : ''}${pode ? `<button class="md-x md-ed" type="button" data-edit="${t.id}" aria-label="Editar tarefa" title="Editar">${svg(IC.lapis, 14)}</button>` : ''}${t.criado_por === user.id || admin ? `<button class="md-x" type="button" data-apaga="${t.id}" aria-label="Apagar tarefa">${svg(IC.x, 14)}</button>` : ''}</li>`;
    };
    const feitasR = lr.filter((x) => x.includes(' on"')), abertasR = lr.filter((x) => !x.includes(' on"'));
    return `<ul class="md-lista">${abertasT.map(item).join('')}${abertasR.join('')}${feitasT.map(item).join('')}${feitasR.join('')}</ul>`;
  }
  function qTarefas() {
    const ab = E.tarefas.filter((t) => doMeu(t) && !t.feita_em), fim = fimMesISO();
    const n = { hoje: ab.filter((t) => !t.prazo || t.prazo === hoje).length + rotinaDe(user.id).filter((r) => !E.feitos.has(r.id)).length, atrasadas: ab.filter(atrasada).length, depois: ab.filter((t) => t.prazo > fim).length };
    const bt = (v, r) => `<button type="button" data-f="${v}" class="${E.filtro === v ? 'on' : ''}" aria-pressed="${E.filtro === v}">${r}${n[v] ? `<i>${n[v]}</i>` : ''}</button>`;
    return `<section class="card md-tarefas" aria-label="Tarefas"><div class="qcab"><span class="ico">${svg(IC.tarefa)}</span><h2>Tarefas</h2>` +
      `<button class="btn pri md-mais" type="button" data-pop="abre" aria-label="Nova tarefa" aria-haspopup="dialog">${svg(IC.mais)}</button></div>` +
      `<div class="md-filtros" role="group" aria-label="Filtro">${bt('hoje', 'Hoje')}${bt('atrasadas', 'Atrasadas')}${bt('mes', 'Mês')}${n.depois || E.filtro === 'depois' ? bt('depois', 'Depois') : ''}</div>` +
      `<div id="md-tarefas">${listaTarefas()}</div></section>`;
  }
  function qMetas() {
    const cards = E.metas.map((m) => {
      const desce = m.sentido === 'descer', pct = desce ? (m.atual > 0 ? Math.min(1, m.alvo / m.atual) : 0) : Math.max(0, Math.min(1, m.atual / m.alvo));
      if (!medidores.has(m.id)) medidores.set(m.id, S(0, 140, 20)); medidores.get(m.id).t = pct;
      const p = m.responsavel_id && pessoa(m.responsavel_id);
      return `<div class="md-meta"><div class="md-meta-cab"><b>${esc(m.titulo)}</b>${m.fonte && m.fonte !== 'manual' ? `<span class="tag" title="Atualiza sozinha a cada 10 minutos">${svg(IC.repetir, 12)}Automática</span>` : ''}${p ? `<span class="md-quem" title="${esc(p.nome)}">${av(p, 'p')}</span>` : ''}${admin ? `<button class="ibtn p" type="button" data-meta="${m.id}" aria-label="Atualizar meta">${svg(IC.lapis)}</button>` : ''}</div>` +
        `<div class="md-med"><svg viewBox="0 0 200 112" aria-hidden="true"><path d="M20 100A80 80 0 0 1 180 100" fill="none" stroke="var(--elevado)" stroke-width="14" stroke-linecap="round"/><path data-arco="${m.id}" d="M20 100A80 80 0 0 1 180 100" pathLength="1" fill="none" stroke="${pct >= 1 ? 'var(--recebido)' : 'var(--destaque)'}" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 1"/></svg><b data-pct="${m.id}">0%</b></div>` +
        `<p class="md-meta-v"><b>${valor(m.atual, m.unidade)}</b> ${desce ? `· meta: até ${valor(m.alvo, m.unidade)}` : `de ${valor(m.alvo, m.unidade)}`}</p></div>`;
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
      const pend = ord.length ? `<ul class="md-pend">${ver.map((t) => `<li><button type="button" class="tx md-pt" data-edit="${t.id}" title="Abrir e editar">${esc(t.titulo)}</button>${t.importancia === 'alta' ? '<span class="tag alta">Alta</span>' : ''}${t.prazo ? `<span class="tag${atrasada(t) ? ' ate' : ''}">${svg(atrasada(t) ? IC.alerta : IC.relogio)}${t.prazo === hoje ? 'Hoje' : fCurto.format(dataDe(t.prazo))}</span>` : '<span class="tag">Sem data</span>'}<button class="md-x md-ed" type="button" data-edit="${t.id}" aria-label="Editar tarefa de ${esc(prim(p.nome))}" title="Editar">${svg(IC.lapis, 14)}</button></li>`).join('')}</ul>` +
        (ord.length > 3 ? `<button class="md-mais-t" type="button" data-todas="${p.usuario_id}">${E.aberta.has(p.usuario_id) ? 'Mostrar menos' : `Ver as ${ord.length} tarefas`}</button>` : '') : '<p class="md-pend-vazio">Nenhuma tarefa aberta.</p>';
      return `<li class="md-pes"><div class="md-lin"><div class="pessoa">${av(p)}<div><b>${esc(p.nome)}</b><br><span class="sub">${r.length ? `${f} de ${r.length} da rotina` : 'sem rotina hoje'}</span></div></div>` +
        `<div class="md-barra${r.length ? '' : ' listrado'}" aria-hidden="true"><span style="width:${pct}%"></span></div>` +
        `<span class="tag">${svg(IC.tarefa)}${ab.length} ${ab.length === 1 ? 'aberta' : 'abertas'}</span>${at ? `<span class="tag ate">${svg(IC.alerta)}${at}</span>` : '<span class="md-sp"></span>'}` +
        `<button class="ibtn p" type="button" data-editar="${p.usuario_id}" aria-label="Editar rotina de ${esc(p.nome)}" title="Editar rotina">${svg(IC.lapis)}</button></div>` +
        `<div class="md-pendentes"><span class="md-rot">Pendente</span>${pend}</div></li>`;
    }).join('');
    const tot = E.equipe.reduce((n, p) => n + abertas(p.usuario_id).length, 0), atr = E.equipe.reduce((n, p) => n + abertas(p.usuario_id).filter(atrasada).length, 0);
    const resumo = `<span class="tag">${svg(IC.tarefa)}${tot} ${tot === 1 ? 'aberta' : 'abertas'}</span>${atr ? `<span class="tag ate">${svg(IC.alerta)}${atr}</span>` : ''}`;
    return `<section class="card md-eq${E.eqAberta ? ' on' : ''}" aria-label="Equipe hoje"><button class="md-eqbt" id="md-eqbt" type="button" data-eq="1" aria-expanded="${E.eqAberta}" aria-controls="md-eqcorpo"><span class="ico">${svg(IC.equipe)}</span><h2>Equipe hoje</h2>${E.eqAberta ? '' : resumo}<span class="md-chev" aria-hidden="true">${svg('<path d="M6 9l6 6 6-6"/>', 18)}</span></button>` +
      (E.eqAberta ? `<ul class="md-equipe" id="md-eqcorpo">${linhas}</ul>` : '') + '</section>';
  }

  function desenhar() {
    const e = E.primeira ? ' entra' : ''; let n = 0; const o = () => (E.primeira ? ` style="--o:${n++}"` : '');
    const foco = document.activeElement?.id;
    const kbAntes = el.querySelector('.kb'); const kbX = kbAntes ? kbAntes.scrollLeft : null;
    const pA = `<div class="pg-cab${e}"${o()}><h1>${saudacao()}, ${esc(prim(eu.nome))}.</h1><p class="sub md-data">${esc(fDia.format(dataDe(hoje)))}</p></div>` +
      (E.erro ? `<p class="erro" role="alert">${svg(IC.alerta)}<span>${esc(E.erro)}</span></p>` : '') +
      `<div class="${e.trim()}"${o()}>${palco()}</div>` + (qCodigos() ? `<div class="${e.trim()} md-cod-w"${o()}>${qCodigos()}</div>` : '') + `<div class="${e.trim()}"${o()}>${qRotina()}</div>`;
    const pE = `<div class="${e.trim()}"${o()}>${qTarefas()}</div><div class="${e.trim()}"${o()}>${qMetas()}</div>`;
    const pB = (admin ? `<div class="${e.trim()}"${o()}>${qEquipe()}</div>` : '');
    el.querySelector('#md-a').innerHTML = pA; el.querySelector('#md-e').innerHTML = pE; el.querySelector('#md-b').innerHTML = pB;
    const kb = el.querySelector('.kb');
    if (kb && kb.scrollWidth > kb.clientWidth) { const h = kb.querySelector('.kb-col.hoje'); kb.scrollLeft = kbX !== null ? kbX : (h ? h.offsetLeft - kb.offsetLeft : 0); }
    if (foco && el.querySelector('#' + foco)) el.querySelector('#' + foco).focus();
    E.primeira = false; acordar();
  }
  const falhou = (msg) => { E.erro = msg; desenhar(); };

  // ---- ações
  el.addEventListener('click', async (ev) => {
    // tarefa: clicar em qualquer ponto do cartão/linha abre os detalhes; só o círculo marca como concluída
    const cartao = ev.target.closest('.kb-card.tar[data-tid], .md-lista li:has([data-tar])');
    if (cartao && !ev.target.closest('.cx, .md-x, .md-quem') && !(ev.target.closest('button') && ev.target.closest('button').dataset.tar && ev.detail === 0)) {
      const id = cartao.dataset.tid || cartao.querySelector('[data-tar]')?.dataset.tar; if (id) { janelaTarefa(id); return; }
    }
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.rot) {
      const id = b.dataset.rot, dia = b.dataset.dia || hoje, on = !E.feitosSem.some((x) => x.rotina_id === id && x.dia === dia);
      const aplica = (v) => {
        E.feitosSem = v ? [...E.feitosSem, { rotina_id: id, dia, usuario_id: user.id }] : E.feitosSem.filter((x) => !(x.rotina_id === id && x.dia === dia));
        E.feitos = new Set(E.feitosSem.filter((x) => x.dia === hoje).map((x) => x.rotina_id));
      };
      aplica(on); marcar(b, on); atualizaPalco();
      const { error } = on ? await sb.from('central_rotina_feitos').insert({ rotina_id: id, dia, usuario_id: user.id }) : await sb.from('central_rotina_feitos').delete().eq('rotina_id', id).eq('dia', dia);
      if (error) { aplica(!on); falhou('Não consegui salvar a marcação. Tente de novo.'); } else setTimeout(desenhar, 700);
    } else if (b.dataset.tar) {
      const t = E.tarefas.find((x) => x.id === b.dataset.tar); if (!t) return;
      const antes = t.feita_em; t.feita_em = antes ? null : new Date().toISOString(); marcar(b, !!t.feita_em); atualizaPalco();
      const { error } = await sb.from('central_tarefas').update({ feita_em: t.feita_em }).eq('id', t.id);
      if (error) { t.feita_em = antes; atualizaPalco(); falhou('Não consegui salvar a tarefa. Tente de novo.'); } else setTimeout(desenhar, 700);
    } else if (b.dataset.apaga) {
      const i = E.tarefas.findIndex((x) => x.id === b.dataset.apaga); if (i < 0) return;
      const [t] = E.tarefas.splice(i, 1); desenhar();
      const { error } = await sb.from('central_tarefas').delete().eq('id', t.id);
      if (error) { E.tarefas.splice(i, 0, t); falhou('Não consegui apagar a tarefa.'); }
    } else if (b.dataset.edit) {
      janelaTarefa(b.dataset.edit);
    } else if (b.dataset.pop) janelaNova();
    else if (b.dataset.todas) { const u = b.dataset.todas; if (E.aberta.has(u)) E.aberta.delete(u); else E.aberta.add(u); desenhar(); }
    else if (b.dataset.eq) { E.eqAberta = !E.eqAberta; desenhar(); }
    else if (b.dataset.cod) {
      const cod = b.dataset.cod, t = b.querySelector('.cd-t');
      const ok = () => { if (t) { t.textContent = 'Copiado'; setTimeout(() => { if (t.isConnected) t.textContent = 'Tocar para copiar'; }, 1800); } };
      const velho = () => { const x = document.createElement('textarea'); x.value = cod; x.setAttribute('readonly', ''); x.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(x); x.select(); try { document.execCommand('copy'); ok(); } catch (_) { /* sem permissão */ } x.remove(); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cod).then(ok, velho); else velho();
    }
    else if (b.dataset.f) { E.filtro = b.dataset.f; desenhar(); }
    else if (b.dataset.editar) janelaRotina(b.dataset.editar);
    else if (b.dataset.meta) janelaMeta(b.dataset.meta);
  });
  function marcar(b, on) {
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (on) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 600); }
  }
  // ---- arrastar tarefa avulsa para outro dia do quadro (mouse: arrastar; toque: segurar e arrastar)
  let dr = null, supr = false;
  const colSob = (x, y) => document.elementsFromPoint(x, y).find((e) => e.classList?.contains('kb-col'));
  function fimDrag(solta, x, y) {
    if (!dr) return; const d = dr; dr = null; clearTimeout(d.timer); clearInterval(d.rolar);
    document.body.classList.remove('kb-arrastando'); d.card.classList.remove('arrasta'); d.ghost?.remove();
    el.querySelectorAll('.kb-col.alvo').forEach((c) => c.classList.remove('alvo'));
    if (!d.ativo) return;
    supr = true; setTimeout(() => { supr = false; }, 80);
    const col = solta ? colSob(x, y) : null, t = E.tarefas.find((z) => z.id === d.id);
    if (col && t && !col.classList.contains('passou') && col.dataset.dia && col.dataset.dia !== t.prazo) moverTarefa(t, col.dataset.dia);
  }
  async function moverTarefa(t, dia) {
    const antes = t.prazo; t.prazo = dia; desenhar();
    const { error } = await sb.from('central_tarefas').update({ prazo: dia }).eq('id', t.id);
    if (error) { t.prazo = antes; desenhar(); falhou('Não consegui mudar o dia da tarefa. Tente de novo.'); }
  }
  function iniciaDrag(d) {
    d.ativo = true; navigator.vibrate?.(8);
    const r = d.card.getBoundingClientRect(); d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
    d.ghost = d.card.cloneNode(true); d.ghost.classList.add('kb-ghost'); d.ghost.style.width = r.width + 'px'; document.body.appendChild(d.ghost);
    d.card.classList.add('arrasta'); document.body.classList.add('kb-arrastando'); move(d.x0, d.y0);
    const kb = el.querySelector('.kb');
    d.rolar = setInterval(() => { if (!kb || !d.dir) return; kb.scrollLeft += d.dir * 14; }, 16);
  }
  function move(x, y) {
    const d = dr; if (!d || !d.ativo) return;
    d.ghost.style.left = x - d.dx + 'px'; d.ghost.style.top = y - d.dy + 'px';
    const col = colSob(x, y);
    el.querySelectorAll('.kb-col.alvo').forEach((c) => { if (c !== col) c.classList.remove('alvo'); });
    if (col && !col.classList.contains('passou')) col.classList.add('alvo');
    const kb = el.querySelector('.kb'), kr = kb?.getBoundingClientRect();
    d.dir = kr && kb.scrollWidth > kb.clientWidth ? (x < kr.left + 44 ? -1 : x > kr.right - 44 ? 1 : 0) : 0;
  }
  el.addEventListener('pointerdown', (ev) => {
    const card = ev.target.closest('.kb-card.tar'); if (!card || ev.button > 0 || dr) return;
    dr = { card, id: card.dataset.tid, x0: ev.clientX, y0: ev.clientY, touch: ev.pointerType !== 'mouse', ativo: false };
    if (dr.touch) { const d = dr; d.timer = setTimeout(() => { if (dr === d) iniciaDrag(d); }, 350); }
  });
  document.addEventListener('pointermove', (ev) => {
    if (!dr) return;
    if (!dr.ativo) {
      const dist = Math.hypot(ev.clientX - dr.x0, ev.clientY - dr.y0);
      if (dr.touch) { if (dist > 10) { clearTimeout(dr.timer); dr = null; } } else if (dist > 5) iniciaDrag(dr);
      return;
    }
    move(ev.clientX, ev.clientY);
  });
  document.addEventListener('pointerup', (ev) => fimDrag(true, ev.clientX, ev.clientY));
  document.addEventListener('pointercancel', () => { if (dr && !dr.ativo) { clearTimeout(dr.timer); dr = null; } else fimDrag(false); });
  document.addEventListener('touchmove', (ev) => { if (dr?.ativo) ev.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && dr?.ativo) fimDrag(false); });
  el.addEventListener('click', (ev) => { if (supr) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  // dois cliques no campo de data preenchem a data de hoje
  el.addEventListener('dblclick', (ev) => {
    const d = ev.target.closest('input[type=date]'); if (!d || d.value) return;
    d.value = hoje; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // ---- nova tarefa (janela): nome, responsáveis (vários ou Todos), data e importância
  function janelaNova() {
    const R = { titulo: '', prazo: '', imp: 'normal' }, est = novoEstado(user.id);
    const imp = (v, r) => `<button type="button" data-nimp="${v}" class="${R.imp === v ? 'on' : ''}" aria-pressed="${R.imp === v}">${r}</button>`;
    const d = janela(`<form class="td" id="md-nova" novalidate><div class="qcab"><span class="ico">${svg(IC.tarefa)}</span><h2>Nova tarefa</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<label class="campo"><span class="rot">Nome da tarefa</span><input class="md-in" id="md-titulo" maxlength="160" autocomplete="off"></label>` +
      `<div class="campo"><span class="rot">Responsáveis</span><div id="md-resp">${chipsResp(E.equipe, user.id, est, prim, esc)}</div></div>` +
      `<div class="td-lin"><label class="campo"><span class="rot">Data</span><input class="md-in" id="md-prazo" type="date" min="${hoje}"></label>` +
      `<div class="campo"><span class="rot">Importância</span><div class="md-imp" role="group" aria-label="Importância">${imp('baixa', 'Baixa')}${imp('normal', 'Normal')}${imp('alta', 'Alta')}</div></div></div>` +
      `<label class="campo"><span class="rot">Descrição</span><textarea class="md-in td-desc" id="md-desc" rows="3" maxlength="4000" placeholder="Adicione uma descrição mais detalhada..."></textarea></label>` +
      `<p class="erro" role="alert" id="md-erro-n" hidden></p>` +
      `<div class="md-acoes"><button class="btn" type="button" data-fecha>Cancelar</button><button class="btn pri" type="submit" id="md-criar">Criar tarefa</button></div></form>`);
    const tit = d.querySelector('#md-titulo'), dp = d.querySelector('#md-prazo'), erro = d.querySelector('#md-erro-n'), box = d.querySelector('#md-resp');
    tit.focus();
    dp.addEventListener('dblclick', () => { if (!dp.value) { dp.value = hoje; R.prazo = hoje; } });
    dp.addEventListener('change', () => { R.prazo = dp.value; });
    d.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.rp) { alternaResp(est, b.dataset.rp, user.id); box.innerHTML = chipsResp(E.equipe, user.id, est, prim, esc); box.querySelector(`[data-rp="${b.dataset.rp}"]`)?.focus(); }
      else if (b.dataset.nimp) { R.imp = b.dataset.nimp; d.querySelectorAll('[data-nimp]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); }
    });
    const criar = botaoAcao(d.querySelector('#md-criar'), { ok: 'Criada', carregando: 'Criando…' });
    d.querySelector('#md-nova').addEventListener('submit', (ev) => {
      ev.preventDefault(); const titulo = tit.value.trim(); if (!titulo) { tit.focus(); return; }
      erro.hidden = true;
      criar.rodar(async () => {
        const donos = donosDe(est, E.equipe);
        const linhas = donos.map((u) => ({ titulo, responsavel_id: u, prazo: R.prazo || null, importancia: R.imp, descricao: d.querySelector('#md-desc').value.trim() || null, criado_por: user.id }));
        const { data: criadas, error } = await sb.from('central_tarefas').insert(linhas).select();
        if (error || !criadas?.length) { erro.hidden = false; erro.textContent = 'Não consegui criar a tarefa. Tente de novo.'; return false; }
        E.tarefas.push(...criadas); E.filtro = filtroDe(criadas.find((t) => t.responsavel_id === user.id) || criadas[0]);
        setTimeout(() => d.close(), 2600); return true;
      });
    });
  }

  // ---- detalhes da tarefa: título, responsável, data, importância, descrição e subtarefas
  function janelaTarefa(id) {
    const t = E.tarefas.find((x) => x.id === id); if (!t) return;
    abrirDetalheTarefa({ sb, user, admin, equipe: E.equipe, tarefa: t, itens: E.itens, aoFechar: desenhar, aoFalhar: falhou, aoApagar: (x) => { E.tarefas = E.tarefas.filter((y) => y.id !== x.id); } });
  }

  // ---- janelas (rotina de uma pessoa, meta)
  function janela(html) {
    document.getElementById('md-dlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'md-dlg'; d.className = 'md-dlg'; d.innerHTML = html; document.body.appendChild(d);
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-fecha]')) d.close(); });
    d.addEventListener('close', () => { d.remove(); desenhar(); });
    document.documentElement.classList.add('sh-trava');
    d.addEventListener('close', () => document.documentElement.classList.remove('sh-trava'), { once: true });
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
      lista.innerHTML = l.length ? l.map((r) => `<li><span class="tx">${esc(r.titulo)}</span><span class="md-dias" role="group" aria-label="Dias da semana">${DIAS.map((x, i) => (i === 0 || i === 6) ? '' : `<button type="button" data-r="${r.id}" data-d="${i}" class="${r.dias.includes(i) ? 'on' : ''}" aria-pressed="${r.dias.includes(i)}" aria-label="${DIAS_N[i]}">${x}</button>`).join('')}</span><button class="md-x" type="button" data-tira="${r.id}" aria-label="Remover item">${svg(IC.x, 14)}</button></li>`).join('') : '<li class="md-vazio"><p>Nenhum item ainda.</p></li>';
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
      const { data, error } = await sb.from('central_rotinas').insert({ usuario_id: uid, titulo, dias: [1, 2, 3, 4, 5], ordem: E.rotinas.filter((r) => r.usuario_id === uid).length }).select().single();
      if (error || !data) return falha('Não consegui adicionar o item.');
      E.rotinas.push(data); pinta(); t.focus();
    });
  }
  function janelaMeta(id) {
    const m = id === 'nova' ? null : E.metas.find((x) => x.id === id);
    const d = janela(`<form id="md-meta-f"><div class="qcab"><span class="ico">${svg(IC.meta)}</span><h2>${m ? 'Atualizar meta' : 'Nova meta'}</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<label class="campo"><span class="rot">Meta</span><input id="mm-t" maxlength="80" required value="${esc(m?.titulo || '')}" placeholder="Ex.: Pares vendidos"></label>` +
      `<label class="campo"><span class="rot">De onde vem o número</span><select id="mm-f" class="md-in">${[['manual', 'Eu atualizo à mão'], ['faturamento', 'Faturamento do mês (automático)'], ['lucro', 'Lucro do mês (automático)'], ['pedidos', 'Pedidos do mês (automático)'], ['pares', 'Pares vendidos no mês (automático)'], ['custo_ads_pedido', 'Custo de ads por pedido (automático, do Gestor de Ads)'], ['gasto_ads', 'Gasto com ads no mês (automático, do Gestor de Ads)']].map(([v, r]) => `<option value="${v}"${(m?.fonte || 'manual') === v ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<label class="campo"><span class="rot">O que é melhor</span><select id="mm-s" class="md-in">${[['subir', 'Quanto maior, melhor (chegar a esse número ou mais)'], ['descer', 'Quanto menor, melhor (ficar nesse número ou menos)']].map(([v, r]) => `<option value="${v}"${(m?.sentido || 'subir') === v ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Medida</span><select id="mm-u" class="md-in">${[['un', 'Quantidade'], ['reais', 'Reais (R$)'], ['pct', 'Porcentagem (%)']].map(([v, r]) => `<option value="${v}"${m?.unidade === v ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<label class="campo"><span class="rot">Responsável</span><select id="mm-r" class="md-in"><option value="">Toda a empresa</option>${E.equipe.map((p) => `<option value="${p.usuario_id}"${m?.responsavel_id === p.usuario_id ? ' selected' : ''}>${esc(prim(p.nome))}</option>`).join('')}</select></label></div>` +
      `<div class="md-duo"><label class="campo" id="mm-aw"><span class="rot">Onde estamos</span><input id="mm-a" inputmode="decimal" required value="${m ? String(m.atual).replace('.', ',') : '0'}"></label><label class="campo"><span class="rot">Onde queremos chegar</span><input id="mm-v" inputmode="decimal" required value="${m ? String(m.alvo).replace('.', ',') : ''}"></label></div>` +
      `<p class="sub" id="mm-auto" hidden>O número vem do sistema (vendas e Gestor de Ads) e se atualiza sozinho a cada 10 minutos. Você só define onde queremos chegar.</p>` +
      `<p class="erro" id="mm-erro" role="alert" hidden></p><div class="md-acoes">${m ? '<button class="btn sec" type="button" id="mm-apaga">Apagar meta</button>' : ''}<span class="md-sp"></span><button class="btn sec" type="button" data-fecha>Cancelar</button><button class="btn pri" type="submit">Salvar</button></div></form>`);
    const num = (s) => { const v = String(s).trim().replace(/\./g, '').replace(',', '.'); return v === '' ? NaN : Number(v); };
    const erro = d.querySelector('#mm-erro'), falha = (t) => { erro.hidden = false; erro.textContent = t; };
    const sincFonte = () => {
      const f = d.querySelector('#mm-f').value, auto = f !== 'manual', u = d.querySelector('#mm-u');
      d.querySelector('#mm-aw').hidden = auto; d.querySelector('#mm-auto').hidden = !auto;
      if (auto) u.value = ['faturamento', 'lucro', 'custo_ads_pedido', 'gasto_ads'].includes(f) ? 'reais' : 'un';
      u.disabled = auto; d.querySelector('#mm-a').required = !auto;
    };
    d.querySelector('#mm-f').addEventListener('change', () => { sincFonte(); const f = d.querySelector('#mm-f').value; if (f === 'custo_ads_pedido' || f === 'gasto_ads') d.querySelector('#mm-s').value = 'descer'; else if (f !== 'manual') d.querySelector('#mm-s').value = 'subir'; }); sincFonte();
    d.querySelector('#md-meta-f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reg = { titulo: d.querySelector('#mm-t').value.trim(), unidade: d.querySelector('#mm-u').value, responsavel_id: d.querySelector('#mm-r').value || null, fonte: d.querySelector('#mm-f').value, sentido: d.querySelector('#mm-s').value, atual: num(d.querySelector('#mm-a').value), alvo: num(d.querySelector('#mm-v').value), atualizado_em: new Date().toISOString() };
      if (reg.fonte !== 'manual') reg.atual = 0;
      if (!reg.titulo) return falha('Dê um nome para a meta.');
      if (!(reg.alvo > 0) || (reg.fonte === 'manual' && !(reg.atual >= 0))) return falha('Use números: onde estamos (0 ou mais) e onde queremos chegar (maior que 0).');
      const q = m ? sb.from('central_metas').update(reg).eq('id', m.id).select().single() : sb.from('central_metas').insert({ ...reg, mes }).select().single();
      let { data, error } = await q;
      if (error || !data) return falha('Não consegui salvar a meta. Tente de novo.');
      if (data.fonte !== 'manual') { await sb.rpc('metas_atualizar_auto'); const n = await sb.from('central_metas').select('*').eq('id', data.id).single(); if (n.data) data = n.data; }
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
