// Card de detalhes da tarefa (título, responsável, data, importância, descrição, subtarefas).
// Usado no Meu dia, nas Prioridades e na Revisão semanal: o mesmo card em todo lugar.
import { esc, svg, IC, hojeISO, prim } from './util.js';
import { botaoAcao } from './molas.js';

// tag de importância e selo de subtarefas/descrição, iguais em todas as listas
export const tagImp = (v) => { const k = v === 'alta' ? ['alta', 'Alta'] : v === 'baixa' ? ['baixa', 'Baixa'] : ['normal', 'Normal']; return `<span class="tag imp ${k[0]}">${k[1]}</span>`; };
export const seloTarefa = (t, itens) => { const l = itens.filter((i) => i.tarefa_id === t.id), f = l.filter((i) => i.feito).length;
  return (l.length ? `<span class="tag ck${f === l.length ? ' ok' : ''}" title="Subtarefas">${svg(IC.check, 12)}${f}/${l.length}</span>` : '') + (t.descricao ? `<span class="tag ck" title="Tem descrição">${svg(IC.texto, 12)}</span>` : ''); };

export function abrirDetalheTarefa({ sb, user, admin, equipe, tarefa: t, itens, aoFechar = () => {}, aoFalhar = () => {}, aoApagar = null }) {
  const hoje = hojeISO(), id = t.id;
  const janela = (html) => {
    document.getElementById('md-dlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'md-dlg'; d.className = 'md-dlg'; d.innerHTML = html; document.body.appendChild(d);
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-fecha]')) d.close(); });
    document.documentElement.classList.add('sh-trava');
    d.addEventListener('close', () => { document.documentElement.classList.remove('sh-trava'); d.remove(); aoFechar(); });
    d.showModal(); return d;
  };
  const falhou = aoFalhar;
    const pode = t.responsavel_id === user.id || t.criado_por === user.id || admin, dis = pode ? '' : ' disabled';
    const lista = () => itens.filter((i) => i.tarefa_id === id), pct = () => { const l = lista(); return l.length ? Math.round((l.filter((i) => i.feito).length / l.length) * 100) : 0; };
    const itensHtml = () => lista().map((i) => `<li class="td-it${i.feito ? ' feito' : ''}"><button type="button" class="md-chk${i.feito ? ' on' : ''}" data-ti="${i.id}" aria-pressed="${i.feito}"${dis}><span class="cx">${svg(IC.check, 14)}</span><span class="tx">${esc(i.texto)}</span></button>${pode ? `<button class="md-x" type="button" data-tdel="${i.id}" aria-label="Remover subtarefa">${svg(IC.x, 14)}</button>` : ''}</li>`).join('');
    const d = janela(`<form class="td" id="td-f" novalidate><div class="qcab"><span class="ico">${svg(IC.tarefa)}</span><input class="td-tit" id="td-t" maxlength="200" value="${esc(t.titulo)}" aria-label="Título da tarefa"${dis}><button class="ibtn p" type="button" data-fecha aria-label="Fechar">${svg(IC.x)}</button></div>` +
      `<div class="td-lin"><label class="campo"><span class="rot">Responsável</span><select class="md-in" id="td-r"${dis}>${equipe.map((p) => `<option value="${p.usuario_id}"${p.usuario_id === t.responsavel_id ? ' selected' : ''}>${esc(p.usuario_id === user.id ? 'Para mim' : prim(p.nome))}</option>`).join('')}</select></label>` +
      `<label class="campo"><span class="rot">Data</span><input class="md-in" id="td-p" type="date" value="${esc(t.prazo || '')}"${dis}></label>` +
      `<div class="campo"><span class="rot">Importância</span><div class="md-imp" id="td-i">${['baixa', 'normal', 'alta'].map((v) => `<button type="button" data-timp="${v}" class="${(t.importancia || 'normal') === v ? 'on' : ''}"${dis}>${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div></div></div>` +
      `<h3 class="td-h">${svg(IC.texto, 16)}Descrição</h3><textarea class="md-in td-desc" id="td-d" rows="3" maxlength="4000" placeholder="Adicione uma descrição mais detalhada..."${dis}>${esc(t.descricao || '')}</textarea>` +
      `<div class="td-hl"><h3 class="td-h">${svg(IC.check, 16)}Subtarefas</h3><span class="td-pct" id="td-pct"></span></div><span class="rv-barra" id="td-bar"><i></i></span><ul class="td-its" id="td-its"></ul>` +
      (pode ? `<div class="td-add"><input class="md-in" id="td-n" maxlength="300" placeholder="Adicionar um item" autocomplete="off" aria-label="Nova subtarefa"><button class="btn sec" type="button" id="td-mais">Adicionar</button></div>` : '') +
      (pode ? `<div class="td-rod">${aoApagar && (t.criado_por === user.id || admin) ? `<button class="btn sec td-apaga" type="button" id="td-apaga">Apagar tarefa</button>` : ''}<span class="md-sp"></span><button class="btn pri" type="submit" id="td-salvar">Salvar</button></div>` : '') + '</form>');
    const ul = d.querySelector('#td-its'), bar = d.querySelector('#td-bar i'), pc = d.querySelector('#td-pct');
    const redesenha = () => { ul.innerHTML = itensHtml(); const l = lista(); pc.textContent = l.length ? `${l.filter((i) => i.feito).length}/${l.length} · ${pct()}%` : ''; bar.style.width = pct() + '%'; d.querySelector('#td-bar').style.display = l.length ? '' : 'none'; };
    redesenha();
    // campos alterados ainda não enviados; "Salvar" envia e mostra o movimento; fechar a janela também envia, sem enfeite
    const sujo = new Set();
    const envia = async () => {
      if (!sujo.size) return true;
      const campos = {}; sujo.forEach((k) => { campos[k] = t[k] ?? null; }); const ks = [...sujo]; sujo.clear();
      const { error } = await sb.from('central_tarefas').update(campos).eq('id', id);
      if (error) { ks.forEach((k) => sujo.add(k)); return false; }
      return true;
    };
    const marca = (k, v) => { t[k] = v; sujo.add(k); };
    d.querySelector('#td-t').addEventListener('input', (ev) => { const v = ev.target.value.trim(); if (v) marca('titulo', v); });
    d.querySelector('#td-t').addEventListener('change', (ev) => { if (!ev.target.value.trim()) ev.target.value = t.titulo; });
    d.querySelector('#td-r').addEventListener('change', (ev) => marca('responsavel_id', ev.target.value));
    const dp = d.querySelector('#td-p');
    dp.addEventListener('change', (ev) => marca('prazo', ev.target.value || null));
    dp.addEventListener('dblclick', () => { if (!dp.value && pode) { dp.value = hoje; marca('prazo', hoje); } });
    d.querySelector('#td-d').addEventListener('input', (ev) => marca('descricao', ev.target.value.trim() || null));
    const adiciona = async () => {
      const inp = d.querySelector('#td-n'), texto = inp.value.trim(); if (!texto) return true;
      const ordem = lista().reduce((m, i) => Math.max(m, i.ordem || 0), 0) + 1; inp.value = '';
      const { data, error } = await sb.from('central_tarefa_itens').insert({ tarefa_id: id, texto, ordem }).select().single();
      if (error || !data) { inp.value = texto; falhou('Não consegui adicionar a subtarefa.'); return false; }
      itens.push(data); redesenha(); return true;
    };
    d.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.timp) { marca('importancia', b.dataset.timp); d.querySelectorAll('[data-timp]').forEach((x) => x.classList.toggle('on', x === b)); }
      else if (b.dataset.ti) { const i = itens.find((x) => x.id === b.dataset.ti); if (!i) return; i.feito = !i.feito; redesenha(); const { error } = await sb.from('central_tarefa_itens').update({ feito: i.feito }).eq('id', i.id); if (error) { i.feito = !i.feito; redesenha(); falhou('Não consegui salvar a subtarefa.'); } }
      else if (b.dataset.tdel) { const k = itens.findIndex((x) => x.id === b.dataset.tdel); if (k < 0) return; const [i] = itens.splice(k, 1); redesenha(); const { error } = await sb.from('central_tarefa_itens').delete().eq('id', i.id); if (error) { itens.splice(k, 0, i); redesenha(); falhou('Não consegui remover a subtarefa.'); } }
    });
    const ap = d.querySelector('#td-apaga');
    if (ap) ap.addEventListener('click', async () => {
      if (!ap.dataset.certo) { ap.dataset.certo = '1'; ap.textContent = 'Confirmar: apagar de vez'; setTimeout(() => { if (ap.isConnected) { delete ap.dataset.certo; ap.textContent = 'Apagar tarefa'; } }, 4000); return; }
      ap.disabled = true; sujo.clear();
      const { error } = await sb.from('central_tarefas').delete().eq('id', id);
      if (error) { ap.disabled = false; falhou('Não consegui apagar a tarefa.'); return; }
      aoApagar(t); d.close();
    });
    if (pode) {
      const bMais = botaoAcao(d.querySelector('#td-mais'), { ok: 'Adicionado', carregando: 'Adicionando…' }), bSalvar = botaoAcao(d.querySelector('#td-salvar'), { ok: 'Salvo', carregando: 'Salvando…' });
      d.querySelector('#td-mais').addEventListener('click', () => { if (d.querySelector('#td-n').value.trim()) bMais.rodar(adiciona); });
      d.querySelector('#td-n').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (ev.target.value.trim()) bMais.rodar(adiciona); } });
      d.querySelector('#td-f').addEventListener('submit', (ev) => {
        ev.preventDefault();
        bSalvar.rodar(async () => { const a = await adiciona(), b = await envia(); if (!b) falhou('Não consegui salvar a tarefa. Tente de novo.'); return a && b; });
      });
      d.addEventListener('close', async () => { const feito = await envia(); if (!feito) falhou('Não consegui salvar a tarefa. Tente de novo.'); }, { once: true });
    }
}
