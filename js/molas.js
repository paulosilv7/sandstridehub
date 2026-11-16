// Motor de molas do sistema Sandstride (biblioteca de motions do briefing de design).
// Uma mola é { x posição, v velocidade, t alvo, k rigidez, c amortecimento }.
// Um único laço de animação, que só roda enquanto alguma mola ainda se mexe.
// Valores e regras: nota "Motions por mola do briefing de design Sandstride" (Segundo Cérebro).
const reduz = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

export const S = (x, k = 400, c = 30) => ({ x, v: 0, t: x, k, c });
// "Reduzir movimento": amortecimento crítico, só desliza, sem balanço
export const ajustar = (s, k, c) => { s.k = k; s.c = reduz() ? 2 * Math.sqrt(k) : c; };
export const passo = (s, dt) => { const a = -s.k * (s.x - s.t) - s.c * s.v; s.v += a * dt; s.x += s.v * dt; };
export const limitar = (v, a, b) => Math.max(a, Math.min(b, v));
export const parada = (s, e = 0.02) => Math.abs(s.x - s.t) < e && Math.abs(s.v) < e * 20;

const tempos = [];
export const depois = (seg, fn) => { const t = { t: seg, fn }; tempos.push(t); acordar(); return t; };
export const cancelar = (t) => { const i = tempos.indexOf(t); if (i > -1) tempos.splice(i, 1); };

const comps = [];
let rodando = false, ultimo = 0;
// componente: { quadro(dt), desenhar(), ativo() }
export const registrar = (c) => { comps.push(c); return c; };
export function acordar() { if (!rodando) { rodando = true; ultimo = performance.now(); requestAnimationFrame(laco); } }
function laco(agora) {
  const dt = Math.min((agora - ultimo) / 1000, 1 / 30); ultimo = agora;
  for (let i = tempos.length - 1; i >= 0; i--) if ((tempos[i].t -= dt) <= 0) tempos.splice(i, 1)[0].fn();
  const sub = 4;
  for (let k = 0; k < sub; k++) comps.forEach((c) => c.quadro(dt / sub));
  comps.forEach((c) => c.desenhar());
  for (let i = comps.length - 1; i >= 0; i--) if (comps[i].fim && comps[i].fim()) comps.splice(i, 1);
  if (tempos.length || comps.some((c) => c.ativo())) requestAnimationFrame(laco); else rodando = false;
}

// Pílula que estica: a borda que vai na frente é dura, a de trás é mole ("pontos de paginação").
// Uso: const p = pilula(elemento); p.ir(esquerda, largura); (a primeira chamada não anima)
export function pilula(el) {
  const A = S(0), B = S(0);
  let pronto = false;
  const c = registrar({
    quadro(dt) { passo(A, dt); passo(B, dt); },
    desenhar() { el.style.transform = `translateX(${A.x.toFixed(2)}px)`; el.style.width = Math.max(8, B.x - A.x).toFixed(2) + 'px'; },
    ativo() { return !(parada(A) && parada(B)); },
    fim() { return !el.isConnected; },
  });
  return {
    ir(esq, larg, direto) {
      const frente = esq >= A.t;
      A.t = esq; B.t = esq + larg;
      if (direto || !pronto) { A.x = A.t; B.x = B.t; A.v = B.v = 0; pronto = true; c.desenhar(); return; }
      if (frente) { ajustar(B, 520, 34); ajustar(A, 140, 18); } else { ajustar(A, 520, 34); ajustar(B, 140, 18); }
      acordar();
    },
    de(esq, larg) { A.x = A.t = esq; B.x = B.t = esq + larg; A.v = B.v = 0; pronto = true; c.desenhar(); },
  };
}

// Texto de espera com onda de opacidade nas letras ("texto pensando"). Devolve HTML.
export function onda(texto) {
  return '<span class="onda" aria-label="' + String(texto).replace(/"/g, '&quot;') + '">' +
    [...String(texto)].map((ch, i) => '<span aria-hidden="true" style="animation-delay:' + (i * 0.07).toFixed(2) + 's">' + (ch === ' ' ? '&nbsp;' : ch.replace(/[<&>]/g, (m) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[m]))) + '</span>').join('') + '</span>';
}

// Botão "Carregando → sucesso" (briefing, motion 2): a pílula fecha num círculo com anel girando e, quando a ação termina,
// abre numa pílula verde com o ✓ se desenhando. Molas: largura 300/22, rótulo 400/30, anel 300/28, sucesso 220/20, cor 200/30, ✓ 120/20.
// Uso: const b = botaoAcao(botao, { ok: 'Salvo' }); b.rodar(async () => { ...; return true /* ou false se falhou */ });
// O tempo de "carregando" é o da ação real. Volta ao estado parado 1,8 s depois do sucesso.
export function botaoAcao(btn, { ok = 'Salvo', carregando = 'Salvando…' } = {}) {
  const rot = btn.textContent.trim();
  btn.classList.add('ba-b');
  btn.innerHTML = '<span class="ba-r"></span><span class="ba-anel" aria-hidden="true"><i></i></span><span class="ba-ok" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7"/></svg><b></b></span><span class="ba-sr" role="status"></span>';
  const r = btn.querySelector('.ba-r'), anel = btn.querySelector('.ba-anel'), okEl = btn.querySelector('.ba-ok'), tique = okEl.querySelector('path'), sr = btn.querySelector('.ba-sr');
  r.textContent = rot; okEl.querySelector('b').textContent = ok;
  tique.style.strokeDasharray = 22;
  const W = S(0, 300, 22), R = S(1, 400, 30), A = S(0, 300, 28), O = S(0, 220, 20), G = S(0, 200, 30), T = S(0, 120, 20);
  let estado = 'parado', largura0 = 0, ocupado = false, volta = null;
  const alvo = (e) => {
    estado = e;
    [[W, 300, 22], [R, 400, 30], [A, 300, 28], [O, 220, 20], [G, 200, 30], [T, 120, 20]].forEach(([m, k, c]) => ajustar(m, k, c));
    if (e === 'carregando') { W.t = btn.offsetHeight || 40; R.t = 0; A.t = 1; O.t = 0; G.t = 0; T.t = 0; }
    else if (e === 'sucesso') { W.t = Math.max(largura0, okEl.querySelector('b').offsetWidth + 64); R.t = 0; A.t = 0; O.t = 1; G.t = 1; depois(0.15, () => { T.t = 1; acordar(); }); }
    else { W.t = largura0; R.t = 1; A.t = 0; O.t = 0; G.t = 0; T.t = 0; }
    acordar();
  };
  const c = registrar({
    quadro(dt) { [W, R, A, O, G, T].forEach((m) => passo(m, dt)); },
    desenhar() {
      if (estado === 'parado' && parada(W) && parada(R)) { btn.style.width = ''; btn.style.background = ''; btn.style.color = ''; r.style.opacity = r.style.transform = ''; anel.style.opacity = okEl.style.opacity = '0'; return; }
      const g = limitar(G.x, 0, 1);
      btn.style.width = W.x.toFixed(1) + 'px';
      btn.style.background = `color-mix(in srgb, var(--recebido) ${(g * 100).toFixed(0)}%, ${getComputedStyle(btn).getPropertyValue('--ba-fundo') || 'var(--texto)'})`;
      btn.style.color = `color-mix(in srgb, #fff ${(g * 100).toFixed(0)}%, var(--cartao))`;
      r.style.opacity = limitar(R.x, 0, 1); r.style.transform = `translateY(${((1 - limitar(R.x, 0, 1)) * -14).toFixed(1)}px)`;
      anel.style.opacity = limitar(A.x, 0, 1); anel.style.transform = `scale(${(0.6 + 0.4 * limitar(A.x, 0, 1.2)).toFixed(3)})`;
      okEl.style.opacity = limitar(O.x, 0, 1); okEl.style.transform = `translateY(${((1 - limitar(O.x, 0, 1)) * 14).toFixed(1)}px)`;
      tique.style.strokeDashoffset = (22 * (1 - limitar(T.x, 0, 1))).toFixed(2);
    },
    ativo() { return !(parada(W) && parada(R) && parada(A) && parada(O) && parada(G) && parada(T)); },
    fim() { return !btn.isConnected; },
  });
  void c;
  return {
    async rodar(fn) {
      if (ocupado) return false;
      ocupado = true; clearTimeout(volta);
      largura0 = btn.offsetWidth; W.x = W.t = largura0; btn.style.width = largura0 + 'px';
      btn.disabled = true; btn.setAttribute('aria-busy', 'true'); sr.textContent = carregando; alvo('carregando');
      const ini = performance.now(); let certo = false;
      try { certo = (await fn()) !== false; } catch (e) { certo = false; }
      const falta = 280 - (performance.now() - ini); if (falta > 0) await new Promise((res) => setTimeout(res, falta));
      btn.removeAttribute('aria-busy');
      if (certo) { sr.textContent = ok; alvo('sucesso'); volta = setTimeout(() => { alvo('parado'); btn.disabled = false; ocupado = false; sr.textContent = ''; }, 1800); }
      else { sr.textContent = ''; alvo('parado'); btn.disabled = false; ocupado = false; }
      return certo;
    },
  };
}

if (typeof window !== 'undefined') window.Molas = { S, ajustar, passo, limitar, parada, depois, cancelar, registrar, acordar, pilula, onda, botaoAcao };
