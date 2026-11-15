// Central: caixa de ideias. Anota do jeito que vier; a IA propõe meta, tarefas e prioridade; a pessoa aprova item por item.
// Componentes (biblioteca de motions): Prompt box, Goo thinking, Streaming reply (designbookmark.com, molas iguais)
// e Tool approval (Kokonut UI, MIT) refeitos em JavaScript puro com as cores do sistema.
import { S, ajustar, passo, parada, limitar, registrar, acordar, depois, cancelar } from './molas.js';
import { esc, svg, IC, dataDe, fCurto, valor } from './meudia.js';
import { base } from './gestao.js';

const ID = {
  ideia: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  seta: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  dir: '<path d="M9 6l6 6-6 6"/>',
  bandeira: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};
const reduz = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const M = (x, k, c) => { const s = S(x, k, c); ajustar(s, k, c); return s; };
const anima = (el, kf, ms = 220) => { try { return el.animate(kf, { duration: reduz() ? 0 : ms, easing: 'cubic-bezier(.23,1,.32,1)' }).finished.catch(() => {}); } catch { return Promise.resolve(); } };
const fMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
const fData = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'America/Sao_Paulo' });
const prim = (n) => String(n || '').split(' ')[0];
const IMP = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta' };
const ROT_TIPO = { tarefa: 'Criar uma tarefa', meta: 'Criar uma meta do mês', prioridade: 'Criar uma prioridade do trimestre' };
const ICO_TIPO = { tarefa: IC.tarefa, meta: IC.meta, prioridade: ID.bandeira };
const PAD_X = 16, PAD_Y = 10;

export async function montarIdeias(ctx) {
  const { el } = ctx, B = base(ctx), { sb, user } = B, admin = B.admin;
  const [eq, lista] = await Promise.all([B.equipe(), sb.from('central_ideias').select('*').order('criado_em', { ascending: false })]);
  const E = { equipe: eq, ideias: lista.data || [], aberta: null, ia: (() => { try { return localStorage.getItem('sandstride-ideias-ia') !== '0'; } catch { return true; } })(), busy: false, ficha: 'abertas', fio: null, erro: lista.error ? 'Não consegui carregar as ideias.' : '' };
  const pessoa = (id) => E.equipe.find((p) => p.usuario_id === id);
  const nome = (id) => (id === user.id ? 'Você' : prim(pessoa(id)?.nome) || '—');
  const ideiaDe = (id) => E.ideias.find((i) => i.id === id);
  const salvarProposta = (i) => sb.from('central_ideias').update({ proposta: i.proposta, atualizado_em: new Date().toISOString() }).eq('id', i.id);

  // ---------------------------------------------------------------- esqueleto
  el.innerHTML =
    `<div class="pg-cab"><h1>Ideias</h1><p class="sub">Anote do jeito que vier. A IA propõe o que fazer e você aprova.</p></div>` +
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="id-goo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/><feColorMatrix in="b" mode="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -8"/></filter></svg>` +
    `<section class="card id-caixa" aria-label="Nova ideia"><div class="qcab"><span class="ico">${svg(ID.ideia)}</span><h2>Caixa de ideias</h2></div>` +
    `<div class="id-pb"><div class="id-status" id="id-status" aria-live="polite"><span class="mark"></span><span class="label" id="id-status-t">Pensando</span></div>` +
    `<div class="id-row"><textarea id="id-campo" rows="1" maxlength="2000" placeholder="Qual é a ideia?" aria-label="Nova ideia"></textarea>` +
    `<button class="id-envia" id="id-envia" type="button" aria-label="Enviar ideia"><i class="seta">${svg(ID.seta, 16)}</i><i class="para"></i></button></div></div>` +
    `<label class="id-ia"><input type="checkbox" id="id-ia"${E.ia ? ' checked' : ''}><span class="tr" aria-hidden="true"></span><span>A IA organiza ao enviar</span></label></section>` +
    `<section class="card id-fio" id="id-fio" hidden aria-label="Conversa da ideia"></section>` +
    `<section class="card" aria-label="Todas as ideias"><div class="qcab"><span class="ico">${svg(IC.rotina)}</span><h2>Todas as ideias</h2></div>` +
    `<div class="md-filtros" id="id-filtros" role="group" aria-label="Filtro"></div><div id="id-lista"></div></section>`;
  const $ = (s) => el.querySelector(s);

  // ---------------------------------------------------------------- lista de ideias
  const pend = (i) => (i.proposta?.itens || []).filter((x) => x.estado === 'pendente' || x.estado === 'criando').length;
  const situacao = (i) => {
    if (i.estado === 'descartada') return 'descartada';
    const n = i.proposta?.itens?.length || 0;
    if (n && !pend(i)) return 'resolvida';
    if (n) return 'aprovar';
    return i.estado === 'guardada' ? 'guardada' : 'nova';
  };
  function pintaLista() {
    const sit = E.ideias.map((i) => [i, situacao(i)]);
    const ab = sit.filter(([, s]) => s === 'nova' || s === 'aprovar' || s === 'guardada'), re = sit.filter(([, s]) => s === 'resolvida'), de = sit.filter(([, s]) => s === 'descartada');
    const bt = (v, r, n) => `<button type="button" data-ficha="${v}" class="${E.ficha === v ? 'on' : ''}" aria-pressed="${E.ficha === v}">${r}${n ? `<i>${n}</i>` : ''}</button>`;
    $('#id-filtros').innerHTML = bt('abertas', 'Abertas', ab.length) + bt('resolvidas', 'Resolvidas', 0) + bt('descartadas', 'Descartadas', 0);
    const l = { abertas: ab, resolvidas: re, descartadas: de }[E.ficha];
    const TAG = { nova: '<span class="tag listrado">Nova</span>', guardada: '<span class="tag">Guardada</span>', resolvida: `<span class="tag rec">${svg(IC.check)}Resolvida</span>`, descartada: '<span class="tag">Descartada</span>' };
    $('#id-lista').innerHTML = l.length
      ? `<ul class="md-lista id-lista">${l.map(([i, s]) => { const p = pessoa(i.autor_id); return `<li><button type="button" class="id-item${E.aberta === i.id ? ' on' : ''}" data-abre="${i.id}"><span class="tx">${esc(i.texto)}</span></button>` +
        `${s === 'aprovar' ? `<span class="tag ate">${pend(i)} para aprovar</span>` : TAG[s]}<span class="id-qd">${esc(i.criado_em ? fData.format(new Date(i.criado_em)).replace('.', '') : 'agora')}</span>${i.autor_id !== user.id && p ? `<span class="md-quem" title="${esc(p.nome)}">${B.av(p, 'p')}</span>` : ''}` +
        `${i.autor_id === user.id || admin ? `<button class="md-x" type="button" data-apaga="${i.id}" aria-label="Apagar ideia">${svg(IC.x, 14)}</button>` : ''}</li>`; }).join('')}</ul>`
      : `<div class="md-vazio${E.ficha === 'abertas' ? ' listrado' : ''}"><p>${{ abertas: 'Nenhuma ideia aberta. Anote a primeira acima.', resolvidas: 'Nada resolvido ainda.', descartadas: 'Nada descartado.' }[E.ficha]}</p></div>`;
  }
  pintaLista();

  // ---------------------------------------------------------------- Prompt box
  const campo = $('#id-campo'), envia = $('#id-envia'), status = $('#id-status'), statusT = $('#id-status-t');
  const seta = envia.querySelector('.seta'), para = envia.querySelector('.para');
  const H = M(22, 420, 34), SH = M(0, 380, 30), Bt = M(0, 520, 30);
  registrar({
    quadro(dt) { [H, SH, Bt].forEach((s) => passo(s, dt)); },
    desenhar() {
      campo.style.height = H.x.toFixed(2) + 'px';
      status.style.height = (Math.max(0, SH.x) * 30).toFixed(2) + 'px'; status.style.opacity = limitar(SH.x, 0, 1).toFixed(3);
      const m = limitar(Bt.x, 0, 1.2);
      seta.style.transform = `scale(${Math.max(0, 1 - m)}) rotate(${m * 90}deg)`; para.style.transform = `scale(${Math.max(0, m)})`;
    },
    ativo() { return ![H, SH, Bt].every((s) => parada(s, 0.01)); },
    fim() { return !el.isConnected; },
  });
  function ajusta() {
    campo.style.height = 'auto'; H.t = Math.min(campo.scrollHeight, 88); campo.style.height = H.x + 'px';
    envia.classList.toggle('pronto', E.busy || !!campo.value.trim()); acordar();
  }
  const dizer = (tipo, t) => { status.className = 'id-status ' + tipo; statusT.textContent = t; };
  let tFecha = null;
  function fecha(tipo, t) {
    E.busy = false; Bt.t = 0; dizer(tipo, t); envia.setAttribute('aria-label', 'Enviar ideia'); ajusta();
    if (tFecha) cancelar(tFecha); tFecha = depois(tipo === 'erro' ? 3 : 1.8, () => { SH.t = 0; acordar(); });
  }
  let rodada = 0;
  async function enviar() {
    const texto = campo.value.trim(); if (E.busy || !texto) return;
    if (tFecha) cancelar(tFecha);
    const minha = ++rodada; E.busy = true; Bt.t = 1; SH.t = 1; dizer('think', 'Guardando'); envia.setAttribute('aria-label', 'Parar'); campo.value = ''; ajusta();
    const { data, error } = await sb.from('central_ideias').insert({ texto, autor_id: user.id }).select().single();
    if (minha !== rodada) return;
    if (error || !data) { campo.value = texto; ajusta(); return fecha('erro', 'Não consegui guardar'); }
    E.ideias.unshift(data); E.ficha = 'abertas'; pintaLista();
    if (!E.ia) return fecha('done', 'Ideia guardada');
    dizer('think', 'Pensando');
    abrir(data.id, { organizar: true, aoFim: (ok) => { if (minha === rodada && E.busy) fecha(ok ? 'done' : 'erro', ok ? 'Proposta pronta' : 'Não consegui organizar'); } });
  }
  envia.addEventListener('click', () => {
    if (E.busy) { rodada++; fecha('done', 'Parado'); } else enviar();
  });
  campo.addEventListener('input', ajusta);
  campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); enviar(); } });
  $('#id-ia').addEventListener('change', (ev) => { E.ia = ev.target.checked; try { localStorage.setItem('sandstride-ideias-ia', E.ia ? '1' : '0'); } catch { /* */ } });
  ajusta();

  // ---------------------------------------------------------------- conversa da ideia (Goo thinking + Streaming reply + Tool approval)
  let timers = [];
  const later = (s, f) => { const t = depois(s, () => { timers = timers.filter((x) => x !== t); f(); }); timers.push(t); return t; };
  const limpaFio = () => { timers.forEach(cancelar); timers = []; E.fio = null; };

  function abrir(id, { organizar = false, aoFim = null } = {}) {
    const i = ideiaDe(id); if (!i) return;
    limpaFio(); E.aberta = id; pintaLista();
    const sec = $('#id-fio'); sec.hidden = false;
    const pode = i.autor_id === user.id || admin, autor = pessoa(i.autor_id);
    const temProposta = !!i.proposta?.resumo;
    sec.innerHTML = `<div class="qcab"><span class="ico">${svg(ID.ideia)}</span><h2>${i.autor_id === user.id ? 'Sua ideia' : `Ideia de ${esc(prim(autor?.nome))}`}</h2>` +
      (pode ? `<div class="id-acoes">` +
        (i.estado === 'descartada' ? `<button class="btn" type="button" data-acao="reabrir">Reabrir</button>` : `<button class="btn${temProposta ? '' : ' pri'}" type="button" data-acao="organizar">${temProposta ? 'Organizar de novo' : 'Organizar com IA'}</button>` +
          (i.estado === 'guardada' ? '' : `<button class="btn" type="button" data-acao="guardar">Guardar</button>`) + `<button class="btn" type="button" data-acao="descartar">Descartar</button>`) + `</div>` : '') + `<button class="ibtn p" type="button" data-acao="fechar" aria-label="Fechar conversa">${svg(IC.x, 16)}</button></div>` +
      `<div class="id-chat" id="id-chat"><div class="id-msg id-me" id="id-me"></div>` +
      `<div class="id-msg id-ai" id="id-ai" hidden><div class="id-goo" id="id-gooc"><i></i><i></i><i></i></div><p class="id-resp" id="id-resp"></p></div></div>` +
      `<div class="id-aprov" id="id-aprov"></div>`;
    $('#id-me').textContent = i.texto;
    const chat = $('#id-chat'), me = $('#id-me'), ai = $('#id-ai'), goo = $('#id-gooc'), resp = $('#id-resp'), aprov = $('#id-aprov');
    const dots = [...goo.querySelectorAll('i')].map((e, k) => ({ e, x: M(19 + k * 13, 300, 22), y: M(0, 420, 14), k }));
    const meS = M(0, 300, 22), aiS = M(0, 300, 22), W = M(64, 240, 24), Hh = M(40, 240, 24), drop = M(1, 300, 26), big = M(1, 300, 24);
    let palavras = [], fase = 'pensa', hop = 0.3, kk = 0;
    const cheio = () => Math.min(chat.offsetWidth * 0.9, 560);
    const ap = montaAprov({ ideia: i, pode, aprov, E, B, sb, user, salvar: () => salvarProposta(i), aoMudar: pintaLista, nome, pessoa });
    const fio = { id, ap };
    E.fio = fio;

    registrar({
      quadro(dt) {
        if (fase === 'pensa' && (hop -= dt) <= 0) { dots[kk % 3].y.v = -95; kk++; hop = kk % 3 ? 0.16 : 0.46; }
        [meS, aiS, W, Hh, drop, big].forEach((s) => passo(s, dt)); dots.forEach((d) => { passo(d.x, dt); passo(d.y, dt); }); palavras.forEach((w) => passo(w.s, dt));
      },
      desenhar() {
        me.style.opacity = limitar(meS.x, 0, 1).toFixed(3); me.style.transform = `translateY(${((1 - meS.x) * 14).toFixed(2)}px) scale(${(0.92 + 0.08 * meS.x).toFixed(4)})`;
        ai.style.opacity = limitar(aiS.x, 0, 1).toFixed(3); ai.style.transform = `translateY(${((1 - aiS.x) * 14).toFixed(2)}px)`;
        ai.style.width = W.x.toFixed(2) + 'px'; ai.style.height = Hh.x.toFixed(2) + 'px';
        const s = limitar(drop.x, 0, 1.2) * big.x;
        dots.forEach((d) => { d.e.style.transform = `translate(${d.x.x.toFixed(2)}px,${(15.5 + d.y.x).toFixed(2)}px) scale(${s.toFixed(3)})`; });
        palavras.forEach((w) => {
          if (!w.on) return; const v = limitar(w.s.x, 0, 1.2);
          w.e.style.opacity = limitar(v, 0, 1).toFixed(3); w.e.style.transform = `translateY(${((1 - w.s.x) * 6).toFixed(2)}px)`; w.e.style.filter = v < 0.98 ? `blur(${((1 - limitar(v, 0, 1)) * 4).toFixed(2)}px)` : 'none';
        });
      },
      ativo() { return fase === 'pensa' || ![meS, aiS, W, Hh, drop, big].every((s) => parada(s, 0.01)) || dots.some((d) => !parada(d.x, 0.01) || !parada(d.y, 0.01)) || palavras.some((w) => !parada(w.s, 0.005)); },
      fim() { return !chat.isConnected; },
    });

    // escreve a resposta palavra por palavra (ou de uma vez, quando só reabre)
    function escreve(texto, { direto = false, erro = false } = {}) {
      ai.hidden = false; ai.classList.toggle('erro', erro);
      resp.innerHTML = ''; resp.style.width = (cheio() - PAD_X * 2) + 'px';
      palavras = texto.split(' ').map((p, k, l) => { const e = document.createElement('span'); e.className = 'wd'; e.textContent = p; e.style.opacity = 0; resp.appendChild(e); if (k < l.length - 1) resp.append(' '); return { e, s: M(0, 340, 26), on: false }; });
      goo.style.display = 'none'; W.t = cheio();
      const medir = (w) => resp.offsetTop + w.e.offsetTop + w.e.offsetHeight + PAD_Y;
      if (direto) {
        W.x = W.t = cheio(); palavras.forEach((w) => { w.on = true; w.s.x = w.s.t = 1; }); aiS.x = aiS.t = 1; meS.x = meS.t = 1;
        Hh.x = Hh.t = palavras.length ? medir(palavras[palavras.length - 1]) : 40; acordar(); return Promise.resolve();
      }
      return new Promise((ok) => {
        palavras.forEach((w, k) => later(k * 0.07, () => { w.on = true; w.s.t = 1; Hh.t = medir(w); acordar(); }));
        later(palavras.length * 0.07 + 0.25, ok);
      });
    }

    async function organiza() {
      fase = 'pensa'; ai.hidden = false; goo.style.display = ''; resp.innerHTML = ''; palavras = [];
      W.x = W.t = 64; Hh.x = Hh.t = 40; drop.x = drop.t = 1; big.x = big.t = 1; dots.forEach((d, k) => { d.x.t = 19 + k * 13; d.x.x = d.x.t; });
      ai.setAttribute('aria-label', 'Pensando'); aiS.t = 0; aiS.x = 0; ai.setAttribute('role', 'status');
      const t0 = performance.now(); later(0.5, () => { aiS.t = 1; acordar(); }); acordar();
      let r; try { r = await sb.functions.invoke('central-ideia-organizar', { body: { ideia_id: i.id } }); } catch (e) { r = { error: e }; }
      if (E.fio !== fio) return;
      await new Promise((ok) => later(Math.max(0.1, 2 - (performance.now() - t0) / 1000), ok));
      if (E.fio !== fio) return;
      const p = r?.data?.ok ? r.data.proposta : null;
      fase = 'junta'; dots.forEach((d) => { d.x.t = 27.5; d.y.t = 0; }); big.t = 1.45; later(0.45, () => { drop.t = 0; acordar(); }); acordar();
      await new Promise((ok) => later(0.6, ok)); if (E.fio !== fio) return;
      fase = 'resposta';
      if (p) { i.proposta = p; i.estado = 'organizada'; const bo = sec.querySelector('[data-acao=organizar]'); if (bo) { bo.textContent = 'Organizar de novo'; bo.classList.remove('pri'); } await escreve(p.resumo); if (E.fio !== fio) return; ap.troca(i.proposta); pintaLista(); }
      else { await escreve(r?.data?.erro || 'Não consegui organizar essa ideia agora. Tente de novo em instantes.', { erro: true }); }
      aoFim && aoFim(!!p);
    }

    if (organizar) { meS.t = 1; later(0.15, () => { acordar(); }); organiza(); }
    else if (temProposta) { escreve(i.proposta.resumo, { direto: true }); ap.troca(i.proposta, true); }
    else { meS.x = meS.t = 1; acordar(); }
    if (!organizar && temProposta) acordar();
    sec.scrollIntoView({ block: 'nearest', behavior: reduz() ? 'auto' : 'smooth' });

    sec.onclick = async (ev) => {
      const b = ev.target.closest('[data-acao]'); if (!b) return;
      const a = b.dataset.acao;
      if (a === 'fechar') { limpaFio(); E.aberta = null; sec.hidden = true; sec.innerHTML = ''; pintaLista(); return; }
      if (a === 'organizar') { i.proposta = null; abrir(id, { organizar: true }); return; }
      const novo = { guardar: 'guardada', descartar: 'descartada', reabrir: 'nova' }[a];
      if (!novo) return;
      const antes = i.estado; i.estado = novo;
      const { error } = await sb.from('central_ideias').update({ estado: novo, atualizado_em: new Date().toISOString() }).eq('id', id);
      if (error) { i.estado = antes; E.erro = 'Não consegui salvar. Tente de novo.'; } else { E.erro = ''; }
      if (a === 'descartar' && !error) { limpaFio(); E.aberta = null; sec.hidden = true; sec.innerHTML = ''; } else abrir(id);
      pintaLista();
    };
  }

  // ---------------------------------------------------------------- ações da página
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.ficha) { E.ficha = b.dataset.ficha; pintaLista(); }
    else if (b.dataset.abre) abrir(b.dataset.abre);
    else if (b.dataset.apaga) {
      const k = E.ideias.findIndex((x) => x.id === b.dataset.apaga); if (k < 0) return;
      const [x] = E.ideias.splice(k, 1); if (E.aberta === x.id) { limpaFio(); E.aberta = null; const s = $('#id-fio'); s.hidden = true; s.innerHTML = ''; }
      pintaLista();
      const { error } = await sb.from('central_ideias').delete().eq('id', x.id);
      if (error) { E.ideias.splice(k, 0, x); pintaLista(); }
    }
  });
  if (E.erro) $('#id-lista').insertAdjacentHTML('beforebegin', `<p class="erro" role="alert">${svg(IC.alerta)}<span>${esc(E.erro)}</span></p>`);
}

// ------------------------------------------------------------------ Tool approval (Kokonut UI, MIT): cartão que pede, linha que dobra
function montaAprov({ ideia, pode, aprov, E, B, sb, user, salvar, aoMudar, nome, pessoa }) {
  const nos = new Map(); // id do item -> linha dobrada
  let cartao = null;
  const itens = () => ideia.proposta?.itens || [];
  const quando = (d) => (d ? `até ${fCurto.format(dataDe(d))}` : 'sem prazo');

  const campos = (it) => {
    const dono = esc(it.responsavel_id === user.id ? 'Você' : prim(pessoa(it.responsavel_id)?.nome) || '—');
    if (it.tipo === 'tarefa') return [['Tarefa', it.titulo], ['Para', dono], ['Prazo', it.prazo ? fCurto.format(dataDe(it.prazo)) : 'Sem prazo'], ['Importância', IMP[it.importancia] || 'Normal']];
    if (it.tipo === 'meta') return [['Meta', it.titulo], ['Alvo', valor(it.alvo, it.unidade)], ['Mês', fMes.format(dataDe(it.mes))], ['Responsável', dono]];
    return [['Prioridade', it.titulo], ['Dono', dono], ['Prazo', it.prazo ? fCurto.format(dataDe(it.prazo)) : 'Sem prazo']];
  };
  const saida = (it) => {
    const dono = it.responsavel_id === user.id ? 'você' : prim(pessoa(it.responsavel_id)?.nome);
    if (it.tipo === 'tarefa') return `Tarefa para ${dono}, ${quando(it.prazo)}, importância ${(IMP[it.importancia] || 'Normal').toLowerCase()}. Aparece no Meu dia dela.`;
    if (it.tipo === 'meta') return `Meta de ${fMes.format(dataDe(it.mes))}: ${valor(it.alvo, it.unidade)}. Responsável: ${dono}.`;
    return `Prioridade do trimestre, dono: ${dono}, ${quando(it.prazo)}.`;
  };

  const iconeEstado = (e) => {
    if (e === 'criando') return `<svg class="girando" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="var(--ativo)" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" stroke="var(--texto)" stroke-linecap="round" stroke-width="1.5"/></svg>`;
    if (e === 'criado') return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path class="risco" d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="var(--texto)" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75"/></svg>`;
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="color:${e === 'erro' ? 'var(--saida)' : 'var(--suave)'}"><path d="M4.5 4.5l7 7m0-7-7 7" stroke="currentColor" stroke-linecap="round" stroke-width="1.75"/></svg>`;
  };
  const verbo = (e) => ({ criando: 'Criando', criado: 'Criada', ignorado: 'Ignorada', erro: 'Falhou' }[e]);

  function linha(it, animar) {
    let n = nos.get(it.id);
    const novo = !n;
    if (novo) { n = document.createElement('div'); n.className = 'id-tr'; n.dataset.id = it.id; nos.set(it.id, n); }
    const tem = it.estado === 'criado';
    const abertoAntes = n.querySelector('.id-tr-lin')?.getAttribute('aria-expanded') === 'true';
    n.innerHTML = `<button type="button" class="id-tr-lin${it.estado === 'ignorado' ? ' neg' : ''}" ${tem ? `aria-expanded="${abertoAntes}"` : 'disabled'}><span class="ic">${iconeEstado(it.estado)}</span><span class="v">${verbo(it.estado)}</span><code class="t">${esc(it.titulo)}</code>${tem ? `<span class="dir${abertoAntes ? ' on' : ''}">${svg(ID.dir, 14)}</span>` : ''}</button>` +
      (tem ? `<div class="id-tr-out"${abertoAntes ? '' : ' hidden'}><pre>${esc(saida(it))}</pre></div>` : '');
    if (novo) {
      aprov.insertBefore(n, cartao || null);
      if (animar) { n.style.overflow = 'hidden'; anima(n, [{ height: '0px', opacity: 0 }, { height: n.scrollHeight + 'px', opacity: 1 }], 240).then(() => { n.style.overflow = ''; }); }
    }
    return n;
  }

  function trocaCartao(it, animar) {
    const antigo = cartao; cartao = null;
    if (antigo) anima(antigo, [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-6px)', filter: 'blur(2px)' }], 200).then(() => antigo.remove());
    if (!it) return;
    const c = document.createElement('section'); c.className = 'id-ap'; c.dataset.callId = it.id; c.tabIndex = -1; c.setAttribute('aria-labelledby', 'ap-t-' + it.id);
    const n = itens().filter((x) => x.estado === 'pendente').length;
    c.innerHTML = (n > 1 ? `<div class="id-cont"><span>1 de ${n} aguardando</span><button type="button" class="id-todas" data-ap="todas">Criar todas</button></div>` : '') +
      `<div class="id-ap-in"><header><span class="ic">${svg(ICO_TIPO[it.tipo], 16)}</span><h3 id="ap-t-${it.id}">${ROT_TIPO[it.tipo]}</h3><span class="tool">${it.tipo}</span></header>` +
      `<dl>${campos(it).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` +
      (it.detalhe ? `<p class="why">${esc(it.detalhe)}</p>` : '') +
      `<div class="id-ap-bt">${pode ? `<button type="button" class="neg" data-ap="ignora">Ignorar</button><button type="button" class="ok" data-ap="cria">Criar</button>` : `<span class="nota">Quem anotou a ideia ou um administrador aprova.</span>`}</div></div>`;
    aprov.appendChild(c); cartao = c;
    if (animar) anima(c, [{ opacity: 0, transform: 'translateY(8px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], 220);
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && pode) { ev.preventDefault(); decide(it, false); } });
    return c;
  }

  function pinta(animar) {
    itens().forEach((it) => { if (it.estado !== 'pendente') linha(it, animar && !nos.has(it.id)); else if (nos.has(it.id)) { nos.get(it.id).remove(); nos.delete(it.id); } });
    const prox = itens().find((x) => x.estado === 'pendente');
    if (!prox) { trocaCartao(null); return; }
    if (cartao?.dataset.callId !== prox.id) trocaCartao(prox, animar);
  }

  async function cria(it) {
    if (it.tipo === 'tarefa') return sb.from('central_tarefas').insert({ titulo: it.titulo, responsavel_id: it.responsavel_id, prazo: it.prazo || null, importancia: it.importancia || 'normal', criado_por: user.id });
    if (it.tipo === 'meta') return sb.from('central_metas').insert({ mes: it.mes, titulo: it.titulo, unidade: it.unidade, alvo: it.alvo, atual: 0, responsavel_id: it.responsavel_id, criado_por: user.id });
    return sb.from('central_prioridades').insert({ trimestre: it.trimestre, titulo: it.titulo, dono_id: it.responsavel_id, prazo: it.prazo || null, criado_por: user.id });
  }

  async function decide(it, aprovado) {
    if (it.estado !== 'pendente') return;
    const foco = cartao && cartao.contains(document.activeElement);
    it.estado = aprovado ? 'criando' : 'ignorado'; pinta(true);
    if (foco) setTimeout(() => aprov.querySelector('.id-ap')?.focus(), 240);
    if (aprovado) {
      let r; try { r = await cria(it); } catch (e) { r = { error: e }; }
      it.estado = r?.error ? 'erro' : 'criado'; linha(it, false); pinta(true);
    }
    await salvar(); aoMudar();
  }

  aprov.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.classList.contains('id-tr-lin')) {
      const out = b.parentElement.querySelector('.id-tr-out'), abre = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', abre); b.querySelector('.dir')?.classList.toggle('on', abre);
      if (abre) { out.hidden = false; out.style.overflow = 'hidden'; anima(out, [{ height: '0px', opacity: 0 }, { height: out.scrollHeight + 'px', opacity: 1 }], 220).then(() => { out.style.overflow = ''; }); }
      else { out.style.overflow = 'hidden'; anima(out, [{ height: out.scrollHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], 200).then(() => { out.hidden = true; out.style.overflow = ''; }); }
      return;
    }
    const a = b.dataset.ap; if (!a || !pode) return;
    const it = itens().find((x) => x.estado === 'pendente');
    if (a === 'cria' && it) decide(it, true); else if (a === 'ignora' && it) decide(it, false);
    else if (a === 'todas') { for (const x of itens().filter((y) => y.estado === 'pendente')) await decide(x, true); }
  });

  return { troca(proposta, direto = false) { ideia.proposta = proposta; pinta(!direto); } };
}
