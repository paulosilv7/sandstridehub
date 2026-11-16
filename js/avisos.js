// Avisos no aparelho (Web Push): ligar/desligar neste aparelho e escolher quais avisos receber.
export const TIPOS = [
  ['tarefas', 'Tarefas', 'Quando uma tarefa for passada para você ou alguém alterar a sua.'],
  ['resumo', 'Resumo da manhã', 'Às 8h: o que vence hoje e o que está atrasado.'],
  ['chats', 'Chats', 'Quando a Sandy não resolve e um cliente espera uma pessoa.'],
  ['devolucoes', 'Devoluções vencendo', 'No resumo da manhã: devoluções que vencem hoje.'],
  ['metas', 'Meta batida', 'Quando a meta do mês ou a meta de lucro do dia é alcançada.'],
];

const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function suporte() {
  if (ios() && !instalado()) return { ok: false, motivo: 'ios-instalar' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, motivo: 'sem-suporte' };
  return { ok: true };
}
export async function registrarSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch (_) { return null; }
}
export async function inscricaoAtual() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? reg.pushManager.getSubscription() : null;
}
export async function ativar(sb, user) {
  if (Notification.permission === 'denied') throw new Error('negado');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('negado');
  const reg = (await registrarSW()) && (await navigator.serviceWorker.ready);
  const { data: pub, error } = await sb.rpc('push_chave_publica');
  if (error || !pub) throw new Error('chave');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(pub) });
  const j = sub.toJSON();
  const { error: e2 } = await sb.from('push_inscricoes').upsert({ usuario_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, agente: navigator.userAgent.slice(0, 200) }, { onConflict: 'endpoint' });
  if (e2) throw new Error('salvar');
}
export async function desativar(sb) {
  const sub = await inscricaoAtual(); if (!sub) return;
  const ep = sub.endpoint; await sub.unsubscribe();
  await sb.from('push_inscricoes').delete().eq('endpoint', ep);
}
export async function lerPrefs(sb, user) {
  const { data } = await sb.from('push_preferencias').select('*').eq('usuario_id', user.id).maybeSingle();
  return Object.fromEntries(TIPOS.map(([k]) => [k, data ? data[k] !== false : true]));
}
export async function salvarPref(sb, user, campo, valor) {
  const atual = await lerPrefs(sb, user);
  const { error } = await sb.from('push_preferencias').upsert({ usuario_id: user.id, ...atual, [campo]: valor, atualizado_em: new Date().toISOString() }, { onConflict: 'usuario_id' });
  return !error;
}
