// Service worker do Sandstride: recebe os avisos (Web Push) e abre a tela certa ao tocar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));

self.addEventListener('push', (ev) => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (_) { d = { titulo: 'Sandstride', corpo: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil(self.registration.showNotification(d.titulo || 'Sandstride', {
    body: d.corpo || '', icon: '/favicon-192.png', badge: '/favicon-192.png', tag: d.tag || undefined, renotify: !!d.tag,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const alvo = new URL(ev.notification.data?.url || '/', self.location.origin).href;
  ev.waitUntil((async () => {
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const a of abas) {
      if (new URL(a.url).origin === self.location.origin && 'focus' in a) { await a.focus(); if ('navigate' in a) { try { await a.navigate(alvo); } catch (_) { /* ignora */ } } return; }
    }
    await self.clients.openWindow(alvo);
  })());
});
