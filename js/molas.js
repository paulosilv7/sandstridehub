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

if (typeof window !== 'undefined') window.Molas = { S, ajustar, passo, limitar, parada, depois, cancelar, registrar, acordar, pilula, onda };
