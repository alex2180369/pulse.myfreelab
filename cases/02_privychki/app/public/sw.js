// Сервис-воркер «Серии». При изменении состава файлов увеличивайте версию.
const CACHE = 'seriya-v1';
const FILES = [
  '/', '/app.js', '/store.js', '/stats.js', '/style.css', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest',
  '/shared/ui.js', '/shared/base.css', '/shared/fonts/manrope-cyrillic-wght-normal.woff2', '/shared/fonts/manrope-latin-wght-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Файлы отдаём из кэша сразу и обновляем в фоне. Данные живут в IndexedDB, API сюда не попадает.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = e.request.mode === 'navigate' ? '/' : e.request;
    const cached = await cache.match(key);
    const fresh = fetch(e.request).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    if (cached) { fresh.catch(() => {}); return cached; }
    return fresh;
  }));
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(data.title || 'Серия', {
    body: data.body || '', icon: '/icon-192.png', tag: `habit-${data.habitId || 0}`, data: { habitId: data.habitId },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.habitId ? `/#/habit/${e.notification.data.habitId}` : '/#/today';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list[0];
    if (open) return open.navigate(target).then(c => c?.focus());
    return self.clients.openWindow(target);
  }));
});
