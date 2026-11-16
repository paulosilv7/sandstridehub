// Escolha de responsáveis de uma tarefa: uma ou várias pessoas, ou "Todos" (que desmarca as individuais).
// estado = { sel: Set de ids, todos: boolean }. Sempre sobra ao menos uma escolha.
export const novoEstado = (euId) => ({ sel: new Set([euId]), todos: false });

export function chipsResp(equipe, euId, est, prim, esc) {
  const chip = (v, rot, on) => `<button type="button" class="rs-chip${on ? ' on' : ''}" data-rp="${v}" aria-pressed="${on}">${esc(rot)}</button>`;
  return `<div class="rs-chips" role="group" aria-label="Responsáveis">` +
    equipe.map((p) => chip(p.usuario_id, p.usuario_id === euId ? 'Para mim' : prim(p.nome), !est.todos && est.sel.has(p.usuario_id))).join('') +
    chip('todos', 'Todos', est.todos) + '</div>';
}

export function alternaResp(est, v, euId) {
  if (v === 'todos') { est.todos = !est.todos; if (est.todos) est.sel.clear(); }
  else { est.todos = false; if (est.sel.has(v)) est.sel.delete(v); else est.sel.add(v); }
  if (!est.todos && !est.sel.size) est.sel.add(euId);
}

export const donosDe = (est, equipe) => (est.todos ? equipe.map((p) => p.usuario_id) : [...est.sel]);
