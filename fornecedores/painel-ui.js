// Painel do Fornecedores com os motions e quadros do briefing de design v2.
// Só desenha dados que já existem em db.entries (nada de estimativa). Valor a pagar e confirmações NÃO são animados.
import { S, ajustar, passo, parada, registrar, acordar, depois, pilula } from '../js/molas.js';

const F = window.FinanceCore;
const reduz = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const mem = new Map();               // posição das molas entre redesenhos (a tela refaz tudo a cada gravação)
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const PERIODOS = [{ v: '30', rot: '30 dias', dias: 30 }, { v: '90', rot: '90 dias', dias: 90 }, { v: '365', rot: '12 meses', dias: 365 }];
let periodoAtual = '90';
let ultimaChave = '';

const html = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const el = (r, q) => r.querySelector(q);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  compra: '<path d="M3 8 12 3l9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8"/>',
  pago: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
  grafico: '<path d="M4 20V10m6 10V4m6 16v-7m5 7H3"/>',
  lista: '<path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  seta: '<path d="M7 17 17 7M8 7h9v9"/>',
  rank: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>',
  medidor: '<path d="M4 17a8 8 0 1 1 16 0M12 17l4-5"/>',
};
const brl = (c) => {
  c = Math.round(c); const neg = c < 0; c = Math.abs(c);
  return `${neg ? '− ' : ''}<span class="c">R$</span> ${new Intl.NumberFormat('pt-BR').format(Math.floor(c / 100))}<span class="c">,${String(c % 100).padStart(2, '0')}</span>`;
};
const brlTxt = (c) => (c < 0 ? '− ' : '') + 'R$ ' + new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(c) / 100);
const dia = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5;
const br = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);

/* ---------- molas: número que rola, ponto, barra ---------- */
function mola(chave, ini, k, c) { const s = S(mem.has(chave) ? mem.get(chave) : ini, k, c); s.chave = chave; return s; }
function alvo(s, t) { s.t = t; ajustar(s, s.k, s.c); if (reduz()) { s.x = t; s.v = 0; } acordar(); }
function viva(raiz, molas, desenhar) {
  desenhar();
  registrar({
    quadro(dt) { molas.forEach((s) => passo(s, dt)); },
    desenhar() { molas.forEach((s) => { if (parada(s, 0.5)) { s.x = s.t; s.v = 0; } mem.set(s.chave, s.x); }); desenhar(); },
    ativo() { return !molas.every((s) => parada(s, 0.5)); },
    fim() { return !raiz.isConnected; },
  });
}

/* ---------- dados ---------- */
const movimentos = (db) => db.entries.filter((e) => !e.cancelled);
function janela(db, tipo, hoje, dias, deslocar) {
  const fim = hoje - deslocar * dias, ini = fim - dias + 1;
  const pts = Array(12).fill(0); let total = 0;
  for (const e of movimentos(db)) {
    if (e.type !== tipo) continue;
    const d = dia(e.date); if (d < ini || d > fim) continue;
    total += e.value; pts[Math.min(11, Math.floor((d - ini) / dias * 12))] += e.value;
  }
  return { total, pts };
}
function porMes(db, hoje) {
  const h = new Date(hoje * 864e5), meses = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - i, 1)); meses.push({ ano: d.getUTCFullYear(), mes: d.getUTCMonth(), compras: 0, pagos: 0 }); }
  for (const e of movimentos(db)) {
    const m = meses.find((x) => +e.date.slice(0, 4) === x.ano && +e.date.slice(5, 7) - 1 === x.mes); if (!m) continue;
    if (e.type === 'purchase') m.compras += e.value; else if (e.type === 'payment') m.pagos += e.value;
  }
  return meses;
}

/* ---------- quadros ---------- */
function metrica(chave, titulo, icone, cor, irPara) {
  const W = 200, H = 60;
  const raiz = html(`<div class="card pn-c"><div class="qcab"><span class="ico">${ico(icone)}</span><h3>${titulo}</h3><button type="button" class="ibtn" aria-label="Abrir ${titulo.toLowerCase()}" data-ir="${irPara}">${ico(I.seta)}</button></div>
    <div class="valor"></div><div class="fila"><span class="suave leg"></span><span class="var"><i class="seta">${ico(I.seta)}</i><b></b></span></div>
    <div class="lw"><svg class="linha" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="area" fill="${cor}" opacity=".12"/><path class="ln" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg><i class="pn-ponto" style="background:${cor}"></i></div></div>`);
  const nVal = el(raiz, '.valor'), nVar = el(raiz, '.var b'), nSeta = el(raiz, '.seta'), ln = el(raiz, '.ln'), area = el(raiz, '.area'), leg = el(raiz, '.leg'), chip = el(raiz, '.var'), ponto = el(raiz, '.pn-ponto');
  const num = mola(chave + ':n', 0, 160, 22), vr = mola(chave + ':v', 0, 160, 22);
  const pts = Array.from({ length: 12 }, (_, i) => mola(chave + ':p' + i, H - 8, 200, 17));
  let sinal = 1;
  viva(raiz, [num, vr, ...pts], () => {
    nVal.innerHTML = brl(num.x);
    nVar.textContent = (Math.abs(vr.x) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    nSeta.style.transform = `rotate(${sinal > 0 ? 0 : 90}deg)`;
    const xy = pts.map((s, i) => [i * W / 11, s.x]);
    let d = `M${xy[0][0]} ${xy[0][1].toFixed(2)}`;
    for (let i = 0; i < 11; i++) {
      const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    ln.setAttribute('d', d); area.setAttribute('d', `${d} L${W} ${H} L0 ${H} Z`);
    const u = xy[11]; ponto.style.left = (u[0] / W * 100) + '%'; ponto.style.top = (u[1] / H * 100) + '%';
  });
  return {
    raiz,
    set(total, antes, serie, rotulo) {
      const max = Math.max(...serie, 1);
      alvo(num, total);
      const v = antes > 0 ? (total - antes) / antes * 1000 : 0;
      sinal = v >= 0 ? 1 : -1; alvo(vr, v);
      chip.hidden = antes <= 0; chip.classList.toggle('baixa', v < 0);
      leg.textContent = rotulo;
      serie.forEach((x, i) => depois(0.03 * i, () => alvo(pts[i], H - 8 - (x / max) * (H - 18))));
    },
  };
}

function medidor() {
  const raiz = html(`<div class="card pn-c"><div class="qcab"><span class="ico">${ico(I.medidor)}</span><h3>Pago do que foi comprado</h3></div>
    <div class="med"><svg viewBox="0 0 120 68" aria-hidden="true"><path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke="var(--ativo)" stroke-width="10" stroke-linecap="round"/><path class="arco" d="M10 60 A50 50 0 0 1 110 60" pathLength="1" fill="none" stroke="var(--pago)" stroke-width="10" stroke-linecap="round" stroke-dasharray="1"/></svg><div class="num"></div></div>
    <p class="sub leg"></p></div>`);
  const arco = el(raiz, '.arco'), nNum = el(raiz, '.num'), leg = el(raiz, '.leg');
  const p = mola('med:p', 0, 140, 20), n = mola('med:n', 0, 160, 22);
  viva(raiz, [p, n], () => { arco.style.strokeDashoffset = (1 - Math.max(0, Math.min(1, p.x))).toFixed(4); nNum.textContent = Math.round(n.x) + '%'; });
  return { raiz, set(pago, comprado, rot) { const r = comprado > 0 ? Math.min(1, pago / comprado) : 0; alvo(p, r); alvo(n, r * 100); leg.innerHTML = comprado > 0 ? rot : 'Sem compras no período.'; } };
}

function grafico() {
  const raiz = html(`<div class="card pn-g"><div class="qcab"><span class="ico">${ico(I.grafico)}</span><h3>Compras e pagamentos por mês</h3></div>
    <div class="graf"><span class="dica"></span></div>
    <div class="leg-g"><span><i class="k1"></i>Compras</span><span><i class="k2"></i>Pagamentos</span><span><i class="k3"></i>Mês em foco</span></div></div>`);
  const graf = el(raiz, '.graf'), dica = el(raiz, '.dica');
  const colunas = Array.from({ length: 12 }, (_, i) => {
    const b = html('<button type="button"><span class="par"><b class="c1"></b><b class="c2"></b></span><em></em></button>'); graf.append(b);
    return { b, c1: mola(`gr:c${i}`, 0, 200, 17), c2: mola(`gr:p${i}`, 0, 200, 17) };
  });
  viva(raiz, colunas.flatMap((c) => [c.c1, c.c2]), () => {
    colunas.forEach((c) => { c.b.querySelector('.c1').style.transform = `scaleY(${Math.max(0, c.c1.x).toFixed(4)})`; c.b.querySelector('.c2').style.transform = `scaleY(${Math.max(0, c.c2.x).toFixed(4)})`; });
  });
  let dados = [];
  function foca(i) {
    colunas.forEach((c, j) => c.b.classList.toggle('on', i === j));
    const m = dados[i]; if (!m) return;
    dica.textContent = `${MESES[m.mes]}/${m.ano} · compras ${brlTxt(m.compras)} · pagos ${brlTxt(m.pagos)}`;
    const b = colunas[i].b, x = b.offsetLeft + b.offsetWidth / 2, h = dica.offsetWidth / 2;
    dica.style.left = Math.max(h, Math.min(graf.clientWidth - h, x)) + 'px'; dica.classList.add('on');
  }
  colunas.forEach((c, i) => ['mouseenter', 'focus', 'click'].forEach((ev) => c.b.addEventListener(ev, () => foca(i))));
  graf.addEventListener('mouseleave', () => foca(11));
  return {
    raiz,
    set(meses) {
      dados = meses; const max = Math.max(1, ...meses.flatMap((m) => [m.compras, m.pagos]));
      meses.forEach((m, i) => {
        const c = colunas[i]; c.b.querySelector('em').textContent = MESES[m.mes];
        c.b.setAttribute('aria-label', `${MESES[m.mes]}/${m.ano}: compras ${brlTxt(m.compras)}, pagamentos ${brlTxt(m.pagos)}`);
        c.b.style.setProperty('--h1', (m.compras / max * 100).toFixed(1) + '%'); c.b.style.setProperty('--h2', (m.pagos / max * 100).toFixed(1) + '%');
        depois(0.03 * i, () => { alvo(c.c1, 1); alvo(c.c2, 1); });
      });
      requestAnimationFrame(() => foca(11));
    },
  };
}

function extrato(db) {
  const tipos = { purchase: ['Compra', '+', ''], payment: ['Pagamento', '−', 'e'], credit: ['Abatimento', '−', 'e'] };
  const lista = movimentos(db).filter((e) => tipos[e.type]).sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id))).slice(0, 6);
  const raiz = html('<div class="card pn-e"><div class="qcab"><span class="ico">' + ico(I.lista) + '</span><h3>Últimos lançamentos</h3></div><ul class="ext"></ul></div>');
  const ul = el(raiz, '.ext');
  if (!lista.length) ul.innerHTML = '<li class="vazio">Nenhum lançamento ainda.</li>';
  lista.forEach((e, i) => {
    const t = tipos[e.type];
    ul.append(html(`<li style="--o:${i}"><span class="logo">${esc(e.supplier.replace(/[^A-Za-zÀ-ú]/g, '').slice(0, 2).toUpperCase() || '·')}</span><div>${esc(e.supplier)}<span>${t[0]} · ${br(e.date)}</span></div><b class="${t[2]}">${t[1]} ${brlTxt(e.value)}</b></li>`));
  });
  return { raiz };
}

function ranking(db, hoje, dias) {
  const ini = hoje - dias + 1, por = {};
  for (const e of movimentos(db)) { if (e.type !== 'purchase') continue; const d = dia(e.date); if (d < ini || d > hoje) continue; por[e.supplier] = (por[e.supplier] || 0) + e.value; }
  const top = Object.entries(por).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const raiz = html('<div class="card pn-r"><div class="qcab"><span class="ico">' + ico(I.rank) + '</span><h3>Fornecedores com mais compras no período</h3></div><ol class="rank"></ol></div>');
  const ol = el(raiz, '.rank');
  if (!top.length) ol.innerHTML = '<li class="vazio">Sem compras no período.</li>';
  top.forEach(([nome, v], i) => ol.append(html(`<li class="${i ? '' : 'um'}" style="--o:${i}"><i>${i + 1}</i><span>${esc(nome)}</span><b>${brlTxt(v)}</b></li>`)));
  return { raiz };
}

/* ---------- montagem ---------- */
function montar(db) {
  const hoje = dia(F.businessDate()), cfg = () => PERIODOS.find((p) => p.v === periodoAtual);
  const sec = html(`<section class="pn" id="pn"><div class="pn-cab"><div><span class="rotulo">Resumo</span><h2>Movimento do período</h2></div>
    <div class="seg" role="group" aria-label="Período"><span class="polegar"></span>${PERIODOS.map((p) => `<button type="button" data-v="${p.v}" aria-pressed="false">${p.rot}</button>`).join('')}</div></div>
    <div class="pn-g3"></div><div class="pn-g21"></div><div class="pn-g1"></div></section>`);
  const g3 = el(sec, '.pn-g3'), g21 = el(sec, '.pn-g21'), g1 = el(sec, '.pn-g1');
  const mc = metrica('mc', 'Compras', I.compra, 'var(--rec)', 'Compras'), mp = metrica('mp', 'Pagamentos', I.pago, 'var(--pago)', 'Histórico de pagamentos'), md = medidor(), gf = grafico(), ex = extrato(db);
  g3.append(mc.raiz, mp.raiz, md.raiz); g21.append(gf.raiz, ex.raiz);
  const pil = pilula(el(sec, '.polegar')), botoes = [...sec.querySelectorAll('.seg button')];
  let rk = null;
  function atualizar(animarPilula) {
    const c = cfg();
    botoes.forEach((b) => { const on = b.dataset.v === periodoAtual; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); if (on) pil.ir(b.offsetLeft, b.offsetWidth, !animarPilula); });
    const a = janela(db, 'purchase', hoje, c.dias, 0), a0 = janela(db, 'purchase', hoje, c.dias, 1);
    const b = janela(db, 'payment', hoje, c.dias, 0), b0 = janela(db, 'payment', hoje, c.dias, 1);
    mc.set(a.total, a0.total, a.pts, `comprado em ${c.rot}`);
    mp.set(b.total, b0.total, b.pts, `pago em ${c.rot}`);
    // medidor acompanha o período: pagamentos + abatimentos da janela contra as compras da mesma janela
    const ab = janela(db, 'credit', hoje, c.dias, 0), pagoJ = b.total + ab.total;
    md.set(pagoJ, a.total, `<span>${brlTxt(pagoJ)} pagos no período,</span> <span>para ${brlTxt(a.total)} comprados em ${c.rot}.</span>`);
    const novo = ranking(db, hoje, c.dias); if (rk) rk.replaceWith(novo.raiz); else g1.append(novo.raiz); rk = novo.raiz;
  }
  gf.set(porMes(db, hoje));
  botoes.forEach((b) => b.addEventListener('click', () => { if (periodoAtual === b.dataset.v) return; periodoAtual = b.dataset.v; atualizar(true); }));
  sec.addEventListener('click', (ev) => { const t = ev.target.closest('[data-ir]'); if (!t) return; [...document.querySelectorAll('#nav button')].find((x) => x.textContent.trim() === t.dataset.ir)?.click(); });
  requestAnimationFrame(() => atualizar(false));
  return sec;
}

/* número que rola nos totais registrados (movimento, não valor a pagar) */
function rolarTotais(app) {
  app.querySelectorAll('.portfolio-totals .card').forEach((card) => {
    const forte = card.querySelector('strong'), rot = card.querySelector('.muted'); if (!forte || !rot) return;
    const cents = Math.round(parseFloat(forte.textContent.replace(/[^\d,]/g, '').replace(',', '.')) * 100); if (!Number.isFinite(cents)) return;
    const s = mola('tot:' + rot.textContent.trim(), 0, 160, 22); alvo(s, cents);
    forte.style.fontVariantNumeric = 'tabular-nums';
    viva(forte, [s], () => { forte.textContent = brlTxt(s.x); });
  });
}

/* entrada escalonada: só quando a tela ou o fornecedor mudam */
function entrada(app, chave) {
  if (chave === ultimaChave) return; ultimaChave = chave;
  const alvos = [...app.children, ...app.querySelectorAll('.pn-c, .pn-g, .pn-e, .pn-r, .supplier-card, tbody tr, .allocation-card')];
  let o = 0;
  alvos.forEach((n) => { if (n.id === 'pn' || n.hidden) return; n.style.setProperty('--o', Math.min(o++, 14)); n.classList.remove('entra'); void n.offsetWidth; n.classList.add('entra'); });
}

window.PainelUI = {
  depois({ db, page, app, fornecedor }) {
    if (page === 'Painel' && db.entries.length) {
      const hero = app.querySelector('.hero');
      if (hero && !app.querySelector('#pn')) (app.querySelector('#wa-quadro') || hero).after(montar(db));
    }
    rolarTotais(app);
    entrada(app, page + '|' + (fornecedor || ''));
  },
};
