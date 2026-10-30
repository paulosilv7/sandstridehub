// Chats Sandstride: site que junta as conversas das lojas e deixa a equipe responder.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ------------------------------------------------------------------ */
/* Constantes e utilitários                                            */
/* ------------------------------------------------------------------ */
const MKS = {
  mercado_livre: { k: 'ml', nome: 'Mercado Livre', sigla: 'ML' },
  shopee: { k: 'sp', nome: 'Shopee', sigla: 'SP' },
  tiktok_shop: { k: 'tt', nome: 'TikTok Shop', sigla: 'TT' },
};
const LOGO = { ml: 'img/mercadolivre.png', sp: 'img/shopee.png', tt: 'img/tiktokshop.png' };
const logo = (k, nome) => `<span class="mk mk-${k}"><img src="${LOGO[k]}" alt="${esc(nome)}"></span>`;
const TIPO = { pos_venda: 'Pós-venda', pergunta: 'Pergunta do anúncio', chat: 'Chat' };
const ESCOPO = { todas: 'Todas as lojas', mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop' };
const ST_PEDIDO = { paid: 'Pago', confirmed: 'Confirmado', cancelled: 'Cancelado', payment_required: 'Aguardando pagamento', payment_in_process: 'Pagamento em análise', partially_paid: 'Parcialmente pago', unpaid: 'Aguardando pagamento', ready_to_ship: 'Pronto para envio', processed: 'Preparado para coleta', shipped: 'Enviado', to_confirm_receive: 'Entregue', in_cancel: 'Cancelamento solicitado', to_return: 'Devolução solicitada', completed: 'Concluído', delivered: 'Entregue', awaiting_shipment: 'Aguardando envio', awaiting_collection: 'Aguardando coleta', in_transit: 'Em trânsito', on_hold: 'Em espera' };
const ST_ENVIO = { pending: 'Pendente', handling: 'Preparando', ready_to_ship: 'Pronto para envio', shipped: 'Enviado', delivered: 'Entregue', not_delivered: 'Não entregue', cancelled: 'Cancelado' };
const FALAS = {
  feliz: ['Que dia produtivo! Obrigada pela parceria.', 'Adoro quando a caixa de entrada fica assim.', 'Cliente bem atendido volta a comprar!'],
  tranquila: ['Por aqui está tudo em ordem.', 'Estou de olho em tudo, pode ficar tranquilo.', 'Dia calmo, bom para organizar a casa.'],
  preocupada: ['Vamos começar pelas mais antigas?', 'Essas conversas não podem esperar muito.', 'Quem puder, assume uma delas?'],
  brava: ['Esses clientes estão bem bravos.', 'Respira fundo, a gente resolve uma por vez.', 'Vamos tratar cada caso com calma.'],
  cansada: ['Foram muitos clientes hoje, hein?', 'Que equipe incrível!', 'Hora de um cafezinho?'],
};
const TZ = 'America/Sao_Paulo';
const fDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fDM = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const fHoraCheia = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inicial = (n) => esc(String(n || '?').charAt(0).toUpperCase());
const pl = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const curto = (min) => (min < 60 ? `${min} min` : `${min / 60} h`);
function fmt(min) {
  if (min < 60) return `há ${min} min`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `há ${h} h ${m} min` : `há ${h} h`; }
  const d = Math.floor(min / 1440); return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}
function quando(iso) {
  const d = new Date(iso), k = fDia.format(d), h = fHora.format(d);
  if (k === fDia.format(new Date())) return `Hoje, ${h}`;
  if (k === fDia.format(new Date(Date.now() - 86400000))) return `Ontem, ${h}`;
  return `${fDM.format(d)}, ${h}`;
}
function inicioDoDia() { return new Date(`${fDia.format(new Date())}T00:00:00-03:00`); }
function cumprimento() {
  const h = Number(fHoraCheia.format(new Date()));
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}
let tToast;
function toast(m) {
  const t = $('toast'); t.textContent = m; t.hidden = false;
  clearTimeout(tToast); tToast = setTimeout(() => { t.hidden = true; }, 5000);
}
function beep() {
  try {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const a = new C(), o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, a.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.4);
    o.start(); o.stop(a.currentTime + 0.45);
  } catch (_) { /* sem som */ }
}
async function mensagemDeErro(error, padrao) {
  try {
    const r = error?.context;
    if (r && typeof r.json === 'function') { const j = await r.json(); if (j?.erro) return j.erro; }
  } catch (_) { /* usa o padrão */ }
  return padrao;
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */
const S = {
  user: null, eu: null,
  lojas: [], etiquetas: [], rapidas: [], equipe: [], convs: [], msgs: [], msgsDe: null,
  cfg: { ativo: true, aviso: 120, urgente: 360, som: true, quem: 'responsavel', dias: 7 },
  view: 'inbox', tela: 'lista', painel: window.innerWidth >= 1200, msg: '', fala: '', pula: false,
  status: 'todas', mk: 'todos', loja: 'todas', atend: 'todos', etq: 'todas', busca: '', sel: null,
  draft: '', anexos: [], aviso: '', enviando: false,
  hoje: 0, editRap: null, novaRap: false, delRap: null, delMembro: null,
  alertados: new Set(), conhecidas: null, sigThread: '',
};
const urlsAnexo = new Map();

/* ------------------------------------------------------------------ */
/* Dados                                                               */
/* ------------------------------------------------------------------ */
function lerConfig(linhas) {
  const m = Object.fromEntries((linhas || []).map((l) => [l.chave, l.valor]));
  S.cfg = {
    ativo: (m.alerta_ativo ?? 'true') === 'true',
    aviso: Number(m.alerta_aviso_min ?? 120),
    urgente: Number(m.alerta_urgente_min ?? 360),
    som: (m.alerta_som ?? 'true') === 'true',
    quem: m.alerta_quem ?? 'responsavel',
    dias: Number(m.dias_retencao ?? 7),
  };
}
function normalizar(row) {
  const loja = S.lojas.find((l) => l.id === row.loja_id);
  const mk = MKS[loja?.marketplace] ?? MKS.mercado_livre;
  const atendente = S.equipe.find((u) => u.usuario_id === row.atendente_id);
  const espera = row.aguardando_resposta && !row.situacao && row.ultima_mensagem_em
    ? Math.max(0, Math.floor((Date.now() - new Date(row.ultima_mensagem_em).getTime()) / 60000)) : 0;
  const tags = (row.conversa_etiquetas || []).map((x) => S.etiquetas.find((e) => e.id === x.etiqueta_id)?.nome).filter(Boolean);
  const pedido = (row.tipo === 'pos_venda' || row.tipo === 'chat') && row.pedido_id_externo ? `#${row.pedido_id_externo}` : '';
  const produto = row.produto_titulo || '';
  return {
    id: row.id, lojaId: row.loja_id, lojaNome: loja?.nome ?? 'Loja', mkKey: loja?.marketplace ?? 'mercado_livre', mk: mk.k, sigla: mk.sigla, mkNome: mk.nome,
    tipo: row.tipo, nome: row.cliente_nome || 'Cliente', aguardando: row.aguardando_resposta && !row.situacao, situacao: row.situacao || null, situacaoDetalhe: row.situacao_detalhe || '', espera,
    bloqueada: row.bloqueada, motivo: row.motivo_bloqueio, atendenteId: row.atendente_id,
    atendenteNome: atendente?.nome ?? null, ia: row.atendida_por_ia, escalada: row.escalada_motivo,
    ultimaTexto: row.ultima_mensagem_texto || '', ultimaDe: row.ultima_mensagem_de, ultimaEm: row.ultima_mensagem_em,
    tags, pedido, produto, dados: row.dados_extras || {},
    refRotulo: row.tipo === 'pos_venda' ? 'Pedido' : 'Anúncio',
    ref: row.tipo === 'pos_venda' ? [pedido, produto].filter(Boolean).join(' · ') || 'Sem detalhes do pedido' : (produto || 'Anúncio'),
  };
}
async function carregarBase() {
  const [l, e, r, c, q] = await Promise.all([
    sb.from('lojas').select('id, marketplace, nome, id_externo, ativa, sandy_ativa').order('nome'),
    sb.from('etiquetas').select('id, nome, ordem').order('ordem').order('nome'),
    sb.from('respostas_rapidas').select('id, titulo, texto, escopo').order('titulo'),
    sb.from('configuracoes').select('chave, valor'),
    sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome'),
  ]);
  S.lojas = l.data || []; S.etiquetas = e.data || []; S.rapidas = r.data || []; S.equipe = q.data || [];
  lerConfig(c.data);
}
async function carregarConversas() {
  const { data, error } = await sb.from('conversas')
    .select('*, conversa_etiquetas(etiqueta_id)')
    .order('ultima_mensagem_em', { ascending: false, nullsFirst: false }).limit(500);
  if (error) { console.error(error); return; }
  const antes = S.conhecidas;
  S.convs = (data || []).map(normalizar);
  // Aviso de mensagem nova
  const agora = new Map(S.convs.map((c) => [c.id, c]));
  if (antes) {
    for (const c of S.convs) {
      const velho = antes.get(c.id);
      if (c.aguardando && c.ultimaDe === 'cliente' && (!velho || !velho.aguardando || velho.ultimaEm !== c.ultimaEm)) avisarNova(c);
    }
  }
  S.conhecidas = agora;
}
function avisarNova(c) {
  const texto = `Nova mensagem de ${c.nome} (${c.lojaNome})`;
  if (S.cfg.ativo) { toast(texto); if (S.cfg.som) beep(); }
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('Sandstride', { body: texto }); } catch (_) { /* ignora */ }
  }
}
async function carregarMensagens(id) {
  S.msgsDe = id;
  const { data } = await sb.from('mensagens').select('*').eq('conversa_id', id).order('enviada_em', { ascending: true });
  if (S.msgsDe === id) S.msgs = data || [];
}
async function carregarHoje() {
  // Clientes diferentes que receberam resposta hoje (não o total de mensagens).
  const { data } = await sb.from('mensagens').select('conversa_id')
    .eq('de', 'loja').gte('enviada_em', inicioDoDia().toISOString()).limit(5000);
  S.hoje = new Set((data || []).map((r) => r.conversa_id)).size;
}
const atual = () => S.convs.find((c) => c.id === S.sel) || null;
const eu = () => S.eu?.nome || '';
const souAdmin = () => S.eu?.papel === 'admin';

/* ------------------------------------------------------------------ */
/* Regras de exibição                                                  */
/* ------------------------------------------------------------------ */
const parada = (c) => c.aguardando && !c.bloqueada && c.espera >= S.cfg.aviso;
const SITUACAO = {
  cancelado: { t: 'Cancelada', cls: 'warn' },
  devolucao: { t: 'Devolução', cls: 'warn' },
  devolvido: { t: 'Devolvida', cls: 'neutral' },
  reclamacao: { t: 'Reclamação', cls: 'warn' },
  analise_ml: { t: 'Em análise no marketplace', cls: 'warn' },
};
// Situações em que o marketplace não aceita mensagens do vendedor.
const SEM_ENVIO = ['cancelado', 'devolucao', 'devolvido', 'analise_ml'];
// Cancelamento e devolução já concluídos vão para Respondidas; só o que ainda está em tratamento fica em "Com o marketplace".
const ENCERRADAS = ['cancelado', 'devolvido'];
const emTratamento = (c) => !!c.situacao && !ENCERRADAS.includes(c.situacao);
function estilo(c) {
  if (c.situacao && SITUACAO[c.situacao]) return SITUACAO[c.situacao];
  if (c.bloqueada) return { t: 'Bloqueada', cls: 'warn' };
  if (!c.aguardando) return { t: 'Respondida', cls: 'good' };
  if (c.espera < S.cfg.aviso) return { t: fmt(c.espera), cls: 'neutral' };
  if (c.espera < S.cfg.urgente) return { t: fmt(c.espera), cls: 'warn' };
  return { t: fmt(c.espera), cls: 'bad' };
}
function respTxt(c) {
  if (c.ia) return 'Sandy atendendo';
  if (!c.atendenteId && c.escalada) return 'Precisa de uma pessoa';
  if (c.atendenteId === S.user?.id) return 'Você está atendendo';
  return c.atendenteNome ? `Atendendo: ${c.atendenteNome}` : 'Sem responsável';
}
const etqCls = (n) => `e${Math.max(0, S.etiquetas.findIndex((e) => e.nome === n)) % 4}`;
const norm = (t) => String(t || '').toLowerCase().replace(/#/g, '');
function casa(c) {
  if (S.status === 'aguardando' && !c.aguardando) return false;
  if (S.status === 'respondidas' && (c.aguardando || emTratamento(c))) return false;
  if (S.status === 'marketplace' && !emTratamento(c)) return false;
  if (S.mk !== 'todos' && c.mkKey !== S.mk) return false;
  if (S.loja !== 'todas' && c.lojaId !== S.loja) return false;
  if (S.atend === 'minhas' && c.atendenteId !== S.user?.id) return false;
  if (S.atend === 'livres' && (c.atendenteId || c.ia)) return false;
  if (S.etq !== 'todas' && !c.tags.includes(S.etq)) return false;
  const q = norm(S.busca.trim());
  if (q) {
    const base = norm([c.nome, c.pedido, c.produto, c.ultimaTexto, c.tags.join(' ')].join(' '));
    const nas = S.sel === c.id ? norm(S.msgs.map((m) => m.texto).join(' ')) : '';
    if (!base.includes(q) && !nas.includes(q)) return false;
  }
  return true;
}
function preencher(texto, c) {
  const primeiro = String(c.nome).split(/[\s._]+/)[0].replace(/\d+/g, '');
  const nome = primeiro ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase() : '';
  const mapa = { nome, pedido: c.pedido, produto: c.produto, loja: c.lojaNome };
  return texto.replace(/\{(nome|pedido|produto|loja)\}/g, (m, k) => mapa[k] || m);
}

/* ------------------------------------------------------------------ */
/* Sandy                                                               */
/* ------------------------------------------------------------------ */
function sandySvg(mood, suf) {
  const G = '#E6EEFF';
  let e, b = '', x = '', al, ar;
  switch (mood) {
    case 'feliz':
      e = `<path d="M68 100q11-17 22 0M110 100q11-17 22 0" fill="none" stroke="${G}" stroke-width="6" stroke-linecap="round"/>`;
      b = `<path d="M84 114q16 22 32 0z" fill="${G}"/>`;
      x = '<circle cx="62" cy="116" r="6" fill="#FF9DB5" opacity=".75"/><circle cx="138" cy="116" r="6" fill="#FF9DB5" opacity=".75"/>';
      al = 'rotate(-40 30 100)'; ar = 'rotate(40 170 100)'; break;
    case 'preocupada':
      e = `<rect x="70" y="90" width="17" height="21" rx="6" fill="${G}"/><rect x="113" y="90" width="17" height="21" rx="6" fill="${G}"/><path d="M66 80l22-8M134 80l-22-8" stroke="${G}" stroke-width="4" stroke-linecap="round"/>`;
      b = `<path d="M86 124q4-6 8 0t8 0t8 0" fill="none" stroke="${G}" stroke-width="4" stroke-linecap="round"/>`;
      x = '<path d="M166 58q9 13 0 20q-9-7 0-20z" fill="#9DB8F5"/>';
      al = 'rotate(-12 30 100)'; ar = 'rotate(12 170 100)'; break;
    case 'brava':
      e = '<rect x="68" y="90" width="20" height="17" rx="5" fill="#FF8A80"/><rect x="112" y="90" width="20" height="17" rx="5" fill="#FF8A80"/><path d="M62 80l28 11M138 80l-28 11" stroke="#FF8A80" stroke-width="5" stroke-linecap="round"/>';
      b = '<path d="M86 128q14-14 28 0" fill="none" stroke="#FF8A80" stroke-width="5" stroke-linecap="round"/>';
      x = '<path d="M50 38q-7-9 1-15M150 38q7-9-1-15M100 18q-5-8 1-13" fill="none" stroke="#E57373" stroke-width="3" stroke-linecap="round"/>';
      al = 'rotate(38 30 100)'; ar = 'rotate(-38 170 100)'; break;
    case 'cansada':
      e = `<rect x="66" y="98" width="24" height="7" rx="3.5" fill="${G}"/><rect x="110" y="98" width="24" height="7" rx="3.5" fill="${G}"/><path d="M68 112q10 6 20 0M112 112q10 6 20 0" fill="none" stroke="#7C8FC9" stroke-width="3" stroke-linecap="round"/>`;
      b = `<ellipse cx="100" cy="129" rx="7" ry="9" fill="${G}"/>`;
      x = '<path d="M158 52q8 12 0 18q-8-6 0-18z" fill="#9DB8F5"/>';
      al = 'rotate(48 30 100)'; ar = 'rotate(-48 170 100)'; break;
    default:
      e = `<rect x="68" y="88" width="20" height="20" rx="6" fill="${G}"/><rect x="112" y="88" width="20" height="20" rx="6" fill="${G}"/>`;
      b = `<path d="M86 120q14 11 28 0" fill="none" stroke="${G}" stroke-width="4.5" stroke-linecap="round"/>`;
      al = 'rotate(18 30 100)'; ar = 'rotate(-18 170 100)';
  }
  const nomeHumor = { feliz: 'feliz', tranquila: 'tranquila', preocupada: 'preocupada', brava: 'brava', cansada: 'cansada' }[mood] || 'tranquila';
  const gid = `hg${suf}`;
  const brav = mood === 'brava' ? ' stroke="#E57373" stroke-width="2"' : '';
  return `<svg class="sv-${mood}" viewBox="0 0 200 200" role="img" aria-label="Sandy, atendente virtual, ${nomeHumor}"><defs><radialGradient id="${gid}" cx=".35" cy=".25" r=".95"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D8D8D3"/></radialGradient></defs>` +
    '<ellipse cx="100" cy="190" rx="46" ry="6" fill="#000000" opacity=".08"/><g class="fl">' +
    `<g transform="${al}"><ellipse cx="22" cy="106" rx="13" ry="27" fill="url(#${gid})" stroke="#D0D0CB" stroke-width="1.5"/></g>` +
    `<g${mood === 'feliz' ? ' class="acena"' : ''}><g transform="${ar}"><ellipse cx="178" cy="106" rx="13" ry="27" fill="url(#${gid})" stroke="#D0D0CB" stroke-width="1.5"/></g></g>` +
    '<path d="M100 40V26" stroke="#C9C9C4" stroke-width="4" stroke-linecap="round"/><circle cx="100" cy="21" r="7" fill="#BCCBF5"/>' +
    `<rect x="24" y="38" width="152" height="132" rx="60" fill="url(#${gid})" stroke="#D0D0CB" stroke-width="1.5"/>` +
    '<path d="M44 62q10-14 30-17" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" opacity=".9"/>' +
    `<rect x="42" y="58" width="116" height="90" rx="36" fill="#1A1A1A"${brav}/>${e}${b}${x}</g></svg>`;
}
function metricas() {
  const cs = S.convs;
  return {
    pend: cs.filter((c) => c.aguardando && !c.bloqueada).length,
    paradas: cs.filter(parada).length,
    rec: cs.filter((c) => c.tags.includes('Reembolso') || c.tags.includes('Defeito') || (c.escalada && !c.atendenteId)).length,
    total: S.hoje,
  };
}
function humorAtual(m) {
  if (m.rec >= 3) return 'brava';
  if (m.total >= 25) return 'cansada';
  if (m.paradas >= 1 && S.cfg.ativo) return 'preocupada';
  if (m.pend === 0 && m.total === 0) return 'tranquila';
  if (m.pend === 0 || m.total >= 10) return 'feliz';
  return 'tranquila';
}
function renderSandy() {
  const el = $('sandy'); if (!el) return;
  const m = metricas(), hu = humorAtual(m);
  const cli = (n) => pl(n, 'cliente', 'clientes');
  const aguarda = m.pend === 0 ? 'ninguém aguarda resposta' : `${m.pend === 1 ? '1 ainda aguarda' : `${m.pend} ainda aguardam`} resposta`;
  const feitos = m.total === 0 ? 'ainda não respondemos ninguém hoje' : `já respondemos ${cli(m.total)} hoje`;
  const txt = {
    feliz: m.pend === 0
      ? `Dia produtivo! Já respondemos ${cli(m.total)} hoje e ninguém está esperando.`
      : `Dia produtivo! Já respondemos ${cli(m.total)} hoje e só ${m.pend === 1 ? '1 cliente aguarda' : `${m.pend} clientes aguardam`} resposta.`,
    tranquila: m.total === 0 && m.pend === 0
      ? 'Hoje o dia foi bem tranquilo, não tivemos nenhum movimento por cá.'
      : `Hoje está tranquilo: ${feitos} e ${aguarda}.`,
    preocupada: `Estou de olho: ${pl(m.paradas, 'conversa está', 'conversas estão')} sem resposta há mais de ${curto(S.cfg.aviso)}. Vale começar ${m.paradas === 1 ? 'por ela' : 'por elas'}.${m.total ? ` Já respondemos ${cli(m.total)} hoje.` : ''}`,
    brava: `Hoje está pesado: ${pl(m.rec, 'conversa tem', 'conversas têm')} reclamação ou problema sério. Vale priorizá-${m.rec === 1 ? 'la' : 'las'}.`,
    cansada: `Uau, já respondemos ${cli(m.total)} hoje. Que ritmo! Se der, distribuam as conversas mais delicadas.`,
  }[hu];
  const score = m.pend + m.paradas + m.rec;
  const nivel = ['Tranquilo', 'Movimentado', 'Corrido', 'Sobrecarregado'][score <= 2 ? 0 : score <= 5 ? 1 : score <= 9 ? 2 : 3];
  const nc = { Tranquilo: 'ok', Movimentado: 'at', Corrido: 'at', Sobrecarregado: 'ru' }[nivel];
  el.innerHTML =
    `<button type="button" class="sandy-fig${S.pula ? ' pula' : ''}" data-act="sandy-clica" aria-label="Conversar com a Sandy">${sandySvg(hu, 'a')}</button>` +
    `<div class="sandy-txt"><h2>${cumprimento()}, ${esc(eu())}.</h2><p>${esc(txt)}</p>` +
    (S.fala ? `<span class="fala" role="status">${esc(S.fala)}</span>` : '') + '</div>' +
    `<div class="sandy-nums" aria-label="Resumo do dia"><div class="sn"><b>${m.pend}</b><span>Aguardando</span></div><div class="sn"><b>${m.total}</b><span>Clientes respondidos</span></div><div class="sn ${nc}"><b>${nivel}</b><span>Ritmo do dia</span></div></div>`;
  S.pula = false;
}

/* ------------------------------------------------------------------ */
/* Chats                                                    */
/* ------------------------------------------------------------------ */
function renderChrome() {
  const aguard = S.convs.filter((c) => c.aguardando).length;
  $('navCount').textContent = aguard; $('navCount').dataset.n = String(aguard);
  document.title = `${aguard ? `(${aguard}) ` : ''}Chats Sandstride`;
  const fp = S.eu?.foto_path;
  const nomeEu = eu();
  $('eu').title = `${nomeEu} · ${souAdmin() ? 'Administrador' : 'Atendente'}`;
  $('eu').innerHTML = fp ? `<img src="${esc(`${SUPABASE_URL}/storage/v1/object/public/avatares/${fp}`)}" alt="${esc(nomeEu)}">` : esc(String(nomeEu || '?').trim().charAt(0).toUpperCase());
}
function renderFilters() {
  const total = S.convs.length, aguard = S.convs.filter((c) => c.aguardando).length;
  const fora = S.convs.filter(emTratamento).length;
  const tip = { marketplace: 'Devoluções, reclamações e análises que o Mercado Livre ainda está tratando. Quando resolvidas, vão para Respondidas. Não entram nas métricas de não respondidas.' };
  const st = [['todas', 'Todas', total], ['aguardando', 'Não respondidas', aguard], ['marketplace', 'Com o marketplace', fora], ['respondidas', 'Respondidas', total - aguard - fora]];
  $('seg').innerHTML = st.map((x) => `<button type="button" class="seg-b" data-act="status" data-v="${x[0]}" aria-pressed="${S.status === x[0]}"${tip[x[0]] ? ` title="${tip[x[0]]}"` : ''}><span class="seg-n">${x[2]}</span><span class="seg-l">${x[1]}</span></button>`).join('');
  const mk = [['todos', 'Todos', null], ['mercado_livre', 'Mercado Livre', 'ml'], ['shopee', 'Shopee', 'sp'], ['tiktok_shop', 'TikTok Shop', 'tt']];
  $('mks').innerHTML = mk.map((x) => `<button type="button" class="pill${x[2] ? ` logo pk-${x[2]}` : ''}" data-act="mk" data-v="${x[0]}" aria-pressed="${S.mk === x[0]}" aria-label="${x[1]}" title="${x[1]}">${x[2] ? logo(x[2], x[1]) : x[1]}</button>`).join('');
  const at = [['todos', 'Todos'], ['minhas', 'Minhas'], ['livres', 'Sem responsável']];
  $('ats').innerHTML = at.map((x) => `<button type="button" class="pill sm" data-act="atend" data-v="${x[0]}" aria-pressed="${S.atend === x[0]}">${x[1]}</button>`).join('');
  const lojasVisiveis = S.lojas.filter((l) => S.mk === 'todos' || l.marketplace === S.mk);
  if (S.loja !== 'todas' && !lojasVisiveis.some((l) => l.id === S.loja)) S.loja = 'todas';
  $('loja').innerHTML = '<option value="todas">Todas</option>' + lojasVisiveis.map((l) => `<option value="${l.id}"${S.loja === l.id ? ' selected' : ''}>${esc(l.nome)}</option>`).join('');
  if (S.etq !== 'todas' && !S.etiquetas.some((e) => e.nome === S.etq)) S.etq = 'todas';
  $('etqSel').innerHTML = '<option value="todas">Todas</option>' + S.etiquetas.map((e) => `<option value="${esc(e.nome)}"${S.etq === e.nome ? ' selected' : ''}>${esc(e.nome)}</option>`).join('');
}
function renderList() {
  const lista = S.convs.filter(casa).sort((a, b) => (Number(b.aguardando) - Number(a.aguardando)) || (b.espera - a.espera));
  $('rows').innerHTML = lista.length ? lista.map((c) => {
    const e = estilo(c);
    const et = c.tags.slice(0, 2).map((n) => `<span class="etq sm ${etqCls(n)}">${esc(n)}</span>`).join('') + (c.tags.length > 2 ? `<span class="etq sm e1">+${c.tags.length - 2}</span>` : '');
    return `<button type="button" class="row" data-act="sel" data-id="${c.id}" aria-pressed="${c.id === S.sel}"><span class="av">${inicial(c.nome)}</span><span class="rb">` +
      `<span class="r1"><span class="nm">${esc(c.nome)}</span><span class="tg ${e.cls}">${esc(e.t)}</span></span>` +
      `<span class="r2">${logo(c.mk, c.mkNome)}<span class="tx">${esc(c.lojaNome)} · ${TIPO[c.tipo] ?? ''}</span></span>` +
      `<span class="r3">${c.ultimaDe === 'loja' ? 'Você: ' : c.ultimaDe === 'sistema' ? `${esc(c.mkNome)}: ` : ''}${esc(c.ultimaTexto)}</span>` +
      (et ? `<span class="rowetq">${et}</span>` : '') +
      `<span class="resp${c.atendenteId === S.user?.id ? ' eu' : ''}">${esc(respTxt(c))}</span></span></button>`;
  }).join('') : `<div class="vazio">${S.convs.length ? 'Nenhuma conversa com esses filtros.' : 'Nenhuma conversa ainda. Quando chegar uma pergunta ou mensagem em uma loja conectada, ela aparece aqui sozinha.'}</div>`;
}
function linhasPainel(c) {
  const d = c.dados || {};
  const L = [];
  if (d.tipo === 'pedido') {
    if (d.item?.titulo) L.push(['Produto', d.item.titulo]);
    if (d.item?.variacao) L.push(['Variação', d.item.variacao]);
    if (d.item?.quantidade) L.push(['Quantidade', String(d.item.quantidade)]);
    if (d.total != null) L.push(['Valor', brl.format(d.total)]);
    if (d.pagamento) L.push(['Pagamento', String(d.pagamento).replace(/_/g, ' ')]);
    if (d.feito_em) L.push(['Feito em', quando(d.feito_em)]);
    if (d.envio?.status) L.push(['Envio', ST_ENVIO[d.envio.status] || d.envio.status]);
    if (d.envio?.rastreio) L.push(['Rastreio', d.envio.rastreio]);
    if (d.envio?.cidade) L.push(['Destino', `${d.envio.cidade}${d.envio.uf ? `-${String(d.envio.uf).replace('BR-', '')}` : ''}`]);
  } else if (d.tipo === 'anuncio') {
    if (d.titulo) L.push(['Produto', d.titulo]);
    if (d.preco != null) L.push(['Preço', brl.format(d.preco)]);
    if (d.estoque != null) L.push(['Estoque', `${d.estoque} un.`]);
    if (d.vendidos != null) L.push(['Vendas', String(d.vendidos)]);
    if (d.status) L.push(['Situação', d.status === 'active' ? 'Ativo' : d.status === 'paused' ? 'Pausado' : d.status]);
  }
  return L;
}
function painelHtml(c) {
  const d = c.dados || {}, ped = d.tipo === 'pedido';
  const linhas = linhasPainel(c);
  let chip = '';
  if (ped) {
    const t = d.envio?.status ? (ST_ENVIO[d.envio.status] || d.envio.status) : (ST_PEDIDO[d.status] || d.status || '');
    const cls = d.envio?.status === 'delivered' ? 'good' : d.status === 'cancelled' ? 'bad' : 'neutral';
    if (t) chip = `<span class="tg ${cls}" style="margin-left:0;align-self:flex-start;white-space:normal">${esc(t)}</span>`;
  }
  return `<aside class="painel" aria-label="${ped ? 'Dados do pedido' : 'Dados do anúncio'}"><div class="lin"><h3>${ped ? esc(c.pedido || 'Pedido') : 'Anúncio'}</h3><span class="sp"></span><button type="button" class="x" data-act="toggle-painel" aria-label="Fechar painel">×</button></div>${chip}` +
    (linhas.length ? linhas.map((l) => `<div class="dl"><span>${esc(l[0])}</span><span>${esc(l[1])}</span></div>`).join('') : '<p class="mut" style="margin:0">Ainda não temos os dados desta conversa.</p>') +
    (d.link ? `<a class="lnk" href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">Abrir anúncio</a>` : '') +
    (c.pedido ? '<button type="button" class="bt2" data-act="copiar" style="align-self:flex-start">Copiar nº do pedido</button>' : '') + '</aside>';
}
function anexosHtml(arr) {
  const itens = (arr || []).filter((a) => a && a.tipo !== 'anuncio');
  if (!itens.length) return '';
  return '<div class="anx">' + itens.map((a) => {
    if (a.path && a.tipo === 'img') return `<button type="button" class="foto" data-act="zoom" data-path="${esc(a.path)}" aria-label="Ampliar foto ${esc(a.nome)}"><img data-path="${esc(a.path)}" alt="${esc(a.nome)}" style="min-height:60px;min-width:60px"></button>`;
    return `<span class="arq">${esc(a.nome || a.filename || a.original_filename || 'Anexo')}</span>`;
  }).join('') + '</div>';
}
function ajustaDraft(d) { d.style.height = 'auto'; d.style.height = Math.min(d.scrollHeight, 110) + 'px'; }
function renderThread() {
  const box = $('thread'); if (!box) return;
  const c = atual();
  if (!c) { box.innerHTML = '<div class="vazio" style="margin:auto;text-align:center">Escolha uma conversa na lista para responder.</div>'; S.sigThread = ''; return; }
  const sig = JSON.stringify([c.id, c.atendenteId, c.ia, c.bloqueada, c.situacao, c.tags, c.escalada, c.aguardando, c.dados, S.msgs.map((m) => m.id + m.estado), S.painel, S.anexos.map((a) => a.nome), S.aviso, S.enviando, S.rapidas.length, eu()]);
  const foco = document.activeElement?.id === 'draft';
  const selIni = foco ? document.activeElement.selectionStart : 0;
  const e = estilo(c);
  const meu = c.atendenteId === S.user?.id;
  const outro = (c.atendenteId && !meu) || c.ia;
  const msgs = S.msgs.map((m) => {
    // Avisos automáticos do marketplace (rastreio, pedido de reembolso, atalho de atendimento etc.).
    if (m.de === 'sistema') return `<div class="msg sis"><div class="bub">${esc(m.texto || 'Aviso do marketplace')}</div><div class="when">${esc(c.mkNome || 'Marketplace')} · ${esc(quando(m.enviada_em))}</div></div>`;
    const loja = m.de === 'loja';
    const quem = loja ? (m.enviada_por_ia ? '<span class="iab">Sandy</span> ' : (S.equipe.find((u) => u.usuario_id === m.enviada_por)?.nome ?? 'Loja')) : esc(c.nome);
    return `<div class="msg ${loja ? 'loja' : 'cli'}">${m.texto ? `<div class="bub">${esc(m.texto)}</div>` : ''}${anexosHtml(m.anexos)}<div class="when">${loja && !m.enviada_por_ia ? esc(quem) : quem} · ${esc(quando(m.enviada_em))}</div></div>`;
  }).join('') || '<p class="mut">Carregando mensagens…</p>';
  let rodape;
  if (c.situacao && SEM_ENVIO.includes(c.situacao)) rodape = `<p class="aviso"><strong>${esc(SITUACAO[c.situacao].t)}${c.situacao === 'analise_ml' ? '' : ' no ' + esc(MKS[c.mkKey]?.nome || 'marketplace')}.</strong> ${esc(c.situacaoDetalhe || 'O marketplace não aceita mensagens neste momento.')} Acompanhe pelo painel do ${esc(MKS[c.mkKey]?.nome || 'marketplace')}. Esta conversa não conta nas não respondidas.</p>`;
  else if (c.bloqueada) rodape = `<p class="aviso">${esc(c.motivo || 'O marketplace bloqueou as respostas desta conversa.')}</p>`;
  else if (c.mkKey !== 'mercado_livre' && c.mkKey !== 'tiktok_shop' && c.mkKey !== 'shopee') rodape = '<p class="aviso">O envio de respostas por esta loja ainda não está disponível aqui. Responda pelo aplicativo do marketplace.</p>';
  else if (outro) {
    rodape = `<p class="aviso">${c.ia ? 'A Sandy está atendendo esta conversa. Se você assumir, ela para de responder aqui.' : `${esc(c.atendenteNome || 'Outra pessoa')} está atendendo esta conversa. Para responder, assuma a conversa.`}</p><div class="acoes"><button type="button" class="btn" data-act="assumir">${c.ia ? 'Assumir e pausar a Sandy' : 'Assumir conversa'}</button></div>`;
  } else {
    const rap = S.rapidas.filter((r) => r.escopo === 'todas' || r.escopo === c.mkKey);
    const pode = c.tipo !== 'pergunta';
    rodape = '<div class="comp">' +
      (c.situacao === 'reclamacao' ? `<p class="aviso"><strong>Reclamação aberta.</strong> ${esc(c.situacaoDetalhe)} O marketplace pode recusar mensagens. Esta conversa não conta nas não respondidas.</p>` : '') +
      (c.escalada && !c.atendenteId ? `<p class="aviso"><strong>A Sandy passou esta conversa para a equipe.</strong> ${esc(c.escalada)}</p>` : '') +
      `<div class="rap"><span class="eyebrow">Respostas rápidas</span>${rap.length ? rap.map((r) => `<button type="button" class="chipr" data-act="rapida" data-id="${r.id}">${esc(r.titulo)}</button>`).join('') : '<span class="mut">Nenhuma cadastrada para esta loja.</span>'}</div>` +
      (S.aviso ? `<p class="aviso" role="alert">${esc(S.aviso)}</p>` : '') +
      (S.anexos.length ? `<div class="prevs">${S.anexos.map((a, i) => `<div class="pv">${a.tipo === 'img' ? `<img src="${esc(a.prev)}" alt="${esc(a.nome)}">` : `<span class="arq">${esc(a.nome)}</span>`}<button type="button" data-act="rm-anexo" data-i="${i}" aria-label="Remover ${esc(a.nome)}">×</button></div>`).join('')}</div>` : '') +
      '<div class="envio">' +
      (pode ? '<label class="bt2 anex" for="arq" title="Anexar fotos ou arquivos"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14.5 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="sr">Anexar</span></label><input id="arq" class="sr" type="file" accept="image/*,.pdf" multiple>' : '') +
      `<textarea id="draft" rows="1" placeholder="Escreva a resposta" aria-label="Escreva a resposta" autocomplete="off"></textarea><button type="button" class="btn" data-act="enviar"${S.enviando ? ' disabled' : ''}>${S.enviando ? 'Enviando…' : 'Enviar'}</button></div></div>`;
  }
  const livres = S.etiquetas.filter((x) => !c.tags.includes(x.nome));
  const etqs = '<div class="etqs">' + c.tags.map((n) => `<span class="etq ${etqCls(n)}">${esc(n)}<button type="button" data-act="rm-etq" data-n="${esc(n)}" aria-label="Remover etiqueta ${esc(n)}">×</button></span>`).join('') +
    (livres.length ? `<select class="bt2" data-act="add-etq" aria-label="Adicionar etiqueta"><option value="">+ Tag</option>${livres.map((x) => `<option value="${x.id}">${esc(x.nome)}</option>`).join('')}</select>` : '') + '</div>';
  const nomeDados = c.tipo === 'pos_venda' ? 'dados do pedido' : 'dados do anúncio';
  box.innerHTML =
    `<div class="th-h"><button type="button" class="voltar" data-act="voltar"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12 4 6 10l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Conversas</button>` +
    `<span class="av big">${inicial(c.nome)}</span><div class="th-n">${esc(c.nome)}</div><span class="tg2">${logo(c.mk, c.mkNome)}${esc(c.lojaNome)}</span>` +
    etqs + '<span class="sp"></span>' +
    (meu && !c.bloqueada ? '<button type="button" class="bt2" data-act="liberar">Liberar conversa</button>' : '') +
    `<button type="button" class="bt2" data-act="toggle-painel" aria-pressed="${S.painel}">${S.painel ? 'Ocultar' : 'Ver'} ${nomeDados}</button></div>` +
    `<div class="corpo"><div class="col-msg"><div class="msgs" id="msgs">${msgs}</div>${rodape}</div>${S.painel ? painelHtml(c) : ''}</div>`;
  S.sigThread = sig;
  const d = $('draft');
  if (d) { d.value = S.draft; ajustaDraft(d); if (foco) { d.focus(); try { d.setSelectionRange(selIni, selIni); } catch (_) { /* ok */ } } }
  const mb = $('msgs'); if (mb) mb.scrollTop = mb.scrollHeight;
  resolverImagens();
}
async function urlAnexo(path) {
  if (urlsAnexo.has(path)) return urlsAnexo.get(path);
  const { data } = await sb.storage.from('anexos').createSignedUrl(path, 3600);
  if (data?.signedUrl) urlsAnexo.set(path, data.signedUrl);
  return data?.signedUrl || null;
}
function resolverImagens() {
  document.querySelectorAll('img[data-path]').forEach(async (img) => {
    const u = await urlAnexo(img.getAttribute('data-path'));
    if (u) img.src = u;
  });
}
function renderInbox() {
  renderChrome(); renderSandy(); renderFilters(); renderList(); renderThread();
  const cols = $('cols'); if (cols) cols.setAttribute('data-tela', S.tela);
}
function renderLeve() { renderChrome(); renderSandy(); renderFilters(); renderList(); }

/* ------------------------------------------------------------------ */
/* Outras telas                                                        */
/* ------------------------------------------------------------------ */
const notaHtml = () => (S.msg ? `<p class="nota" role="status">${esc(S.msg)}</p>` : '');
const comVars = (t) => esc(t).replace(/\{(nome|pedido|produto|loja)\}/g, '<span class="var">{$1}</span>');
const opts = (lista, atualV, fn) => lista.map((v) => `<option value="${v}"${String(atualV) === String(v) ? ' selected' : ''}>${fn(v)}</option>`).join('');
function formRap(r) {
  r = r || { titulo: '', texto: '', escopo: 'todas' };
  return `<div class="box"><h2>${r.id ? 'Editar resposta' : 'Nova resposta'}</h2><div class="form2">` +
    `<label class="campo"><span class="eyebrow">Título</span><input id="f-titulo" type="text" maxlength="40" value="${esc(r.titulo)}" placeholder="Ex.: Prazo de envio"></label>` +
    `<label class="campo"><span class="eyebrow">Vale para</span><select id="f-escopo">${Object.keys(ESCOPO).map((k) => `<option value="${k}"${r.escopo === k ? ' selected' : ''}>${ESCOPO[k]}</option>`).join('')}</select></label></div>` +
    `<label class="campo"><span class="eyebrow">Texto</span><textarea id="f-texto" maxlength="1000" placeholder="Mensagem que será inserida na resposta">${esc(r.texto)}</textarea></label>` +
    `<div class="rap"><span class="eyebrow">Inserir variável</span>${['nome', 'pedido', 'produto', 'loja'].map((v) => `<button type="button" class="chipr" data-act="ins-var" data-v="{${v}}">{${v}}</button>`).join('')}</div>` +
    '<p class="mut" style="margin:0">As variáveis são trocadas pelos dados da conversa: {nome} (primeiro nome do cliente), {pedido}, {produto} e {loja}.</p>' +
    `<div class="acoes"><button type="button" class="btn" data-act="salvar-rap" data-id="${esc(r.id || '')}">Salvar</button><button type="button" class="bt2" data-act="cancelar-rap">Cancelar</button></div></div>`;
}
function vistaRapidas() {
  let h = `<p class="sub">Textos prontos que aparecem como botões ao responder. Use {nome}, {pedido}, {produto} e {loja} e o sistema preenche com os dados da conversa.</p>${notaHtml()}`;
  if (S.novaRap || S.editRap) h += formRap(S.rapidas.find((x) => x.id === S.editRap));
  else h += '<div class="acoes"><button type="button" class="btn" data-act="nova-rap">Nova resposta</button></div>';
  h += '<div class="grade">' + S.rapidas.map((r) => {
    const ap = S.delRap === r.id
      ? `<span class="mut">Apagar mesmo?</span><button type="button" class="bt2 perigo" data-act="apagar-rap" data-id="${r.id}">Sim, apagar</button><button type="button" class="bt2" data-act="cancelar-apagar">Não</button>`
      : `<button type="button" class="bt2" data-act="editar-rap" data-id="${r.id}">Editar</button><button type="button" class="bt2" data-act="pedir-apagar" data-id="${r.id}">Apagar</button>`;
    return `<div class="box"><div class="lin"><h2>${esc(r.titulo)}</h2><span class="sp"></span><span class="tg2 info">${ESCOPO[r.escopo]}</span></div><div class="txt">${comVars(r.texto)}</div><div class="acoes">${ap}</div></div>`;
  }).join('') + '</div>';
  return h;
}
const PALAVRAS_PADRAO = '';
async function carregarSandy() {
  const [c, b, g] = await Promise.all([
    sb.from('configuracoes').select('chave, valor').in('chave', ['sandy_ativa', 'sandy_escalar_palavras']),
    sb.from('sandy_conhecimento').select('id, titulo, texto, escopo, ativo').order('titulo'),
    sb.from('sandy_registros').select('id, conversa_id, decisao, motivo, resposta, criado_em').order('criado_em', { ascending: false }).limit(25),
  ]);
  const m = Object.fromEntries((c.data || []).map((x) => [x.chave, x.valor]));
  S.sandy = { ativa: m.sandy_ativa === 'true', palavras: m.sandy_escalar_palavras ?? PALAVRAS_PADRAO, base: b.data || [], reg: g.data || [] };
}
function formBase(b) {
  b = b || { titulo: '', texto: '', escopo: 'todas' };
  return `<div class="box"><h2>${b.id ? 'Editar informação' : 'Nova informação'}</h2><div class="form2">` +
    `<label class="campo"><span class="eyebrow">Assunto</span><input id="sb-titulo" type="text" maxlength="120" value="${esc(b.titulo)}" placeholder="Ex.: Prazo de envio"></label>` +
    `<label class="campo"><span class="eyebrow">Vale para</span><select id="sb-escopo">${Object.keys(ESCOPO).map((k) => `<option value="${k}"${b.escopo === k ? ' selected' : ''}>${ESCOPO[k]}</option>`).join('')}</select></label></div>` +
    `<label class="campo"><span class="eyebrow">O que a Sandy deve saber e dizer</span><textarea id="sb-texto" maxlength="4000" placeholder="Escreva como você explicaria para um cliente. Ex.: Enviamos em até 2 dias úteis depois da aprovação do pagamento.">${esc(b.texto)}</textarea></label>` +
    `<div class="acoes"><button type="button" class="btn" data-act="sandy-salvar-base" data-id="${esc(b.id || '')}">Salvar</button><button type="button" class="bt2" data-act="sandy-cancelar">Cancelar</button></div></div>`;
}
const DECISAO = { respondeu: ['Respondeu', 'info'], escalou: ['Passou para a equipe', 'warn'], ignorou: ['Não atuou', 'info'], erro: ['Erro', 'warn'] };
function vistaSandy() {
  const y = S.sandy, ad = souAdmin(), dis = ad ? '' : ' disabled';
  if (!y) return '<p class="mut">Carregando…</p>';
  let h = `<p class="sub">A Sandy responde sozinha as perguntas simples dos clientes e passa para a equipe tudo o que for delicado. ${ad ? '' : 'Só administradores alteram esta tela.'}</p>${notaHtml()}`;
  h += `<div class="box"><h2>Atendimento automático</h2><div class="txt">Enquanto estiver desligado, a Sandy não envia nada. Ligue por loja, começando por uma só, e acompanhe o que ela fez no registro abaixo. Se você ou alguém da equipe assumir uma conversa, ela para de responder ali.</div>` +
    `<label class="chk"><input id="sy-ativa" type="checkbox"${y.ativa ? ' checked' : ''}${dis}>Sandy ligada</label>` +
    `<span class="eyebrow">Lojas em que ela pode atender</span><div class="grade">${S.lojas.filter((l) => l.ativa).map((l) => `<label class="chk"><input class="sy-loja" data-id="${l.id}" type="checkbox"${l.sandy_ativa ? ' checked' : ''}${dis}>${esc(l.nome)} <span class="mut">${esc(MKS[l.marketplace]?.nome || '')}</span></label>`).join('')}</div>` +
    `<label class="campo"><span class="eyebrow">Assuntos que sempre vão para uma pessoa (palavras separadas por vírgula)</span><textarea id="sy-palavras" maxlength="3000"${dis}>${esc(y.palavras)}</textarea></label>` +
    '<p class="mut" style="margin:0">Se a mensagem do cliente tiver qualquer uma dessas palavras, a Sandy nem tenta responder: marca a conversa como "Precisa de uma pessoa". Pedido errado, defeito, cancelamento, devolução e reembolso têm tratamento próprio: ela acolhe o cliente com um texto padrão e passa para a equipe. Assuntos graves (Procon, golpe etc.) ficam numa lista à parte.</p>' +
    (ad ? '<div class="acoes"><button type="button" class="btn" data-act="sandy-salvar-geral">Salvar</button></div>' : '') + '</div>';
  h += '<div class="box"><h2>O que a Sandy sabe</h2><div class="txt">Ela só responde com o que estiver aqui. Se a resposta não estiver nestas informações, ela passa a conversa para a equipe em vez de inventar.</div></div>';
  if (S.novaBase || S.editBase) h += formBase(y.base.find((x) => x.id === S.editBase));
  else if (ad) h += '<div class="acoes"><button type="button" class="btn" data-act="sandy-nova">Nova informação</button></div>';
  h += '<div class="grade">' + (y.base.map((b) => {
    const ap = !ad ? '' : S.delBase === b.id
      ? `<span class="mut">Apagar mesmo?</span><button type="button" class="bt2 perigo" data-act="sandy-apagar" data-id="${b.id}">Sim, apagar</button><button type="button" class="bt2" data-act="sandy-cancelar">Não</button>`
      : `<button type="button" class="bt2" data-act="sandy-editar" data-id="${b.id}">Editar</button><button type="button" class="bt2" data-act="sandy-pedir-apagar" data-id="${b.id}">Apagar</button>`;
    return `<div class="box"><div class="lin"><h2>${esc(b.titulo)}</h2><span class="sp"></span><span class="tg2 info">${ESCOPO[b.escopo]}</span></div><div class="txt">${esc(b.texto)}</div><div class="acoes">${ap}</div></div>`;
  }).join('') || '<p class="mut">Nenhuma informação cadastrada ainda.</p>') + '</div>';
  h += '<div class="box"><h2>O que a Sandy fez</h2>' + (y.reg.length ? y.reg.map((g) => {
    const c = S.convs.find((x) => x.id === g.conversa_id), d = DECISAO[g.decisao] || [g.decisao, 'info'];
    return `<div class="lin"><div style="flex:1;min-width:160px"><div class="nm" style="white-space:normal">${esc(c?.nome || 'Conversa')} <span class="mut">${esc(quando(g.criado_em))}</span></div><div class="mut" style="white-space:normal">${esc(g.resposta || g.motivo || '')}</div></div><span class="tg2 ${d[1]}">${d[0]}</span></div>`;
  }).join('') : '<p class="mut" style="margin:0">Ainda não houve atendimento da Sandy.</p>') + '</div>';
  return h;
}
function vistaConfig() {
  const c = S.cfg, ad = souAdmin(), dis = ad ? '' : ' disabled';
  let h = `<p class="sub">Avisos, etiquetas, equipe e armazenamento. ${ad ? '' : 'Só administradores alteram esta tela.'}</p>${notaHtml()}`;
  h += `<div class="box"><h2>Aviso de conversa parada</h2><div class="txt">A Sandy avisa na caixa de entrada, o tempo de espera muda de cor e você recebe um aviso quando chegar mensagem nova.</div>` +
    `<label class="chk"><input id="cf-ativo" type="checkbox"${c.ativo ? ' checked' : ''}${dis}>Avisar sobre conversas paradas e mensagens novas</label>` +
    `<div class="form2"><label class="campo"><span class="eyebrow">Avisar depois de</span><select id="cf-aviso"${dis}>${opts([30, 60, 120, 180], c.aviso, curto)}</select></label>` +
    `<label class="campo"><span class="eyebrow">Marcar como urgente depois de</span><select id="cf-urgente"${dis}>${opts([120, 240, 360, 720], c.urgente, curto)}</select></label></div>` +
    `<label class="chk"><input id="cf-som" type="checkbox"${c.som ? ' checked' : ''}${dis}>Tocar som no computador</label>` +
    (ad ? '<div class="acoes"><button type="button" class="btn" data-act="salvar-alerta">Salvar</button><button type="button" class="bt2" data-act="testar-alerta">Testar aviso</button></div>' : '') + '</div>';
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  h += `<div class="box"><h2>Avisos neste navegador</h2><div class="txt">${notif === 'granted' ? 'Ativados. Você recebe um aviso do navegador quando chegar mensagem com a aba em segundo plano.' : notif === 'denied' ? 'Bloqueados no navegador. Libere nas configurações do site para receber avisos.' : notif === 'unsupported' ? 'Este navegador não permite avisos.' : 'Receba um aviso do navegador quando chegar mensagem com a aba em segundo plano. Vale para este aparelho.'}</div>` +
    (notif === 'default' ? '<div class="acoes"><button type="button" class="btn" data-act="ativar-notif">Ativar avisos</button></div>' : '') + '</div>';
  h += `<div class="box"><h2>Etiquetas de problemas</h2><div class="txt">Servem para quem assumir a conversa entender rápido do que se trata.</div><div class="etqs">${S.etiquetas.map((e) => `<span class="etq ${etqCls(e.nome)}">${esc(e.nome)}${ad ? `<button type="button" data-act="rm-etq-cfg" data-id="${e.id}" aria-label="Apagar etiqueta ${esc(e.nome)}">×</button>` : ''}</span>`).join('')}</div>` +
    (ad ? '<div class="envio"><input id="n-etq" type="text" maxlength="24" placeholder="Nova etiqueta" aria-label="Nova etiqueta"><button type="button" class="btn" data-act="add-etq-cfg">Adicionar</button></div>' : '') + '</div>';
  h += '<div class="box"><h2>Equipe</h2>' + S.equipe.filter((m) => m.nome !== 'Sandy').map((m) => {
    const eh = m.usuario_id === S.user?.id;
    const rm = eh ? '<span class="mut">Você</span>' : !ad ? '' : (S.delMembro === m.usuario_id
      ? `<span class="mut">Remover?</span><button type="button" class="bt2 perigo" data-act="rm-membro" data-id="${m.usuario_id}">Sim, remover</button><button type="button" class="bt2" data-act="cancelar-apagar">Não</button>`
      : `<button type="button" class="bt2" data-act="pedir-rm" data-id="${m.usuario_id}">Remover</button>`);
    const papel = eh || !ad ? `<span class="tg2 info">${m.papel === 'admin' ? 'Administrador' : 'Atendente'}</span>`
      : `<select class="bt2" data-act="papel" data-id="${m.usuario_id}" aria-label="Função de ${esc(m.nome)}"><option value="atendente"${m.papel === 'atendente' ? ' selected' : ''}>Atendente</option><option value="admin"${m.papel === 'admin' ? ' selected' : ''}>Administrador</option></select>`;
    return `<div class="lin membro"><span class="av">${inicial(m.nome)}</span><div style="flex:1;min-width:140px"><div class="nm" style="white-space:normal">${esc(m.nome)}</div></div>${papel}${rm}</div>`;
  }).join('') + '</div>';
  if (ad) {
    h += '<div class="box"><h2>Convidar atendente</h2><div class="form2"><label class="campo"><span class="eyebrow">Nome</span><input id="c-nome" type="text" maxlength="40" placeholder="Nome da pessoa"></label>' +
      '<label class="campo"><span class="eyebrow">E-mail</span><input id="c-email" type="email" maxlength="80" placeholder="pessoa@email.com"></label></div>' +
      '<div class="acoes"><button type="button" class="btn" data-act="convidar">Enviar convite</button></div><p class="mut" style="margin:0">A pessoa recebe um e-mail com o link para criar a senha.</p></div>';
    h += `<div class="box"><h2>Armazenamento</h2><div class="txt">Conversas já respondidas são apagadas depois do prazo abaixo. Conversas sem resposta nunca são apagadas.</div><label class="campo" style="max-width:260px"><span class="eyebrow">Guardar respondidas por</span><select id="c-dias">${opts([3, 7, 14, 30], c.dias, (d) => `${d} dias`)}</select></label><div class="acoes"><button type="button" class="btn" data-act="salvar-dias">Salvar</button></div></div>`;
  }
  h += '<div class="box"><h2>Sua conta</h2><div class="acoes"><a class="bt2" href="../" style="text-decoration:none;display:inline-flex;align-items:center">Voltar para a central</a><button type="button" class="bt2" data-act="sair">Sair</button></div></div>';
  return h;
}
const TITULOS = { inbox: 'Chats', rapidas: 'Respostas rápidas', sandy: 'Sandy', config: 'Configurações' };
function renderView() {
  const inbox = S.view === 'inbox';
  $('v-inbox').hidden = !inbox; $('vista').hidden = inbox;
  $('vista').dataset.v = S.view;
  $('titulo').textContent = TITULOS[S.view];
  document.querySelectorAll('.dock [data-act="view"]').forEach((b) => {
    if (b.getAttribute('data-v') === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (!inbox) $('vista').innerHTML = S.view === 'rapidas' ? vistaRapidas() : S.view === 'sandy' ? vistaSandy() : vistaConfig();
}

/* ------------------------------------------------------------------ */
/* Telas de entrada                                                    */
/* ------------------------------------------------------------------ */
function telaLogin(msg = '', modo = 'entrar') {
  const rec = modo === 'recuperar';
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="formLogin" novalidate><div class="fig">${sandySvg('tranquila', 'l')}</div><h1>Chats Sandstride</h1><p class="sub">${rec ? 'Informe seu e-mail e enviaremos um link para criar uma nova senha.' : 'Entre com o e-mail e a senha da equipe.'}</p>` +
    (msg ? `<p class="erro" role="alert">${esc(msg)}</p>` : '') +
    '<label class="campo"><span class="eyebrow">E-mail</span><input id="l-email" type="email" autocomplete="username" required></label>' +
    (rec ? '' : '<label class="campo"><span class="eyebrow">Senha</span><input id="l-senha" type="password" autocomplete="current-password" required></label>') +
    `<button type="submit" class="btn" style="justify-content:center">${rec ? 'Enviar link' : 'Entrar'}</button>` +
    `<button type="button" class="link" data-act="${rec ? 'voltar-login' : 'esqueci'}">${rec ? 'Voltar para o login' : 'Esqueci a senha'}</button></form></div>`;
  $('formLogin').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = $('l-email').value.trim();
    if (!email) return telaLogin('Informe o e-mail.', modo);
    if (rec) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      return telaLogin(error ? 'Não consegui enviar o link. Tente de novo em instantes.' : 'Se esse e-mail estiver cadastrado, o link chega em alguns minutos.', modo);
    }
    const senha = $('l-senha').value;
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    if (error) return telaLogin('E-mail ou senha incorretos.', modo);
    iniciar();
  });
}
function telaNovaSenha(msg = '') {
  $('raiz').innerHTML = `<div class="login"><form class="login-card" id="formSenha" novalidate><div class="fig">${sandySvg('feliz', 'n')}</div><h1>Crie sua senha</h1><p class="sub">Escolha uma senha com pelo menos 8 caracteres.</p>` +
    (msg ? `<p class="erro" role="alert">${esc(msg)}</p>` : '') +
    '<label class="campo"><span class="eyebrow">Nova senha</span><input id="s-1" type="password" autocomplete="new-password" required></label>' +
    '<label class="campo"><span class="eyebrow">Repita a senha</span><input id="s-2" type="password" autocomplete="new-password" required></label>' +
    '<button type="submit" class="btn" style="justify-content:center">Salvar e entrar</button></form></div>';
  $('formSenha').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const a = $('s-1').value, b = $('s-2').value;
    if (a.length < 8) return telaNovaSenha('A senha precisa ter pelo menos 8 caracteres.');
    if (a !== b) return telaNovaSenha('As senhas não são iguais.');
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return telaNovaSenha('Não consegui salvar a senha. Tente de novo.');
    history.replaceState(null, '', location.pathname);
    iniciar();
  });
}
function telaSemAcesso() {
  $('raiz').innerHTML = `<div class="login"><div class="login-card"><div class="fig">${sandySvg('preocupada', 's')}</div><h1>Acesso ainda não liberado</h1><p class="sub">Você ainda não tem acesso à caixa de entrada. Peça a um administrador para liberar.</p><button type="button" class="btn" style="justify-content:center" data-act="sair">Sair</button></div></div>`;
}

/* ------------------------------------------------------------------ */
/* Casca do aplicativo                                                 */
/* ------------------------------------------------------------------ */
const ICONES = {
  inbox: '<path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 13h5.5l1 2.5h5l1-2.5H21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  sandy: '<path d="M12 3l1.8 4.7L18.5 9.500 13.800 11.300 12 16l-1.800-4.700L5.500 9.500l4.700-1.800L12 3Zm6.500 11 .8 2.200 2.200.8-2.200.8-.8 2.200-.8-2.200-2.200-.8 2.200-.8.8-2.200Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  rapidas: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  config: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="6" r="2" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="12" r="2" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="18" r="2" stroke="currentColor" stroke-width="1.8"/>',
};
function montarCasca() {
  $('raiz').innerHTML = `<div class="shell">
  <main class="main">
    <div class="topo-pg"><img class="hlogo" src="../img/sandstride-escuro.png" alt="Sandstride"><span class="hsep" aria-hidden="true"></span><h1 id="titulo">Chats</h1><span class="sp"></span>
      <label class="busca-top"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.8"/><path d="m14 14 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><input id="busca" type="search" placeholder="Cliente ou pedido" aria-label="Buscar cliente, pedido ou mensagem" autocomplete="off"></label>
      <span class="live"><i id="liveDot"></i><span id="liveTxt">Conectando…</span></span></div>
    <div class="inbox" id="v-inbox">
      <section class="sandy" id="sandy" aria-label="Sandy, atendente virtual"></section>
      <div class="cols" id="cols" data-tela="lista">
        <section class="card lista" aria-label="Lista de conversas">
          <div class="seg" id="seg" role="group" aria-label="Situação da conversa"></div>
          <div class="mks" id="mks" role="group" aria-label="Marketplace"></div>
          <div class="dupla"><label class="loja"><span class="eyebrow">Loja</span><span class="sel"><select id="loja" aria-label="Filtrar por loja"></select></span></label>
          <label class="loja"><span class="eyebrow">Tag</span><span class="sel"><select id="etqSel" aria-label="Filtrar por tag"></select></span></label></div>
          <div class="filtros2"><span class="eyebrow">Atendente</span><div class="mks" id="ats" role="group" aria-label="Atendente"></div></div>
          <div class="rows" id="rows"></div>
        </section>
        <section class="card thread" id="thread" aria-label="Conversa aberta"></section>
      </div>
    </div>
    <div class="vista" id="vista" hidden></div>
  </main></div>
  <nav class="dock" aria-label="Menu rápido">
    <a class="bk" href="../" aria-label="Voltar para a central" title="Central Sandstride"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.5 9.8V19a1 1 0 0 0 1 1H9.5v-5.2h5V20h3a1 1 0 0 0 1-1V9.8"/></svg></a>
    <div class="av" id="eu" title="Quem está acessando">·</div>
    <div class="sp1"></div>
    <button type="button" class="bk" data-act="view" data-v="inbox" aria-label="Chats" title="Caixa de entrada"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONES.inbox}</svg><span class="bdg" id="navCount">0</span></button>
    <button type="button" class="bk" data-act="view" data-v="rapidas" aria-label="Respostas rápidas" title="Respostas rápidas"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONES.rapidas}</svg></button>
    <button type="button" class="bk" data-act="view" data-v="sandy" aria-label="Sandy" title="Sandy"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONES.sandy}</svg></button>
    <button type="button" class="bk" data-act="view" data-v="config" aria-label="Configurações" title="Configurações"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONES.config}</svg></button>
  </nav>`;
}
function marcarConexao(ok) {
  const d = $('liveDot'), t = $('liveTxt'); if (!d || !t) return;
  d.style.background = ok ? 'var(--good)' : 'var(--warn)';
  t.textContent = ok ? 'Atualizando em tempo real' : 'Reconectando…';
}

/* ------------------------------------------------------------------ */
/* Tempo real                                                          */
/* ------------------------------------------------------------------ */
let canal = null, tRecarga = null;
function agendarRecarga() {
  clearTimeout(tRecarga);
  tRecarga = setTimeout(async () => {
    await carregarConversas();
    if (S.sel && S.msgsDe === S.sel) await carregarMensagens(S.sel);
    await carregarHoje();
    if (S.view === 'inbox') { renderLeve(); renderThread(); }
  }, 350);
}
function ligarTempoReal() {
  if (canal) sb.removeChannel(canal);
  const tabela = (t) => ({ event: '*', schema: 'public', table: t });
  canal = sb.channel('caixa-de-entrada')
    .on('postgres_changes', tabela('conversas'), agendarRecarga)
    .on('postgres_changes', tabela('mensagens'), agendarRecarga)
    .on('postgres_changes', tabela('conversa_etiquetas'), agendarRecarga)
    .subscribe((st) => marcarConexao(st === 'SUBSCRIBED'));
}
async function recarregarBaseEVisao() {
  await carregarBase(); await carregarConversas();
  if (S.view === 'inbox') renderInbox(); else renderView();
}

/* ------------------------------------------------------------------ */
/* Ações                                                                */
/* ------------------------------------------------------------------ */
const val = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
function ir(v) {
  S.view = v; S.msg = ''; S.editRap = null; S.novaRap = false; S.delRap = null; S.delMembro = null; S.editBase = null; S.novaBase = false; S.delBase = null;
  renderView(); if (v === 'inbox') renderInbox();
  if (v === 'sandy') carregarSandy().then(() => { if (S.view === 'sandy') renderView(); });
}
async function escolher(id) {
  S.sel = id; S.draft = ''; S.anexos = []; S.aviso = ''; S.msgs = []; S.tela = 'conversa';
  renderInbox(); window.scrollTo(0, 0);
  await carregarMensagens(id); renderThread();
}
function limparAnexos() { S.anexos.forEach((a) => a.prev && URL.revokeObjectURL(a.prev)); S.anexos = []; }
async function enviar() {
  const c = atual(); if (!c || S.enviando) return;
  const texto = S.draft.trim();
  if (!texto && !S.anexos.length) return;
  if (/\{(nome|pedido|produto|loja)\}/.test(texto)) {
    S.aviso = 'Ainda há variáveis sem preenchimento entre chaves (por exemplo {pedido}). Complete ou apague antes de enviar.';
    renderThread(); $('draft')?.focus(); return;
  }
  if ((c.mkKey === 'tiktok_shop' || c.mkKey === 'shopee') && S.anexos.length) { S.aviso = 'Nesta loja o envio de anexos ainda não está disponível. Envie só texto.'; renderThread(); return; }
  S.enviando = true; S.aviso = ''; renderThread();
  try {
    const anexos = [];
    for (const a of S.anexos) {
      const seguro = a.nome.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `${c.id}/${crypto.randomUUID()}-${seguro}`;
      const { error } = await sb.storage.from('anexos').upload(path, a.file, { contentType: a.file.type });
      if (error) throw new Error(`Não consegui enviar o anexo ${a.nome}.`);
      anexos.push({ tipo: a.tipo, nome: a.nome, path });
    }
    const { data, error } = await sb.functions.invoke({ tiktok_shop: 'tiktok-responder', shopee: 'shopee-responder' }[c.mkKey] || 'ml-responder', { body: { conversa_id: c.id, texto, anexos } });
    if (error || !data?.ok) throw new Error(await mensagemDeErro(error, data?.erro || 'Não consegui enviar. Tente de novo.'));
    S.draft = ''; limparAnexos();
    await carregarMensagens(c.id); await carregarConversas(); await carregarHoje();
    S.enviando = false; renderInbox();
    $('draft')?.focus();
  } catch (e) {
    S.enviando = false; S.aviso = e.message || 'Não consegui enviar. Tente de novo.'; renderThread();
  }
}
async function rpc(nome, id) {
  const { error } = await sb.rpc(nome, { p_conversa: id });
  if (error) { toast('Não foi possível alterar a conversa. Tente de novo.'); return false; }
  await carregarConversas(); renderInbox(); return true;
}
async function guardar(pedido, ok) {
  const { error } = await pedido;
  if (error) { S.msg = 'Não foi possível salvar. Confira se você tem permissão e tente de novo.'; renderView(); return false; }
  if (ok) S.msg = ok;
  return true;
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
  switch (act) {
    case 'view': ir(v); break;
    case 'status': S.status = v; renderFilters(); renderList(); break;
    case 'mk': S.mk = v; renderFilters(); renderList(); break;
    case 'atend': S.atend = v; renderFilters(); renderList(); break;
    case 'sel': escolher(id); break;
    case 'voltar': S.tela = 'lista'; $('cols').setAttribute('data-tela', 'lista'); break;
    case 'assumir': { const c = atual(); if (c) { if (c.ia) toast('Sandy pausada nesta conversa. Agora é com você.'); await rpc('assumir_conversa', c.id); } break; }
    case 'liberar': { const c = atual(); if (c) await rpc('liberar_conversa', c.id); break; }
    case 'toggle-painel': S.painel = !S.painel; renderThread(); break;
    case 'copiar': {
      const c = atual();
      try { await navigator.clipboard.writeText(c.pedido.replace('#', '')); toast('Número do pedido copiado.'); }
      catch (_) { toast('Não foi possível copiar. Selecione o número e copie manualmente.'); }
      break;
    }
    case 'rm-etq': {
      const c = atual(), e = S.etiquetas.find((x) => x.nome === el.getAttribute('data-n'));
      if (c && e) { await sb.from('conversa_etiquetas').delete().eq('conversa_id', c.id).eq('etiqueta_id', e.id); await carregarConversas(); renderList(); renderThread(); }
      break;
    }
    case 'zoom': {
      const u = await urlAnexo(el.getAttribute('data-path'));
      if (u) { $('lbImg').src = u; $('lb').hidden = false; }
      break;
    }
    case 'fechar-foto': $('lb').hidden = true; break;
    case 'rm-anexo': { const a = S.anexos.splice(Number(el.getAttribute('data-i')), 1)[0]; if (a?.prev) URL.revokeObjectURL(a.prev); renderThread(); break; }
    case 'rapida': {
      const r = S.rapidas.find((x) => x.id === id), c = atual();
      if (r && c) { S.draft = preencher(r.texto, c); S.aviso = ''; renderThread(); $('draft')?.focus(); }
      break;
    }
    case 'enviar': enviar(); break;
    case 'sandy-clica': {
      const f = FALAS[humorAtual(metricas())];
      S.fala = f[Math.floor(Math.random() * f.length)]; S.pula = true; renderSandy(); break;
    }
    case 'esqueci': telaLogin('', 'recuperar'); break;
    case 'voltar-login': telaLogin(); break;
    case 'sair': await sb.auth.signOut(); location.reload(); break;
    case 'nova-rap': S.novaRap = true; S.editRap = null; S.msg = ''; renderView(); break;
    case 'editar-rap': S.editRap = id; S.novaRap = false; S.msg = ''; renderView(); break;
    case 'cancelar-rap': S.editRap = null; S.novaRap = false; renderView(); break;
    case 'ins-var': {
      const ta = $('f-texto');
      if (ta) { const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a; ta.value = ta.value.slice(0, a) + v + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + v.length; }
      break;
    }
    case 'salvar-rap': {
      const t = val('f-titulo'), x = val('f-texto'), e = val('f-escopo');
      if (!t || !x) { S.msg = 'Preencha o título e o texto para salvar.'; renderView(); break; }
      const ok = id ? await guardar(sb.from('respostas_rapidas').update({ titulo: t, texto: x, escopo: e, atualizado_em: new Date().toISOString() }).eq('id', id), 'Resposta salva.')
        : await guardar(sb.from('respostas_rapidas').insert({ titulo: t, texto: x, escopo: e, criado_por: S.user.id }), 'Resposta salva.');
      if (ok) { S.editRap = null; S.novaRap = false; await carregarBase(); }
      renderView(); break;
    }
    case 'pedir-apagar': S.delRap = id; renderView(); break;
    case 'cancelar-apagar': S.delRap = null; S.delMembro = null; renderView(); break;
    case 'apagar-rap':
      if (await guardar(sb.from('respostas_rapidas').delete().eq('id', id), 'Resposta apagada.')) { S.delRap = null; await carregarBase(); }
      renderView(); break;
    case 'sandy-nova': S.novaBase = true; S.editBase = null; S.msg = ''; renderView(); break;
    case 'sandy-editar': S.editBase = id; S.novaBase = false; S.msg = ''; renderView(); break;
    case 'sandy-cancelar': S.novaBase = false; S.editBase = null; S.delBase = null; renderView(); break;
    case 'sandy-pedir-apagar': S.delBase = id; renderView(); break;
    case 'sandy-apagar':
      if (await guardar(sb.from('sandy_conhecimento').delete().eq('id', id), 'Informação apagada.')) { S.delBase = null; await carregarSandy(); }
      renderView(); break;
    case 'sandy-salvar-base': {
      const t = val('sb-titulo').trim(), x = val('sb-texto').trim(), e = val('sb-escopo');
      if (!t || !x) { S.msg = 'Preencha o assunto e o texto.'; renderView(); break; }
      const ok = id ? await guardar(sb.from('sandy_conhecimento').update({ titulo: t, texto: x, escopo: e, atualizado_em: new Date().toISOString() }).eq('id', id), 'Informação salva.')
        : await guardar(sb.from('sandy_conhecimento').insert({ titulo: t, texto: x, escopo: e, criado_por: S.user.id }), 'Informação salva.');
      if (ok) { S.novaBase = false; S.editBase = null; await carregarSandy(); }
      renderView(); break;
    }
    case 'sandy-salvar-geral': {
      const ligar = $('sy-ativa').checked, marcadas = Array.from(document.querySelectorAll('.sy-loja')).filter((i) => i.checked);
      if (ligar && !marcadas.length) { S.msg = 'Marque pelo menos uma loja para a Sandy atender.'; renderView(); break; }
      if (ligar && !S.sandy.base.length) { S.msg = 'Cadastre ao menos uma informação em "O que a Sandy sabe" antes de ligar.'; renderView(); break; }
      let ok = await guardar(sb.from('configuracoes').upsert([{ chave: 'sandy_ativa', valor: String(ligar) }, { chave: 'sandy_escalar_palavras', valor: val('sy-palavras').trim() }], { onConflict: 'chave' }));
      for (const i of document.querySelectorAll('.sy-loja')) {
        if (!ok) break;
        const r = await sb.from('lojas').update({ sandy_ativa: i.checked }).eq('id', i.getAttribute('data-id')).select('id');
        // Sem permissão, o banco não dá erro: só não altera nada. Por isso conferimos se alguma linha mudou.
        ok = !r.error && (r.data || []).length === 1;
        if (!ok) S.msg = 'Não foi possível salvar as lojas. Confira se você é administrador e tente de novo.';
      }
      if (ok) { S.msg = ligar ? 'Sandy ligada nas lojas marcadas.' : 'Configuração salva. A Sandy está desligada.'; await carregarBase(); await carregarSandy(); }
      renderView(); break;
    }
    case 'salvar-alerta': {
      const av = Number(val('cf-aviso')), ur = Number(val('cf-urgente'));
      if (ur <= av) { S.msg = 'O prazo de urgente precisa ser maior que o prazo de aviso.'; renderView(); break; }
      const linhas = [
        { chave: 'alerta_ativo', valor: String($('cf-ativo').checked) }, { chave: 'alerta_aviso_min', valor: String(av) },
        { chave: 'alerta_urgente_min', valor: String(ur) }, { chave: 'alerta_som', valor: String($('cf-som').checked) },
      ];
      if (await guardar(sb.from('configuracoes').upsert(linhas, { onConflict: 'chave' }), 'Avisos salvos.')) await carregarBase();
      renderView(); renderLeve(); break;
    }
    case 'testar-alerta': toast(`Teste: uma conversa ficou parada por ${curto(S.cfg.aviso)}.`); if (S.cfg.som) beep(); break;
    case 'ativar-notif': try { await Notification.requestPermission(); } catch (_) { /* ignora */ } renderView(); break;
    case 'add-etq-cfg': {
      const n = val('n-etq');
      if (!n) { S.msg = 'Digite o nome da etiqueta.'; renderView(); break; }
      if (S.etiquetas.some((e) => e.nome.toLowerCase() === n.toLowerCase())) { S.msg = 'Essa etiqueta já existe.'; renderView(); break; }
      if (await guardar(sb.from('etiquetas').insert({ nome: n, ordem: S.etiquetas.length + 1 }), 'Etiqueta adicionada.')) await carregarBase();
      renderView(); break;
    }
    case 'rm-etq-cfg':
      if (await guardar(sb.from('etiquetas').delete().eq('id', id), 'Etiqueta apagada das conversas também.')) { await carregarBase(); await carregarConversas(); }
      renderView(); break;
    case 'convidar': {
      const n = val('c-nome'), m = val('c-email');
      if (!n || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m)) { S.msg = 'Informe o nome e um e-mail válido para convidar.'; renderView(); break; }
      const { data, error } = await sb.functions.invoke('convidar-atendente', { body: { nome: n, email: m, papel: 'atendente', redirect_to: location.origin } });
      if (error || !data?.ok) S.msg = await mensagemDeErro(error, data?.erro || 'Não consegui enviar o convite.');
      else { S.msg = `Convite enviado para ${m}. A pessoa recebe um link para criar a senha.`; await carregarBase(); }
      renderView(); break;
    }
    case 'pedir-rm': S.delMembro = id; renderView(); break;
    case 'rm-membro':
      if (await guardar(sb.from('equipe').delete().eq('usuario_id', id), 'Pessoa removida da equipe. Ela perde o acesso na hora.')) { S.delMembro = null; await carregarBase(); await carregarConversas(); }
      renderView(); break;
    case 'salvar-dias':
      if (await guardar(sb.from('configuracoes').upsert({ chave: 'dias_retencao', valor: val('c-dias') || '7' }, { onConflict: 'chave' }), `Prazo salvo: respondidas ficam ${val('c-dias') || 7} dias.`)) await carregarBase();
      renderView(); break;
  }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'busca') { S.busca = ev.target.value; renderList(); }
  else if (ev.target.id === 'draft') { S.draft = ev.target.value; ajustaDraft(ev.target); }
});
document.addEventListener('change', async (ev) => {
  const t = ev.target, act = t.getAttribute?.('data-act');
  if (t.id === 'loja') { S.loja = t.value; renderList(); }
  else if (t.id === 'etqSel') { S.etq = t.value; renderList(); }
  else if (act === 'add-etq') {
    const c = atual();
    if (c && t.value) { await sb.from('conversa_etiquetas').insert({ conversa_id: c.id, etiqueta_id: t.value }); await carregarConversas(); renderList(); renderThread(); }
  } else if (act === 'papel') {
    if (await guardar(sb.from('equipe').update({ papel: t.value }).eq('usuario_id', t.getAttribute('data-id')), 'Função atualizada.')) await carregarBase();
    renderView();
  } else if (t.id === 'arq') {
    let recusados = 0;
    for (const f of Array.from(t.files || [])) {
      if (S.anexos.length >= 4 || f.size > 10 * 1024 * 1024) { recusados++; continue; }
      const img = f.type.startsWith('image/');
      S.anexos.push({ file: f, nome: f.name, tipo: img ? 'img' : 'arq', prev: img ? URL.createObjectURL(f) : null });
    }
    S.aviso = recusados ? `Até 4 anexos de no máximo 10 MB cada. ${recusados} arquivo(s) não foram adicionados.` : '';
    renderThread();
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'draft' && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); enviar(); }
  if (ev.key === 'Escape' && !$('lb').hidden) $('lb').hidden = true;
});
$('lb').addEventListener('click', (ev) => { if (ev.target === $('lb')) $('lb').hidden = true; });

/* ------------------------------------------------------------------ */
/* Início                                                               */
/* ------------------------------------------------------------------ */
const veioConvite = /type=(invite|recovery)/.test(location.hash);
let iniciando = false;
async function iniciar() {
  if (iniciando) return; iniciando = true;
  try {
    const { data } = await sb.auth.getSession();
    const user = data?.session?.user;
    if (!user) { location.replace('../?next=/chat/'); return; }
    S.user = user;
    const { data: eq } = await sb.from('equipe').select('usuario_id, nome, papel, foto_path').eq('usuario_id', user.id).maybeSingle();
    if (!eq) { iniciando = false; return telaSemAcesso(); }
    S.eu = eq;
    if (eq.papel !== 'admin') {
      const { data: ac } = await sb.from('acessos_apps').select('app').eq('usuario_id', user.id).eq('app', 'chat').maybeSingle();
      if (!ac) { iniciando = false; return telaSemAcesso(); }
    }
    montarCasca();
    await carregarBase(); await carregarConversas(); await carregarHoje();
    S.sel = null;
    renderView(); renderInbox();
    ligarTempoReal();
    iniciando = false;
  } catch (e) {
    console.error(e); iniciando = false;
    $('raiz').innerHTML = '<p class="carregando">Não foi possível carregar. Atualize a página.</p>';
  }
}
setInterval(() => {
  if (!S.user || !$('sandy')) return;
  for (const c of S.convs) {
    if (parada(c) && !S.alertados.has(c.id)) {
      S.alertados.add(c.id);
      if (S.cfg.ativo) { toast(`${c.nome} está sem resposta há mais de ${curto(S.cfg.aviso)}.`); if (S.cfg.som) beep(); }
    }
  }
  S.convs = S.convs.map((c) => ({ ...c, espera: c.aguardando && c.ultimaEm ? Math.max(0, Math.floor((Date.now() - new Date(c.ultimaEm).getTime()) / 60000)) : 0 }));
  if (S.view === 'inbox') renderLeve();
}, 60000);

(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session && veioConvite) telaNovaSenha();
  else iniciar();
})();
