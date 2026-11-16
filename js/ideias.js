// Meu dia: caixa de ideias em formato de chat (inbox). Anota do jeito que vier; cada ideia pode virar tarefa direto ou ir para a IA,
// que propõe meta, tarefas e prioridade; a pessoa aprova item por item.
// Componentes (biblioteca de motions): Prompt box, Goo thinking, Streaming reply (designbookmark.com, molas iguais)
// e Tool approval (Kokonut UI, MIT) refeitos em JavaScript puro com as cores do sistema.
import { novoEstado, chipsResp, alternaResp, donosDe } from './responsaveis.js';
import { S, ajustar, passo, parada, limitar, registrar, acordar, depois, cancelar } from './molas.js';
import { esc, svg, IC, dataDe, fCurto, valor } from './meudia.js';
import { base } from './gestao.js';

const ID = {
  ideia: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  seta: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  dir: '<path d="M9 6l6 6-6 6"/>',
  bandeira: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  mais: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  varinha: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M12.2 6.2 11 5M3 21l9-9"/>',
  brilho: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
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
const SUGESTOES = ['Ideia de produto', 'Melhorar um processo', 'Conteúdo para vídeo', 'Algo para cobrar alguém', 'Outra coisa'];
const PREFIXO = { 'Ideia de produto': 'Produto: ', 'Melhorar um processo': 'Processo: ', 'Conteúdo para vídeo': 'Vídeo: ', 'Algo para cobrar alguém': 'Cobrar: ' };

export async function montarCaixaIdeias(ctx) {
  const { el } = ctx, B = base(ctx), { sb, user } = B, admin = B.admin;
  const [eq, lista] = await Promise.all([B.equipe(), sb.from('central_ideias').select('*').order('criado_em', { ascending: true })]);
  const E = { equipe: eq, ideias: lista.data || [], aberta: null, ia: (() => { try { return localStorage.getItem('sandstride-ideias-ia') !== '0'; } catch { return true; } })(), busy: false, ficha: 'abertas', fio: null, erro: lista.error ? 'Não consegui carregar as ideias.' : '' };
  const pessoa = (id) => E.equipe.find((p) => p.usuario_id === id);
  const ideiaDe = (id) => E.ideias.find((i) => i.id === id);
  const salvarProposta = (i) => sb.from('central_ideias').update({ proposta: i.proposta, estado: i.estado, atualizado_em: new Date().toISOString() }).eq('id', i.id);
  const podeMexer = (i) => i.autor_id === user.id;

  // ---------------------------------------------------------------- esqueleto
  el.innerHTML =
    `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="id-goo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="b"/><feColorMatrix in="b" mode="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -8"/></filter></svg>` +
    `<section class="card id-inbox" aria-label="Caixa de ideias"><div class="qcab"><span class="ico">${svg(ID.ideia)}</span><h2>Caixa de ideias</h2>` +
    `<div class="id-mwrap"><button class="ibtn p" type="button" id="id-mbt" aria-haspopup="true" aria-expanded="false" aria-label="Opções da caixa" title="Opções">${svg(ID.mais, 18)}</button>` +
    `<div class="id-menu" id="id-menu" role="menu" hidden><div id="id-filtros" role="group" aria-label="Mostrar"></div><hr><button type="button" role="menuitemcheckbox" id="id-ia" aria-checked="${E.ia}" class="id-mi"><span>A IA organiza ao enviar</span><span class="tr" aria-hidden="true"></span></button></div></div></div>` +
    (E.erro ? `<p class="erro" role="alert">${svg(IC.alerta)}<span>${esc(E.erro)}</span></p>` : '') +
    `<div class="id-stream" id="id-stream" aria-live="polite"></div>` +
    `<p class="id-dica" id="id-dica" hidden>Clique com o botão direito (ou segure) numa ideia para ver as opções</p>` +
    `<div class="id-pb"><div class="id-status" id="id-status" aria-live="polite"><span class="mark"></span><span class="label" id="id-status-t">Pensando</span></div>` +
    `<div class="id-row"><span class="id-varinha" aria-hidden="true">${svg(ID.varinha, 18)}</span><textarea id="id-campo" rows="1" maxlength="2000" placeholder="Anote uma ideia…" aria-label="Nova ideia"></textarea></div>` +
    `<div class="id-base"><button type="button" class="id-chip" id="id-ia-chip" aria-pressed="${E.ia}">${svg(ID.brilho, 14)}<span>Organizar com IA</span></button>` +
    `<span class="id-gap"></span><button type="button" class="id-mic" id="id-mic" aria-label="Falar a ideia" title="Falar a ideia" hidden>${svg(ID.mic, 18)}</button>` +
    `<button class="id-envia" id="id-envia" type="button" aria-label="Enviar ideia"><span class="id-ei"><i class="seta">${svg(ID.seta, 16)}</i><i class="para"></i></span><span class="id-et">Enviar</span></button></div></div></section>`;
  const $ = (s) => el.querySelector(s);
  const stream = $('#id-stream');

  // ---------------------------------------------------------------- chat de ideias
  const nos = new Map(); // id da ideia -> bloco no chat
  const pend = (i) => (i.proposta?.itens || []).filter((x) => x.estado === 'pendente' || x.estado === 'criando').length;
  const situacao = (i) => {
    if (i.estado === 'descartada') return 'descartada';
    const n = i.proposta?.itens?.length || 0;
    if (n && !pend(i)) return 'resolvida';
    if (n) return 'aprovar';
    return i.estado === 'guardada' ? 'guardada' : 'nova';
  };
  const naFicha = (s) => (E.ficha === 'abertas' ? ['nova', 'aprovar', 'guardada'].includes(s) : E.ficha === 'resolvidas' ? s === 'resolvida' : s === 'descartada');

  function filtros() {
    const n = E.ideias.filter((i) => ['nova', 'aprovar', 'guardada'].includes(situacao(i))).length;
    const bt = (v, r, c) => `<button type="button" role="menuitemradio" class="id-mi${E.ficha === v ? ' on' : ''}" data-ficha="${v}" aria-checked="${E.ficha === v}"><span>${r}</span>${c ? `<i>${c}</i>` : ''}</button>`;
    $('#id-filtros').innerHTML = bt('abertas', 'Abertas', n) + bt('resolvidas', 'Resolvidas', 0) + bt('descartadas', 'Descartadas', 0);
  }
  function pintaItem(i) {
    const no = nos.get(i.id); if (!no) return;
    const s = situacao(i), p = pessoa(i.autor_id), meu = i.autor_id === user.id, pode = podeMexer(i), aberto = E.aberta === i.id;
    const TAG = { nova: '<span class="tag listrado">Nova</span>', guardada: '<span class="tag">Guardada</span>', resolvida: `<span class="tag rec">${svg(IC.check)}Resolvida</span>`, descartada: '<span class="tag">Descartada</span>' };
    const qd = `${meu ? '' : esc(prim(p?.nome)) + ' · '}${esc(i.criado_em ? fData.format(new Date(i.criado_em)).replace('.', '') : 'agora')}`;
    no.dataset.qd = qd.replace(/&amp;/g, '&');
    no.querySelector('.id-meta').innerHTML = s === 'nova' ? (meu ? '' : `<span class="id-qd">${qd}</span>`) : (s === 'aprovar' ? `<span class="tag ate">${pend(i)} para aprovar</span>` : TAG[s]) + (meu ? '' : `<span class="id-qd">${qd}</span>`);
    const A = (a, t, pri) => `<button type="button" data-ac="${a}" aria-label="${t}"${pri ? ' class="pri"' : ''}>${t}</button>`;
    no.querySelector('.id-ac').innerHTML = !pode ? '' : s === 'descartada' ? A('reabrir', 'Reabrir') :
      (i.proposta?.resumo ? A('proposta', aberto ? 'Fechar proposta' : 'Ver proposta', s === 'aprovar') + A('organizar', 'Organizar de novo') : A('organizar', 'Organizar com IA', s === 'nova')) +
      (s === 'resolvida' ? '' : A('tarefa', 'Virar tarefa'))  + A('descartar', 'Descartar');
  }
  function sincroniza() {
    filtros();
    const vis = E.ideias.filter((i) => naFicha(situacao(i)));
    for (const [id, no] of nos) if (!vis.some((i) => i.id === id)) { if (E.aberta === id) { limpaFio(); E.aberta = null; } no.remove(); nos.delete(id); }
    vis.forEach((i) => {
      if (!nos.has(i.id)) {
        const no = document.createElement('div'); no.className = 'id-it' + (i.autor_id === user.id ? ' meu' : ''); no.dataset.id = i.id;
        no.innerHTML = '<div class="id-bolha" tabindex="0" aria-haspopup="menu"></div><div class="id-meta"></div><div class="id-ac"></div><div class="id-slot"></div>';
        no.querySelector('.id-bolha').textContent = i.texto; nos.set(i.id, no);
      }
      pintaItem(i);
    });
    // ordem do chat: mais antigas em cima
    vis.forEach((i) => { const no = nos.get(i.id); if (stream.lastElementChild !== no) stream.appendChild(no); });
    // separadores por dia (Hoje, Ontem, 13 de nov)
    stream.querySelectorAll('.id-dia').forEach((d) => d.remove());
    const dia = (i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(i.criado_em ? new Date(i.criado_em) : new Date());
    const hojeD = dia({}), ontemD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 864e5));
    let ant = '';
    vis.forEach((i) => {
      const d = dia(i); if (d === ant) return; ant = d;
      const r = document.createElement('div'); r.className = 'id-dia'; r.setAttribute('role', 'separator');
      r.textContent = d === hojeD ? 'Hoje' : d === ontemD ? 'Ontem' : fData.format(new Date(d + 'T12:00:00-03:00')).replace('.', '');
      stream.insertBefore(r, nos.get(i.id));
    });
    stream.querySelector('.md-vazio, .id-vazio')?.remove();
    const dica = $('#id-dica'); if (dica) dica.hidden = !vis.length;
    if (!vis.length) stream.innerHTML = E.ficha === 'abertas'
      ? `<div class="id-vazio"><div class="id-orbe" aria-hidden="true"></div><h3>O que você quer anotar?</h3><div class="id-sug">${SUGESTOES.map((t) => `<button type="button" data-sug="${esc(t)}">${esc(t)}</button>`).join('')}</div><p>Só você vê o que anota aqui. Quando uma ideia vira tarefa, o time passa a ver a tarefa.</p></div>`
      : `<div class="md-vazio"><p>${E.ficha === 'resolvidas' ? 'Nada resolvido ainda.' : 'Nenhuma ideia descartada.'}</p></div>`;
  }
  const rola = () => { stream.scrollTo({ top: stream.scrollHeight, behavior: reduz() ? 'auto' : 'smooth' }); };
  sincroniza(); stream.scrollTop = stream.scrollHeight;

  // ---------------------------------------------------------------- Prompt box
  const campo = $('#id-campo'), envia = $('#id-envia'), status = $('#id-status'), statusT = $('#id-status-t');
  const seta = envia.querySelector('.seta'), para = envia.querySelector('.para'), etxt = envia.querySelector('.id-et');
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
    E.busy = false; Bt.t = 0; dizer(tipo, t); envia.setAttribute('aria-label', 'Enviar ideia'); etxt.textContent = 'Enviar'; ajusta();
    if (tFecha) cancelar(tFecha); tFecha = depois(tipo === 'erro' ? 3 : 1.8, () => { SH.t = 0; acordar(); });
  }
  let rodada = 0;
  async function enviar() {
    const texto = campo.value.trim(); if (E.busy || !texto) return;
    if (tFecha) cancelar(tFecha);
    const minha = ++rodada; E.busy = true; Bt.t = 1; SH.t = 1; dizer('think', 'Guardando'); envia.setAttribute('aria-label', 'Parar'); etxt.textContent = 'Parar'; campo.value = ''; ajusta();
    const { data, error } = await sb.from('central_ideias').insert({ texto, autor_id: user.id }).select().single();
    if (minha !== rodada) return;
    if (error || !data) { campo.value = texto; ajusta(); return fecha('erro', 'Não consegui guardar'); }
    E.ideias.push(data); E.ficha = 'abertas'; sincroniza(); rola();
    if (!E.ia) return fecha('done', 'Ideia guardada');
    dizer('think', 'Pensando');
    abrir(data.id, { organizar: true, aoFim: (ok) => { if (minha === rodada && E.busy) fecha(ok ? 'done' : 'erro', ok ? 'Proposta pronta' : 'Não consegui organizar'); } });
  }
  envia.addEventListener('click', () => { if (E.busy) { rodada++; fecha('done', 'Parado'); } else enviar(); });
  campo.addEventListener('input', ajusta);
  campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); enviar(); } });
  const setIA = (v) => {
    E.ia = v; try { localStorage.setItem('sandstride-ideias-ia', v ? '1' : '0'); } catch { /* */ }
    $('#id-ia').setAttribute('aria-checked', String(v)); $('#id-ia').classList.toggle('on', v); $('#id-ia-chip').setAttribute('aria-pressed', String(v));
  };
  $('#id-ia').classList.toggle('on', E.ia);
  $('#id-ia').addEventListener('click', () => setIA(!E.ia));
  $('#id-ia-chip').addEventListener('click', () => setIA(!E.ia));
  // menu ⋮
  const menu = $('#id-menu'), mbt = $('#id-mbt');
  const menuAbre = (v) => { menu.hidden = !v; mbt.setAttribute('aria-expanded', String(v)); };
  mbt.addEventListener('click', (ev) => { ev.stopPropagation(); menuAbre(menu.hidden); });
  document.addEventListener('pointerdown', (ev) => { if (!menu.hidden && !ev.target.closest('.id-mwrap')) menuAbre(false); });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !menu.hidden) { menuAbre(false); mbt.focus(); } });
  // sugestões do estado vazio
  stream.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sug]'); if (!b) return;
    campo.value = PREFIXO[b.dataset.sug] || ''; ajusta(); campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length);
  });
  // falar a ideia (reconhecimento de voz do navegador, quando existir)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, mic = $('#id-mic');
  if (SR) {
    mic.hidden = false; let rec = null, base0 = '';
    const para_ = () => { try { rec?.stop(); } catch { /* */ } rec = null; mic.classList.remove('on'); mic.setAttribute('aria-pressed', 'false'); };
    mic.addEventListener('click', () => {
      if (rec) return para_();
      try {
        rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = true; base0 = campo.value ? campo.value.replace(/\s*$/, ' ') : '';
        rec.onresult = (e) => { let t = ''; for (let k = 0; k < e.results.length; k++) t += e.results[k][0].transcript; campo.value = (base0 + t).slice(0, 2000); ajusta(); };
        rec.onend = para_; rec.onerror = para_; rec.start(); mic.classList.add('on'); mic.setAttribute('aria-pressed', 'true');
      } catch { para_(); }
    });
  }
  ajusta();

  // ---------------------------------------------------------------- resposta da IA no chat (Goo thinking + Streaming reply + Tool approval)
  let timers = [];
  const later = (s, f) => { const t = depois(s, () => { timers = timers.filter((x) => x !== t); f(); }); timers.push(t); return t; };
  const limpaFio = () => { timers.forEach(cancelar); timers = []; E.fio = null; };
  const fechaSlot = (id) => { const sl = nos.get(id)?.querySelector('.id-slot'); if (sl) sl.innerHTML = ''; };

  function abrir(id, { organizar = false, aoFim = null } = {}) {
    const i = ideiaDe(id), no = nos.get(id); if (!i || !no) return;
    limpaFio(); if (E.aberta && E.aberta !== id) { const ant = ideiaDe(E.aberta); fechaSlot(E.aberta); E.aberta = null; if (ant) pintaItem(ant); }
    E.aberta = id; pintaItem(i);
    const slot = no.querySelector('.id-slot'), pode = podeMexer(i), temProposta = !!i.proposta?.resumo;
    slot.innerHTML = `<div class="id-chat"><div class="id-msg id-ai" hidden><div class="id-goo"><i></i><i></i><i></i></div><p class="id-resp"></p></div></div><div class="id-aprov"></div>`;
    const chat = slot.querySelector('.id-chat'), ai = slot.querySelector('.id-ai'), goo = slot.querySelector('.id-goo'), resp = slot.querySelector('.id-resp'), aprov = slot.querySelector('.id-aprov');
    const dots = [...goo.querySelectorAll('i')].map((e, k) => ({ e, x: M(19 + k * 13, 300, 22), y: M(0, 420, 14), k }));
    const aiS = M(0, 300, 22), W = M(64, 240, 24), Hh = M(40, 240, 24), drop = M(1, 300, 26), big = M(1, 300, 24);
    let palavras = [], fase = 'pensa', hop = 0.3, kk = 0;
    const cheio = () => Math.min(chat.offsetWidth * 0.9, 560);
    const ap = montaAprov({ ideia: i, pode, aprov, E, B, sb, user, salvar: () => salvarProposta(i), aoMudar: () => { pintaItem(i); filtros(); }, pessoa });
    const fio = { id, ap };
    E.fio = fio;

    registrar({
      quadro(dt) {
        if (fase === 'pensa' && (hop -= dt) <= 0) { dots[kk % 3].y.v = -95; kk++; hop = kk % 3 ? 0.16 : 0.46; }
        [aiS, W, Hh, drop, big].forEach((s) => passo(s, dt)); dots.forEach((d) => { passo(d.x, dt); passo(d.y, dt); }); palavras.forEach((w) => passo(w.s, dt));
      },
      desenhar() {
        ai.style.opacity = limitar(aiS.x, 0, 1).toFixed(3); ai.style.transform = `translateY(${((1 - aiS.x) * 14).toFixed(2)}px)`;
        ai.style.width = W.x.toFixed(2) + 'px'; ai.style.height = Hh.x.toFixed(2) + 'px';
        const s = limitar(drop.x, 0, 1.2) * big.x;
        dots.forEach((d) => { d.e.style.transform = `translate(${d.x.x.toFixed(2)}px,${(15.5 + d.y.x).toFixed(2)}px) scale(${s.toFixed(3)})`; });
        palavras.forEach((w) => {
          if (!w.on) return; const v = limitar(w.s.x, 0, 1.2);
          w.e.style.opacity = limitar(v, 0, 1).toFixed(3); w.e.style.transform = `translateY(${((1 - w.s.x) * 6).toFixed(2)}px)`; w.e.style.filter = v < 0.98 ? `blur(${((1 - limitar(v, 0, 1)) * 4).toFixed(2)}px)` : 'none';
        });
      },
      ativo() { return fase === 'pensa' || ![aiS, W, Hh, drop, big].every((s) => parada(s, 0.01)) || dots.some((d) => !parada(d.x, 0.01) || !parada(d.y, 0.01)) || palavras.some((w) => !parada(w.s, 0.005)); },
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
        W.x = W.t = cheio(); palavras.forEach((w) => { w.on = true; w.s.x = w.s.t = 1; }); aiS.x = aiS.t = 1;
        Hh.x = Hh.t = palavras.length ? medir(palavras[palavras.length - 1]) : 40; acordar(); return Promise.resolve();
      }
      return new Promise((ok) => {
        palavras.forEach((w, k) => later(k * 0.07, () => { w.on = true; w.s.t = 1; Hh.t = medir(w); acordar(); if (k % 6 === 0) rola(); }));
        later(palavras.length * 0.07 + 0.25, ok);
      });
    }

    async function organiza() {
      fase = 'pensa'; ai.hidden = false; goo.style.display = ''; resp.innerHTML = ''; palavras = [];
      W.x = W.t = 64; Hh.x = Hh.t = 40; drop.x = drop.t = 1; big.x = big.t = 1; dots.forEach((d, k) => { d.x.t = 19 + k * 13; d.x.x = d.x.t; });
      ai.setAttribute('aria-label', 'Pensando'); ai.setAttribute('role', 'status'); aiS.t = 0; aiS.x = 0;
      const t0 = performance.now(); later(0.2, () => { aiS.t = 1; acordar(); rola(); }); acordar();
      let r; try { r = await sb.functions.invoke('central-ideia-organizar', { body: { ideia_id: i.id } }); } catch (e) { r = { error: e }; }
      if (E.fio !== fio) return;
      await new Promise((ok) => later(Math.max(0.1, 2 - (performance.now() - t0) / 1000), ok));
      if (E.fio !== fio) return;
      const p = r?.data?.ok ? r.data.proposta : null;
      fase = 'junta'; dots.forEach((d) => { d.x.t = 27.5; d.y.t = 0; }); big.t = 1.45; later(0.45, () => { drop.t = 0; acordar(); }); acordar();
      await new Promise((ok) => later(0.6, ok)); if (E.fio !== fio) return;
      fase = 'resposta';
      if (p) { i.proposta = p; i.estado = 'organizada'; pintaItem(i); filtros(); await escreve(p.resumo); if (E.fio !== fio) return; ap.troca(i.proposta); rola(); }
      else { await escreve(r?.data?.erro || 'Não consegui organizar essa ideia agora. Tente de novo em instantes.', { erro: true }); }
      aoFim && aoFim(!!p);
    }

    if (organizar) organiza();
    else if (temProposta) { escreve(i.proposta.resumo, { direto: true }); ap.troca(i.proposta, true); }
    no.scrollIntoView({ block: 'nearest', behavior: reduz() ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------- virar tarefa direto (mudar de quadro)
  function formTarefa(i) {
    limpaFio(); if (E.aberta && E.aberta !== i.id) { const ant = ideiaDe(E.aberta); fechaSlot(E.aberta); E.aberta = null; if (ant) pintaItem(ant); }
    E.aberta = i.id; pintaItem(i);
    const slot = nos.get(i.id).querySelector('.id-slot');
    const R = { titulo: String(i.texto).split('\n')[0].slice(0, 160), prazo: '', imp: 'normal' }, est = novoEstado(user.id);
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const pinta = () => {
      const imp = (v, r) => `<button type="button" data-iimp="${v}" class="${R.imp === v ? 'on' : ''}" aria-pressed="${R.imp === v}">${r}</button>`;
      slot.innerHTML = `<form class="id-form"><p class="id-form-t">Virar tarefa</p><label class="campo"><span>Nome da tarefa</span><input class="md-in" name="titulo" maxlength="160" autocomplete="off" value="${esc(R.titulo)}"></label>` +
        `<div class="campo"><span>Responsáveis</span>${chipsResp(E.equipe, user.id, est, prim, esc)}</div>` +
        `<label class="campo"><span>Data</span><input class="md-in" name="prazo" type="date" min="${hoje}" value="${esc(R.prazo)}"></label>` +
        `<div class="campo"><span>Importância</span><div class="md-imp" role="group" aria-label="Importância">${imp('baixa', 'Baixa')}${imp('normal', 'Normal')}${imp('alta', 'Alta')}</div></div>` +
        `<p class="erro" role="alert" hidden></p><div class="md-acoes"><button class="btn" type="button" data-ci="cancela">Cancelar</button><button class="btn pri" type="submit">Criar tarefa</button></div></form>`;
    };
    pinta();
    const f = () => slot.querySelector('form');
    slot.oninput = (ev) => { const k = { titulo: 'titulo', prazo: 'prazo' }[ev.target.name]; if (k) R[k] = ev.target.value; };
    slot.ondblclick = (ev) => { const d = ev.target.closest('input[type=date]'); if (d && !d.value) { d.value = hoje; R.prazo = hoje; } };
    slot.onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.iimp) { R.imp = b.dataset.iimp; pinta(); }
      else if (b.dataset.rp) { alternaResp(est, b.dataset.rp, user.id); const t = f().elements.titulo.value, p = f().elements.prazo.value; R.titulo = t; R.prazo = p; pinta(); slot.querySelector(`[data-rp="${b.dataset.rp}"]`)?.focus(); }
      else if (b.dataset.ci === 'cancela') { slot.innerHTML = ''; slot.oninput = slot.onclick = slot.ondblclick = null; E.aberta = null; pintaItem(i); }
    };
    slot.onsubmit = async (ev) => {
      ev.preventDefault(); const titulo = R.titulo.trim(), erro = slot.querySelector('.erro');
      if (!titulo) { f().elements.titulo.focus(); return; }
      const donos = donosDe(est, E.equipe);
      const nova = { titulo, responsavel_id: donos[0], prazo: R.prazo || null, importancia: R.imp, criado_por: user.id };
      const { error } = await sb.from('central_tarefas').insert(donos.map((d) => ({ ...nova, responsavel_id: d })));
      if (error) { erro.hidden = false; erro.textContent = 'Não consegui criar a tarefa. Tente de novo.'; return; }
      i.proposta = { resumo: 'Virou tarefa.', itens: [{ id: crypto.randomUUID(), tipo: 'tarefa', titulo, detalhe: '', responsavel_id: donos.length === 1 ? donos[0] : null, prazo: nova.prazo, importancia: R.imp, estado: 'criado' }], criado_em: new Date().toISOString() };
      i.estado = 'organizada'; await salvarProposta(i);
      slot.innerHTML = ''; slot.oninput = slot.onclick = slot.onsubmit = slot.ondblclick = null; E.aberta = null;
      sincroniza(); ctx.aoCriarTarefa && ctx.aoCriarTarefa();
    };
    f().elements.titulo.focus(); f().elements.titulo.select();
    nos.get(i.id).scrollIntoView({ block: 'nearest', behavior: reduz() ? 'auto' : 'smooth' });
  }


  // ---------------------------------------------------------------- menu de opções (botão direito / segurar)
  let cm = null;
  const fechaCtx = () => { if (!cm) return; cm.menu.remove(); cm.no.classList.remove('ctx'); cm = null; };
  function abreCtx(no, x, y) {
    fechaCtx();
    const bts = [...no.querySelectorAll('.id-ac button')]; if (!bts.length) return;
    const m = document.createElement('div'); m.className = 'id-ctx'; m.setAttribute('role', 'menu');
    m.innerHTML = (no.dataset.qd ? `<div class="id-ctx-t">${esc(no.dataset.qd)}</div>` : '') + bts.map((b) => `<button type="button" role="menuitem" data-a="${b.dataset.ac}" class="${b.classList.contains('pri') ? 'pri ' : ''}${b.dataset.ac === 'descartar' ? 'perigo' : ''}">${esc(b.textContent)}</button>`).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    const left = Math.max(8, Math.min(x, W - r.width - 8)), top = Math.max(8, Math.min(y, H - r.height - 8));
    m.style.left = left + 'px'; m.style.top = top + 'px'; m.style.setProperty('--ox', (x - left) + 'px'); m.style.setProperty('--oy', (y - top) + 'px');
    no.classList.add('ctx'); cm = { menu: m, no, em: performance.now() };
    m.querySelector('button')?.focus({ preventScroll: true });
    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-a]'); if (!b) return;
      const alvo = no.querySelector(`.id-ac button[data-ac="${b.dataset.a}"]`); fechaCtx(); alvo?.click();
    });
  }
  stream.addEventListener('contextmenu', (ev) => {
    const no = ev.target.closest('.id-it'); if (!no || ev.target.closest('.id-slot')) return;
    ev.preventDefault(); const r = no.getBoundingClientRect();
    abreCtx(no, ev.clientX || r.left + 24, ev.clientY || r.bottom);
  });
  // toque: segurar ~0,45s em cima da ideia
  let seg = null;
  stream.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse') return;
    const no = ev.target.closest('.id-it'); if (!no || ev.target.closest('.id-slot')) return;
    const x = ev.clientX, y = ev.clientY; clearTimeout(seg);
    seg = setTimeout(() => { seg = null; navigator.vibrate?.(8); abreCtx(no, x, y); }, 450);
    seg_xy = [x, y];
  });
  let seg_xy = [0, 0];
  stream.addEventListener('pointermove', (ev) => { if (seg && Math.hypot(ev.clientX - seg_xy[0], ev.clientY - seg_xy[1]) > 10) { clearTimeout(seg); seg = null; } });
  for (const t of ['pointerup', 'pointercancel']) stream.addEventListener(t, () => { clearTimeout(seg); seg = null; });
  document.addEventListener('pointerdown', (ev) => { if (cm && !ev.target.closest('.id-ctx') && performance.now() - cm.em > 250) fechaCtx(); }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && cm) { const b = cm.no.querySelector('.id-bolha'); fechaCtx(); b?.focus(); } });
  addEventListener('resize', fechaCtx); stream.addEventListener('scroll', fechaCtx, { passive: true });

  // ---------------------------------------------------------------- ações
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.ficha) { E.ficha = b.dataset.ficha; sincroniza(); return; }
    const no = b.closest('.id-it'), a = b.dataset.ac; if (!no || !a) return;
    const i = ideiaDe(no.dataset.id); if (!i || !podeMexer(i)) return;
    if (a === 'proposta') { if (E.aberta === i.id) { limpaFio(); fechaSlot(i.id); E.aberta = null; pintaItem(i); } else abrir(i.id); }
    else if (a === 'organizar') { i.proposta = null; abrir(i.id, { organizar: true }); }
    else if (a === 'tarefa') formTarefa(i);
    else {
      const novo = { guardar: 'guardada', descartar: 'descartada', reabrir: 'nova' }[a]; if (!novo) return;
      const antes = i.estado; i.estado = novo;
      const { error } = await sb.from('central_ideias').update({ estado: novo, atualizado_em: new Date().toISOString() }).eq('id', i.id);
      if (error) i.estado = antes;
      if (a === 'descartar' && !error && E.aberta === i.id) { limpaFio(); fechaSlot(i.id); E.aberta = null; }
      sincroniza();
    }
  });
}

// ------------------------------------------------------------------ Tool approval (Kokonut UI, MIT): cartão que pede, linha que dobra
function montaAprov({ ideia, pode, aprov, E, B, sb, user, salvar, aoMudar, pessoa }) {
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
