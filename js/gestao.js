// Central: placar da semana, prioridades do trimestre e revisão semanal.
import { SUPABASE_URL } from './config.js';
import { esc, svg, IC, hojeISO, dataDe, soma, fCurto, nBR, valor } from './meudia.js';

const IG = {
  esq: '<path d="M15 6l-6 6 6 6"/>', dir: '<path d="M9 6l6 6-6 6"/>',
  placar: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  bandeira: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  revisao: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/>',
  auto: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
};
export const ICONES_CENTRAL = { dia: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', placar: IG.placar, prioridades: IG.bandeira, revisao: IG.revisao, ideias: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>' };
const FONTES = { lucro: 'Lucro (Lucro ao vivo)', faturamento: 'Faturamento (Lucro ao vivo)', pedidos: 'Pedidos (Lucro ao vivo)', pares: 'Pares vendidos (Lucro ao vivo)', devolucoes: 'Devoluções novas' };
const segunda = (iso) => soma(iso, -((dataDe(iso).getUTCDay() + 6) % 7));
const triDe = (iso) => { const m = +iso.slice(5, 7); return `${iso.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`; };
const somaTri = (iso, n) => { const d = dataDe(iso); d.setUTCMonth(d.getUTCMonth() + 3 * n); return d.toISOString().slice(0, 10); };
const nomeTri = (iso) => `${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1}º trimestre de ${iso.slice(0, 4)}`;
const semanaTxt = (s) => `${fCurto.format(dataDe(s))} a ${fCurto.format(dataDe(soma(s, 6)))}`;
const num = (s) => { const v = String(s).trim().replace(/\./g, '').replace(',', '.'); return v === '' ? NaN : Number(v); };
const prim = (n) => String(n || '').split(' ')[0];

export function base({ sb, user, eu }) {
  const admin = eu.papel === 'admin';
  const fotoUrl = (p) => (p ? `${SUPABASE_URL}/storage/v1/object/public/avatares/${p}` : '');
  const av = (p, cls = '') => { const u = fotoUrl(p?.foto_path); return u ? `<img class="av ${cls}" src="${esc(u)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(String(p?.nome || '?').charAt(0).toUpperCase())}</span>`; };
  const equipe = async () => (await sb.from('equipe').select('usuario_id, nome, papel, foto_path').order('nome')).data || [];
  function janela(html, aoFechar) {
    document.getElementById('md-dlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'md-dlg'; d.className = 'md-dlg'; d.innerHTML = html; document.body.appendChild(d);
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-fecha]')) d.close(); });
    d.addEventListener('close', () => { d.remove(); aoFechar && aoFechar(); });
    d.showModal(); return d;
  }
  const opcoes = (eq, sel, vazio) => (vazio ? `<option value="">${vazio}</option>` : '') + eq.map((p) => `<option value="${p.usuario_id}"${p.usuario_id === sel ? ' selected' : ''}>${esc(prim(p.nome))}</option>`).join('');
  return { admin, av, equipe, janela, opcoes, user, sb };
}
const cab = (titulo, sub, nav = '') => `<div class="pg-cab gs-cab"><div><h1>${titulo}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${nav}</div>`;
const navPeriodo = (rot, podeAvancar) => `<div class="gs-nav" role="group" aria-label="Período"><button class="ibtn p" type="button" data-nav="-1" aria-label="Anterior">${svg(IG.esq)}</button><span>${rot}</span><button class="ibtn p" type="button" data-nav="1" aria-label="Próximo"${podeAvancar ? '' : ' disabled'}>${svg(IG.dir)}</button></div>`;

// carrega números + 13 semanas de valores (digitados e automáticos)
async function dadosPlacar(sb, ate) {
  const desde = soma(ate, -7 * 12);
  const [nu, va, au] = await Promise.all([
    sb.from('central_numeros').select('*').eq('ativo', true).order('ordem').order('criado_em'),
    sb.from('central_numeros_semanas').select('numero_id, semana, valor').gte('semana', desde).lte('semana', ate),
    sb.rpc('central_placar_auto', { p_desde: desde }),
  ]);
  const manual = new Map((va.data || []).map((x) => [`${x.numero_id}|${x.semana}`, +x.valor]));
  const auto = new Map((au.data || []).map((x) => [`${x.fonte}|${x.semana}`, +x.valor]));
  const fontesVistas = new Set((au.data || []).map((x) => x.fonte));
  const semanas = Array.from({ length: 13 }, (_, i) => soma(desde, 7 * i));
  const val = (n, s) => (n.fonte ? (auto.has(`${n.fonte}|${s}`) ? auto.get(`${n.fonte}|${s}`) : (fontesVistas.has(n.fonte) ? 0 : null)) : (manual.has(`${n.id}|${s}`) ? manual.get(`${n.id}|${s}`) : null));
  const bateu = (n, v) => v != null && (n.sentido === 'menor' ? v <= +n.meta : v >= +n.meta);
  return { numeros: nu.data || [], semanas, val, bateu, manual, erro: !!(nu.error || va.error) };
}
function barrinhas(n, D, sel, atual) {
  const vs = D.semanas.map((s) => D.val(n, s)), max = Math.max(+n.meta, ...vs.map((v) => v || 0), 1e-9);
  return `<div class="gs-hist" aria-hidden="true">${D.semanas.map((s, i) => { const v = vs[i]; const cl = v == null ? 'b-vz' : s === atual ? 'b-and' : D.bateu(n, v) ? 'b-ok' : 'b-nao'; return `<i class="${cl}${s === sel ? ' sel' : ''}" style="height:${v == null ? 12 : Math.max(8, Math.round((v / max) * 100))}%" title="${semanaTxt(s)}${v == null ? '' : ': ' + valor(v, n.unidade)}"></i>`; }).join('')}<u style="bottom:${Math.min(100, Math.round((+n.meta / max) * 100))}%"></u></div>`;
}

// ---------------- Placar da semana
export async function montarPlacar(ctx) {
  const { el } = ctx, B = base(ctx), atual = segunda(hojeISO());
  let sem = atual, D, eq = [], primeira = true;
  async function carregar() { [D, eq] = await Promise.all([dadosPlacar(B.sb, sem), B.equipe()]); }
  function desenhar() {
    const andando = sem === atual, e = primeira ? ' entra' : '';
    const linhas = D.numeros.map((n) => {
      const v = D.val(n, sem), ok = D.bateu(n, v), dono = eq.find((p) => p.usuario_id === n.dono_id), pode = !n.fonte && (B.admin || n.dono_id === B.user.id);
      const st = v == null ? `<span class="tag ex">${svg(IC.relogio)}${n.fonte ? 'Sem acesso' : 'Sem valor'}</span>` : ok ? `<span class="tag rec">${svg(IC.check)}No verde</span>` : andando ? `<span class="tag ex">${svg(IC.relogio)}Em andamento</span>` : `<span class="tag ate">${svg(IC.alerta)}Abaixo</span>`;
      const campo = pode ? `<input class="md-in gs-val" data-num="${n.id}" inputmode="decimal" value="${v == null ? '' : String(v).replace('.', ',')}" placeholder="—" aria-label="Valor de ${esc(n.titulo)}">` : `<b class="gs-v">${v == null ? '—' : valor(v, n.unidade)}</b>`;
      return `<li class="gs-num"><div class="gs-tit"><b>${esc(n.titulo)}</b><span class="sub">${n.sentido === 'menor' ? 'até' : 'meta'} ${valor(n.meta, n.unidade)}${n.fonte ? ' · automático' : ''}</span></div>` +
        `${dono ? `<span class="md-quem" title="${esc(dono.nome)}">${B.av(dono, 'p')}</span>` : '<span></span>'}${barrinhas(n, D, sem, atual)}<div class="gs-campo">${campo}</div>${st}` +
        `${B.admin ? `<button class="ibtn p" type="button" data-edita="${n.id}" aria-label="Editar número">${svg(IC.lapis)}</button>` : '<span></span>'}</li>`;
    }).join('');
    const com = D.numeros.filter((n) => D.val(n, sem) != null), verdes = com.filter((n) => D.bateu(n, D.val(n, sem))).length;
    el.innerHTML = cab('Placar da semana', '', navPeriodo(`Semana de ${semanaTxt(sem)}`, sem < atual)) +
      (D.erro ? `<p class="erro" role="alert">${svg(IC.alerta)}<span>Não consegui carregar o placar. Atualize a página.</span></p>` : '') +
      `<section class="card md-palco${e}" aria-label="Resumo"><div class="md-palco-txt"><span class="md-rot">${andando ? 'Semana em andamento' : 'Semana fechada'}</span><div class="md-grande"><b>${verdes}</b><span>de ${D.numeros.length} no verde</span></div></div>` +
      `<div class="gs-pontos" aria-hidden="true">${D.numeros.map((n) => { const v = D.val(n, sem); return `<i class="${v == null ? 'b-vz' : D.bateu(n, v) ? 'b-ok' : andando ? 'b-and' : 'b-nao'}"></i>`; }).join('')}</div></section>` +
      `<section class="card${e}" style="--o:1" aria-label="Números"><div class="qcab"><span class="ico">${svg(IG.placar)}</span><h2>Números</h2>${B.admin ? `<button class="btn sec" type="button" data-edita="novo">${svg(IC.mais)}Número</button>` : ''}</div>` +
      (linhas ? `<ul class="gs-lista">${linhas}</ul>` : `<div class="md-vazio listrado"><p>Nenhum número no placar ainda.</p></div>`) + '</section>';
    primeira = false;
  }
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.nav) { sem = soma(sem, 7 * +b.dataset.nav); if (sem > atual) sem = atual; await carregar(); desenhar(); }
    else if (b.dataset.edita) janelaNumero(b.dataset.edita);
  });
  el.addEventListener('change', async (ev) => {
    const i = ev.target.closest('.gs-val'); if (!i) return;
    const v = num(i.value);
    if (i.value.trim() === '') return; if (!Number.isFinite(v)) { i.classList.add('ruim'); return; }
    const { error } = await B.sb.from('central_numeros_semanas').upsert({ numero_id: i.dataset.num, semana: sem, valor: v, atualizado_por: B.user.id, atualizado_em: new Date().toISOString() });
    if (error) { i.classList.add('ruim'); return; }
    D.manual.set(`${i.dataset.num}|${sem}`, v); desenhar();
  });
  function janelaNumero(id) {
    const n = id === 'novo' ? null : D.numeros.find((x) => x.id === id);
    const d = B.janela(`<form id="gs-f"><div class="qcab"><span class="ico">${svg(IG.placar)}</span><h2>${n ? 'Editar número' : 'Novo número'}</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<label class="campo"><span class="rot">Número</span><input id="gn-t" maxlength="80" required value="${esc(n?.titulo || '')}" placeholder="Ex.: Anúncios revisados"></label>` +
      `<label class="campo"><span class="rot">De onde vem</span><select id="gn-f" class="md-in"><option value="">Digitado à mão toda semana</option>${Object.entries(FONTES).map(([k, r]) => `<option value="${k}"${n?.fonte === k ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Medida</span><select id="gn-u" class="md-in">${[['un', 'Quantidade'], ['reais', 'Reais (R$)'], ['pct', 'Porcentagem (%)']].map(([v, r]) => `<option value="${v}"${n?.unidade === v ? ' selected' : ''}>${r}</option>`).join('')}</select></label>` +
      `<label class="campo"><span class="rot">Dono</span><select id="gn-d" class="md-in">${B.opcoes(eq, n?.dono_id, 'Sem dono')}</select></label></div>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Meta da semana</span><input id="gn-m" inputmode="decimal" required value="${n ? String(n.meta).replace('.', ',') : ''}"></label>` +
      `<label class="campo"><span class="rot">Bom é</span><select id="gn-s" class="md-in"><option value="maior"${n?.sentido !== 'menor' ? ' selected' : ''}>Bater ou passar a meta</option><option value="menor"${n?.sentido === 'menor' ? ' selected' : ''}>Ficar até a meta</option></select></label></div>` +
      `<p class="erro" id="gn-erro" role="alert" hidden></p><div class="md-acoes">${n ? '<button class="btn sec" type="button" id="gn-tira">Tirar do placar</button>' : ''}<span class="md-sp"></span><button class="btn sec" type="button" data-fecha>Cancelar</button><button class="btn pri" type="submit">Salvar</button></div></form>`, async () => { await carregar(); desenhar(); });
    const erro = d.querySelector('#gn-erro'), falha = (t) => { erro.hidden = false; erro.textContent = t; };
    const fonteSel = d.querySelector('#gn-f'), uni = d.querySelector('#gn-u');
    const trava = () => { const f = fonteSel.value; if (f) uni.value = f === 'lucro' || f === 'faturamento' ? 'reais' : 'un'; uni.disabled = !!f; };
    fonteSel.addEventListener('change', trava); trava();
    d.querySelector('#gs-f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reg = { titulo: d.querySelector('#gn-t').value.trim(), fonte: fonteSel.value || null, unidade: uni.value, dono_id: d.querySelector('#gn-d').value || null, meta: num(d.querySelector('#gn-m').value), sentido: d.querySelector('#gn-s').value };
      if (!reg.titulo) return falha('Dê um nome para o número.');
      if (!Number.isFinite(reg.meta)) return falha('A meta da semana precisa ser um número.');
      const { error } = n ? await B.sb.from('central_numeros').update(reg).eq('id', n.id) : await B.sb.from('central_numeros').insert({ ...reg, ordem: D.numeros.length });
      if (error) return falha('Não consegui salvar. Tente de novo.');
      d.close();
    });
    d.querySelector('#gn-tira')?.addEventListener('click', async () => {
      const { error } = await B.sb.from('central_numeros').update({ ativo: false }).eq('id', n.id);
      if (error) return falha('Não consegui tirar do placar.');
      d.close();
    });
  }
  await carregar(); desenhar();
}

// ---------------- Prioridades do trimestre
const STATUS = { no_trilho: ['No trilho', 'rec', IC.check], fora: ['Fora do trilho', 'ate', IC.alerta], feita: ['Feita', '', IC.check] };
async function dadosPrioridades(sb, tri) {
  const pr = await sb.from('central_prioridades').select('*').eq('trimestre', tri).order('criado_em');
  const ids = (pr.data || []).map((p) => p.id);
  const ta = ids.length ? await sb.from('central_tarefas').select('*').in('prioridade_id', ids).order('criado_em') : { data: [] };
  return { prioridades: pr.data || [], tarefas: ta.data || [], erro: !!(pr.error || ta.error) };
}
function cartaoPrioridade(p, D, B, eq, aberto, editar = true) {
  const ts = D.tarefas.filter((t) => t.prioridade_id === p.id), feitas = ts.filter((t) => t.feita_em).length, dono = eq.find((x) => x.usuario_id === p.dono_id);
  const pode = B.admin || p.dono_id === B.user.id, pct = ts.length ? Math.round((feitas / ts.length) * 100) : 0;
  const seg = Object.entries(STATUS).map(([k, [r]]) => `<button type="button" data-st="${p.id}|${k}" class="${p.status === k ? 'on ' + k : ''}" aria-pressed="${p.status === k}"${pode ? '' : ' disabled'}>${r}</button>`).join('');
  return `<li class="gs-prio${p.status === 'feita' ? ' feita' : ''}"><div class="gs-prio-cab"><button type="button" class="gs-abre" data-abre="${p.id}" aria-expanded="${aberto}"><b>${esc(p.titulo)}</b><span class="sub">${dono ? esc(prim(dono.nome)) : 'Sem dono'}${p.prazo ? ' · até ' + fCurto.format(dataDe(p.prazo)) : ''} · ${ts.length ? `${feitas} de ${ts.length} tarefas` : 'sem tarefas'}</span></button>` +
    `${dono ? `<span class="md-quem" title="${esc(dono.nome)}">${B.av(dono)}</span>` : ''}<div class="gs-st" role="group" aria-label="Situação">${seg}</div>${B.admin && editar ? `<button class="ibtn p" type="button" data-edita="${p.id}" aria-label="Editar prioridade">${svg(IC.lapis)}</button>` : ''}</div>` +
    `<div class="md-barra${ts.length ? '' : ' listrado'}" aria-hidden="true"><span style="width:${pct}%"></span></div>` +
    (aberto ? `<div class="gs-prio-corpo">${ts.length ? `<ul class="md-lista">${ts.map((t) => { const on = !!t.feita_em, r = eq.find((x) => x.usuario_id === t.responsavel_id); return `<li><button type="button" class="md-chk${on ? ' on' : ''}" data-tar="${t.id}" aria-pressed="${on}"><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(t.titulo)}</span></button>${t.prazo ? `<span class="tag">${svg(IC.relogio)}${fCurto.format(dataDe(t.prazo))}</span>` : ''}${r ? `<span class="md-quem" title="${esc(r.nome)}">${B.av(r, 'p')}</span>` : ''}</li>`; }).join('')}</ul>` : ''}` +
      `<form class="md-nova gs-nt" data-nt="${p.id}"><input class="md-in" name="t" placeholder="Nova tarefa desta prioridade" maxlength="160" aria-label="Nova tarefa" autocomplete="off"><select class="md-in" name="r" aria-label="Responsável">${B.opcoes(eq, p.dono_id)}</select><input class="md-in" name="p" type="date" aria-label="Prazo"><button class="btn pri" type="submit" aria-label="Adicionar tarefa">${svg(IC.mais)}</button></form></div>` : '') + '</li>';
}
export async function montarPrioridades(ctx) {
  const { el } = ctx, B = base(ctx), atual = triDe(hojeISO());
  let tri = atual, D, eq = [], abertos = new Set(), primeira = true;
  async function carregar() { [D, eq] = await Promise.all([dadosPrioridades(B.sb, tri), B.equipe()]); }
  function desenhar() {
    const e = primeira ? ' entra' : '', n = D.prioridades.length, tr = D.prioridades.filter((p) => p.status === 'no_trilho').length, fe = D.prioridades.filter((p) => p.status === 'feita').length, fo = n - tr - fe;
    el.innerHTML = cab('Prioridades do trimestre', '', navPeriodo(nomeTri(tri), true)) +
      (D.erro ? `<p class="erro" role="alert">${svg(IC.alerta)}<span>Não consegui carregar as prioridades. Atualize a página.</span></p>` : '') +
      `<section class="card md-palco${e}" aria-label="Resumo"><div class="md-palco-txt"><span class="md-rot">${nomeTri(tri)}</span><div class="md-grande"><b>${fe}</b><span>de ${n} feitas</span></div>` +
      `<div class="md-tags">${tr ? `<span class="tag rec">${svg(IC.check)}${tr} no trilho</span>` : ''}${fo ? `<span class="tag ate">${svg(IC.alerta)}${fo} fora do trilho</span>` : ''}</div></div></section>` +
      `<section class="card${e}" style="--o:1" aria-label="Prioridades"><div class="qcab"><span class="ico">${svg(IG.bandeira)}</span><h2>Prioridades</h2>${B.admin ? `<button class="btn sec" type="button" data-edita="nova">${svg(IC.mais)}Prioridade</button>` : ''}</div>` +
      (n > 7 ? `<p class="erro">${svg(IC.alerta)}<span>Mais de 7 prioridades no trimestre: o foco se perde. Escolha as que importam mesmo.</span></p>` : '') +
      (n ? `<ul class="gs-prios">${D.prioridades.map((p) => cartaoPrioridade(p, D, B, eq, abertos.has(p.id))).join('')}</ul>` : `<div class="md-vazio listrado"><p>Nenhuma prioridade neste trimestre.</p></div>`) + '</section>';
    primeira = false;
  }
  acoesPrioridades(el, B, () => D, desenhar, abertos, () => eq, async (id) => janelaPrioridade(id));
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-nav]'); if (!b) return;
    tri = somaTri(tri, +b.dataset.nav); await carregar(); desenhar();
  });
  function janelaPrioridade(id) {
    const p = id === 'nova' ? null : D.prioridades.find((x) => x.id === id);
    const d = B.janela(`<form id="gp-f"><div class="qcab"><span class="ico">${svg(IG.bandeira)}</span><h2>${p ? 'Editar prioridade' : 'Nova prioridade'}</h2><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<label class="campo"><span class="rot">Prioridade</span><input id="gp-t" maxlength="120" required value="${esc(p?.titulo || '')}" placeholder="Ex.: Abrir a loja no Mercado Livre"></label>` +
      `<div class="md-duo"><label class="campo"><span class="rot">Dono</span><select id="gp-d" class="md-in">${B.opcoes(eq, p?.dono_id || B.user.id)}</select></label><label class="campo"><span class="rot">Prazo</span><input id="gp-p" class="md-in" type="date" value="${p?.prazo || ''}"></label></div>` +
      `<p class="erro" id="gp-erro" role="alert" hidden></p><div class="md-acoes">${p ? '<button class="btn sec" type="button" id="gp-apaga">Apagar</button>' : ''}<span class="md-sp"></span><button class="btn sec" type="button" data-fecha>Cancelar</button><button class="btn pri" type="submit">Salvar</button></div></form>`, async () => { await carregar(); desenhar(); });
    const erro = d.querySelector('#gp-erro'), falha = (t) => { erro.hidden = false; erro.textContent = t; };
    d.querySelector('#gp-f').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const reg = { titulo: d.querySelector('#gp-t').value.trim(), dono_id: d.querySelector('#gp-d').value, prazo: d.querySelector('#gp-p').value || null, atualizado_em: new Date().toISOString() };
      if (!reg.titulo) return falha('Dê um nome para a prioridade.');
      const { error } = p ? await B.sb.from('central_prioridades').update(reg).eq('id', p.id) : await B.sb.from('central_prioridades').insert({ ...reg, trimestre: tri });
      if (error) return falha('Não consegui salvar. Tente de novo.');
      d.close();
    });
    d.querySelector('#gp-apaga')?.addEventListener('click', async () => {
      const { error } = await B.sb.from('central_prioridades').delete().eq('id', p.id);
      if (error) return falha('Não consegui apagar.');
      d.close();
    });
  }
  await carregar(); desenhar();
}
// cliques comuns às prioridades (usado também na revisão)
function acoesPrioridades(el, B, getD, desenhar, abertos, getEq, edita) {
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return; const D = getD();
    if (b.dataset.abre) { if (abertos.has(b.dataset.abre)) abertos.delete(b.dataset.abre); else abertos.add(b.dataset.abre); desenhar(); }
    else if (b.dataset.st) {
      const [id, st] = b.dataset.st.split('|'), p = D.prioridades.find((x) => x.id === id), antes = p.status; if (antes === st) return;
      p.status = st; desenhar();
      const { error } = await B.sb.from('central_prioridades').update({ status: st, atualizado_em: new Date().toISOString() }).eq('id', id);
      if (error) { p.status = antes; desenhar(); }
    } else if (b.dataset.tar && D.tarefas) {
      const t = D.tarefas.find((x) => x.id === b.dataset.tar); if (!t) return; const antes = t.feita_em;
      t.feita_em = antes ? null : new Date().toISOString(); desenhar();
      const { error } = await B.sb.from('central_tarefas').update({ feita_em: t.feita_em }).eq('id', t.id);
      if (error) { t.feita_em = antes; desenhar(); }
    } else if (b.dataset.edita && edita) edita(b.dataset.edita);
  });
  el.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-nt]'); if (!f) return; ev.preventDefault(); const D = getD();
    const titulo = f.t.value.trim(); if (!titulo) return;
    const { data, error } = await B.sb.from('central_tarefas').insert({ titulo, responsavel_id: f.r.value, prazo: f.p.value || null, prioridade_id: f.dataset.nt, criado_por: B.user.id }).select().single();
    if (!error && data) { D.tarefas.push(data); desenhar(); el.querySelector(`form[data-nt="${f.dataset.nt}"] input[name=t]`)?.focus(); }
  });
}

// ---------------- Revisão semanal (15 minutos, 5 passos)
export async function montarRevisao(ctx) {
  const { el } = ctx, B = base(ctx), hoje = hojeISO(), sem = segunda(hoje), passada = soma(sem, -7);
  let passo = 0, P, R, eq = [], atrasadas = [], comp = [], revs = [], tarSem = [], rotAtv = [], rotFeitos = [], primeira = true; const abertos = new Set();
  async function carregar() {
    const fim = soma(passada, 6);
    const [p, r, e, at, co, rv, ts, ro, rf] = await Promise.all([
      dadosPlacar(B.sb, passada), dadosPrioridades(B.sb, triDe(hoje)), B.equipe(),
      B.sb.from('central_tarefas').select('*').is('feita_em', null).lt('prazo', hoje).order('prazo'),
      B.sb.from('central_compromissos').select('*').gte('semana', passada).order('criado_em'),
      B.sb.from('central_revisoes').select('*').order('semana', { ascending: false }).limit(8),
      // tarefas da semana passada: as que venciam nela ou que foram concluídas nela
      B.sb.from('central_tarefas').select('*').or(`and(prazo.gte.${passada},prazo.lte.${fim}),and(feita_em.gte.${passada}T00:00:00-03:00,feita_em.lt.${sem}T00:00:00-03:00)`).order('prazo'),
      B.sb.from('central_rotinas').select('id, usuario_id, dias').eq('ativo', true),
      B.sb.from('central_rotina_feitos').select('rotina_id, dia, usuario_id').gte('dia', passada).lte('dia', fim),
    ]);
    P = p; R = r; eq = e; atrasadas = at.data || []; comp = co.data || []; revs = rv.data || [];
    tarSem = ts.data || []; rotAtv = ro.data || []; rotFeitos = rf.data || [];
  }
  const PASSOS = ['Placar', 'Tarefas', 'Prioridades', 'Atrasadas', 'Compromissos'], ULT = PASSOS.length - 1;
  function corpo() {
    if (passo === 0) {
      const l = P.numeros.map((n) => { const v = P.val(n, passada), ok = P.bateu(n, v), dono = eq.find((p) => p.usuario_id === n.dono_id);
        return `<li class="gs-num rv"><div class="gs-tit"><b>${esc(n.titulo)}</b><span class="sub">${n.sentido === 'menor' ? 'até' : 'meta'} ${valor(n.meta, n.unidade)}</span></div>${dono ? `<span class="md-quem" title="${esc(dono.nome)}">${B.av(dono, 'p')}</span>` : '<span></span>'}${barrinhas(n, P, passada, null)}<b class="gs-v">${v == null ? '—' : valor(v, n.unidade)}</b>${v == null ? `<span class="tag ex">${svg(IC.relogio)}Sem valor</span>` : ok ? `<span class="tag rec">${svg(IC.check)}No verde</span>` : `<span class="tag ate">${svg(IC.alerta)}Abaixo</span>`}</li>`; }).join('');
      return `<h2>Como foi a semana de ${semanaTxt(passada)}</h2>` + (l ? `<ul class="gs-lista">${l}</ul>` : '<div class="md-vazio listrado"><p>O placar ainda não tem números.</p></div>');
    }
    if (passo === 1) {
      const fim = soma(passada, 6), noDia = (t) => (t.feita_em ? t.feita_em : t.prazo + 'T12:00:00-03:00');
      const pessoas = eq.map((p) => {
        const ts = tarSem.filter((t) => t.responsavel_id === p.usuario_id), fe = ts.filter((t) => t.feita_em), ab = ts.filter((t) => !t.feita_em);
        // rotina prevista: dias úteis da semana em que cada item da pessoa estava marcado
        const prev = rotAtv.filter((r) => r.usuario_id === p.usuario_id).reduce((n, r) => n + [1, 2, 3, 4, 5].filter((d) => (r.dias || []).includes(d)).length, 0);
        const feitoR = rotFeitos.filter((x) => x.usuario_id === p.usuario_id).length;
        return { p, ts, fe, ab, prev, feitoR };
      }).filter((x) => x.ts.length || x.prev);
      const tot = pessoas.reduce((n, x) => n + x.ts.length, 0), cum = pessoas.reduce((n, x) => n + x.fe.length, 0), pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
      const barra = (a, b) => `<span class="rv-barra" role="img" aria-label="${a} de ${b}"><i style="width:${pct(a, b)}%"></i></span>`;
      const item = (t, ok) => `<li class="rv-t${ok ? ' feita' : ''}"><span class="cx">${ok ? svg(IC.check, 12) : ''}</span><span class="tx">${esc(t.titulo)}</span>${t.prazo ? `<span class="tag${ok ? '' : ' ate'}">${fCurto.format(dataDe(t.prazo))}</span>` : ''}</li>`;
      const blocos = pessoas.map(({ p, ts, fe, ab, prev, feitoR }) => `<li class="gs-comp rv-p"><div class="pessoa">${B.av(p)}<b>${esc(p.nome)}</b></div>` +
        `<div class="rv-res"><div><span class="sub">Tarefas</span><b>${ts.length ? `${fe.length} de ${ts.length}` : '—'}</b>${ts.length ? barra(fe.length, ts.length) : ''}</div>` +
        `<div><span class="sub">Rotina</span><b>${prev ? `${Math.min(feitoR, prev)} de ${prev}` : '—'}</b>${prev ? barra(Math.min(feitoR, prev), prev) : ''}</div></div>` +
        (ts.length ? `<ul class="rv-ts">${[...ts].sort((a, b) => (!!b.feita_em - !!a.feita_em) || noDia(a).localeCompare(noDia(b))).map((t) => item(t, !!t.feita_em)).join('')}</ul>` : '') + '</li>').join('');
      return `<h2>O que foi feito na semana de ${semanaTxt(passada)}</h2>` + (tot || pessoas.length
        ? `<div class="rv-geral"><b>${cum} de ${tot}</b><span>tarefas concluídas (${pct(cum, tot)}%)</span>${barra(cum, tot)}</div><ul class="gs-comps">${blocos}</ul>`
        : '<div class="md-vazio listrado"><p>Nenhuma tarefa na semana passada.</p></div>');
    }
    if (passo === 2) return `<h2>${nomeTri(triDe(hoje))}: no trilho ou fora?</h2>` + (R.prioridades.length ? `<ul class="gs-prios">${R.prioridades.map((p) => cartaoPrioridade(p, R, B, eq, abertos.has(p.id), false)).join('')}</ul>` : '<div class="md-vazio listrado"><p>Nenhuma prioridade neste trimestre.</p></div>');
    if (passo === 3) return '<h2>O que ficou para trás</h2>' + (atrasadas.length ? `<ul class="md-lista">${atrasadas.map((t) => { const r = eq.find((x) => x.usuario_id === t.responsavel_id); return `<li><button type="button" class="md-chk" data-atr="${t.id}" aria-pressed="false"><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(t.titulo)}</span></button><span class="tag ate">${svg(IC.alerta)}${fCurto.format(dataDe(t.prazo))}</span>${r ? `<span class="md-quem" title="${esc(r.nome)}">${B.av(r, 'p')}</span>` : ''}<button class="btn sec gs-adia" type="button" data-adia="${t.id}">Fica para sexta</button></li>`; }).join('')}</ul>` : `<div class="md-vazio"><p>Nenhuma tarefa atrasada.</p></div>`);
    const blocos = eq.map((p) => {
      const ant = comp.filter((c) => c.usuario_id === p.usuario_id && c.semana === passada), nov = comp.filter((c) => c.usuario_id === p.usuario_id && c.semana === sem), pode = B.admin || p.usuario_id === B.user.id;
      return `<li class="gs-comp"><div class="pessoa">${B.av(p)}<b>${esc(p.nome)}</b></div>` +
        (ant.length ? `<div class="gs-ant"><span class="sub">Prometeu na semana passada</span>${ant.map((c) => `<div class="gs-prom"><span>${esc(c.texto)}</span><div class="gs-st" role="group" aria-label="Cumpriu?"><button type="button" data-cum="${c.id}|1" class="${c.cumprido === true ? 'on no_trilho' : ''}"${pode ? '' : ' disabled'}>Cumpriu</button><button type="button" data-cum="${c.id}|0" class="${c.cumprido === false ? 'on fora' : ''}"${pode ? '' : ' disabled'}>Não deu</button></div></div>`).join('')}</div>` : '') +
        `<div class="gs-ant"><span class="sub">Esta semana</span>${nov.map((c) => `<div class="gs-prom"><span>${esc(c.texto)}</span>${pode ? `<button class="md-x" type="button" data-tirac="${c.id}" aria-label="Remover compromisso">${svg(IC.x, 14)}</button>` : ''}</div>`).join('')}` +
        (pode ? `<form class="md-nova" data-comp="${p.usuario_id}"><input class="md-in" name="t" placeholder="O que ${p.usuario_id === B.user.id ? 'vou' : 'vai'} entregar esta semana" maxlength="200" aria-label="Compromisso de ${esc(p.nome)}" autocomplete="off" style="flex:1 1 200px"><button class="btn pri" type="submit" aria-label="Adicionar compromisso">${svg(IC.mais)}</button></form>` : (nov.length ? '' : '<span class="sub">Sem compromisso ainda.</span>')) + '</div></li>';
    }).join('');
    return `<h2>Um ou dois compromissos por pessoa</h2><ul class="gs-comps">${blocos}</ul>`;
  }
  function desenhar() {
    const e = primeira ? ' entra' : '', feita = revs.find((r) => r.semana === sem), quem = feita && eq.find((p) => p.usuario_id === feita.feita_por);
    el.innerHTML = cab('Revisão semanal', `Semana de ${semanaTxt(sem)}`) +
      `<section class="card${e}" aria-label="Revisão"><ol class="gs-passos">${PASSOS.map((p, i) => `<li><button type="button" data-passo="${i}" class="${i === passo ? 'on' : i < passo ? 'ja' : ''}" aria-current="${i === passo ? 'step' : 'false'}"><i>${i < passo ? svg(IC.check, 14) : i + 1}</i><span>${p}</span></button></li>`).join('')}</ol>` +
      `<div class="gs-corpo">${corpo()}</div><div class="md-acoes"><button class="btn sec" type="button" data-passo="${passo - 1}"${passo ? '' : ' disabled'}>Voltar</button><span class="md-sp"></span>` +
      (passo < ULT ? `<button class="btn pri" type="button" data-passo="${passo + 1}">Continuar</button>` : feita ? `<span class="tag rec">${svg(IC.check)}Revisão feita${quem ? ' por ' + esc(prim(quem.nome)) : ''}</span>` : B.admin ? '<button class="btn pri" type="button" data-conclui>Concluir revisão</button>' : '<span class="tag ex">' + svg(IC.relogio) + 'Um administrador conclui</span>') + '</div></section>' +
      `<section class="card${e}" style="--o:1" aria-label="Histórico"><div class="qcab"><span class="ico">${svg(IG.revisao)}</span><h2>Revisões feitas</h2></div>` +
      (revs.length ? `<ul class="md-lista">${revs.map((r) => { const q = eq.find((p) => p.usuario_id === r.feita_por); return `<li class="gs-rev"><span>Semana de ${semanaTxt(r.semana)}</span><span class="md-sp"></span>${q ? `<span class="md-quem" title="${esc(q.nome)}">${B.av(q, 'p')}</span>` : ''}<span class="tag rec">${svg(IC.check)}Feita</span></li>`; }).join('')}</ul>` : '<div class="md-vazio listrado"><p>Nenhuma revisão registrada ainda.</p></div>') + '</section>';
    primeira = false;
  }
  acoesPrioridades(el, B, () => R, desenhar, abertos, () => eq, null);
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.passo != null && !b.disabled) { passo = Math.max(0, Math.min(ULT, +b.dataset.passo)); desenhar(); el.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }
    else if (b.dataset.atr) { const i = atrasadas.findIndex((t) => t.id === b.dataset.atr); b.classList.add('on', 'pop'); const { error } = await B.sb.from('central_tarefas').update({ feita_em: new Date().toISOString() }).eq('id', b.dataset.atr); if (!error) { atrasadas.splice(i, 1); setTimeout(desenhar, 500); } else desenhar(); }
    else if (b.dataset.adia) { const sexta = soma(sem, 4) >= hoje ? soma(sem, 4) : soma(sem, 11), i = atrasadas.findIndex((t) => t.id === b.dataset.adia); const { error } = await B.sb.from('central_tarefas').update({ prazo: sexta }).eq('id', b.dataset.adia); if (!error) { atrasadas.splice(i, 1); desenhar(); } }
    else if (b.dataset.cum) { const [id, v] = b.dataset.cum.split('|'), c = comp.find((x) => x.id === id), antes = c.cumprido; c.cumprido = v === '1'; desenhar(); const { error } = await B.sb.from('central_compromissos').update({ cumprido: c.cumprido }).eq('id', id); if (error) { c.cumprido = antes; desenhar(); } }
    else if (b.dataset.tirac) { const i = comp.findIndex((x) => x.id === b.dataset.tirac), [c] = comp.splice(i, 1); desenhar(); const { error } = await B.sb.from('central_compromissos').delete().eq('id', c.id); if (error) { comp.splice(i, 0, c); desenhar(); } }
    else if (b.dataset.conclui != null) { b.disabled = true; const { data, error } = await B.sb.from('central_revisoes').insert({ semana: sem, feita_por: B.user.id }).select().single(); if (!error && data) revs.unshift(data); desenhar(); }
  });
  el.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-comp]'); if (!f) return; ev.preventDefault();
    const texto = f.t.value.trim(); if (!texto) return;
    const { data, error } = await B.sb.from('central_compromissos').insert({ semana: sem, usuario_id: f.dataset.comp, texto }).select().single();
    if (!error && data) { comp.push(data); desenhar(); el.querySelector(`form[data-comp="${f.dataset.comp}"] input`)?.focus(); }
  });
  await carregar(); desenhar();
}
