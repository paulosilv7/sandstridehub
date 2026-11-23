// Funções puras compartilhadas pelas telas da Central (Meu dia, Placar, Prioridades, Revisão, Ideias, detalhe de tarefa).
// Não importa nenhuma tela: é a base de que todas dependem.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const svg = (d, t = 18) => `<svg class="i" width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const IC = {
  repetir: '<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  rotina: '<path d="M4 6.5 5.5 8 8 5M4 12.5 5.5 14 8 11M4 18.5 5.5 20 8 17M11 6.5h9M11 12.5h9M11 18.5h9"/>',
  tarefa: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1ZM8 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 13l2 2 4-4"/>',
  meta: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01"/>',
  equipe: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  lapis: '<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  texto: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  relogio: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2"/>',
  alerta: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
  caixa: '<path d="M3 8 12 3l9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8"/>',
  copiar: '<path d="M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
};
export const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'], DIAS_N = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const TZ = 'America/Sao_Paulo';
export const hojeISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export const dataDe = (iso) => new Date(iso + 'T12:00:00Z');
export const soma = (iso, n) => { const d = dataDe(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const fDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const fCurto = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
export const fMes = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
export const nBR = (n, c = 0) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
export const valor = (n, un) => (un === 'reais' ? `R$ ${nBR(n, 2)}` : un === 'pct' ? `${nBR(n, Number.isInteger(+n) ? 0 : 1)}%` : nBR(n));
export const prim = (nome) => String(nome || '').split(' ')[0];
