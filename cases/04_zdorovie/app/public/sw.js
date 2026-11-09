// Сервис-воркер «Тонуса» нужен только для уведомлений. Файлы не кэшируем: данные о здоровье всегда свежие с сервера.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Тонус', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { link: data.link || '#/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const link = String(e.notification.data?.link || '#/');
  const target = '/' + (link.startsWith('#/') ? link : '#/');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list[0];
    if (open) return open.navigate(target).then(c => c?.focus());
    return self.clients.openWindow(target);
  }));
});
